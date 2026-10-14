import { normalizeName } from "./eval";
import type { CompanySummary } from "./types";

/**
 * The evidence the deterministic gate (src/gates.ts `checkLead`) had when it accepted a lead,
 * in the bounded shape the lead judge sees (src/agent/judge-input.ts `JudgePayload.evidence`).
 * One builder for every producer (agent submit path, workflow scoring, calibration rebuild),
 * so the judge reads the same fields whichever arm found the lead.
 */

/** Max chars of signal page text the judge sees. */
export const EXCERPT_MAX = 1500;
/** Max chars of the lookup's company description. */
export const DESCRIPTION_MAX = 600;
const TITLE_MAX = 300;
const SHORT_MAX = 200;
const QUOTE_MAX = 300;
/** Context kept before the company mention, so a dateline or headline lead-in survives. */
const LEAD_IN = 300;
const MAX_MENTIONS = 5;

/** The signal part, persisted on the accepted lead at accept time (`AcceptedLead.evidence`). */
export type SignalEvidence = {
  signal_title: string;
  /** Exa's publishedDate as returned ("" when Exa gave none). */
  signal_published_date: string;
  /** ≤ EXCERPT_MAX chars of the page text the gate checked (see `signalExcerpt`). */
  signal_excerpt: string;
};

export type JudgeCompanyLookup = {
  description: string;
  industry: string;
  hq: string;
  employee_estimate: number | string | null;
  /** The quoted phrase the estimate came from ("" = none). */
  employee_estimate_source: string;
  is_public_or_enterprise: boolean | null;
  /** The plan's gate-field booleans the lookup returned (e.g. is_third_party_logistics), keys sorted. */
  gate_fields: Record<string, boolean>;
};

export type JudgeGateResult = {
  /** Gate codes `checkLead` evaluated without rejecting (ACCEPTED_LEAD_CHECKS + one required_gate:<key> per required gate). */
  checks_passed: string[];
  date_source: string | null;
  /** Employee count the gate used: only a quote-backed estimate (null = unknown or unverified). */
  employees: number | null;
  hq: string | null;
  hq_basis: string | null;
  required_gates_passed: string[];
  optional_gates_passed: string[] | null;
};

export type JudgeEvidence = SignalEvidence & {
  company_lookup: JudgeCompanyLookup | null;
  gate_result: JudgeGateResult | null;
};

/**
 * Gate codes `checkLead` runs on every lead, in order, that are about the lead itself
 * (`already_seen` / `duplicate` are run-history checks that only the agent applies, so listing
 * them would identify the arm). A lead that was accepted passed all of these.
 * Keep in sync with src/gates.ts `checkLead` (eval/judge-evidence.test.ts checks they are GateCodes).
 */
export const ACCEPTED_LEAD_CHECKS = [
  "non_company",
  "exclude_name",
  "exclude_domain",
  "unparseable_date",
  "stale_date",
  "entity_mismatch",
  "no_enrichment",
  "enterprise",
  "hq",
  "unknown_size",
  "size",
] as const;

export const EMPTY_SIGNAL_EVIDENCE: SignalEvidence = { signal_title: "", signal_published_date: "", signal_excerpt: "" };

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const str = (value: unknown, max: number) => (typeof value === "string" ? clip(value.replace(/\s+/g, " ").trim(), max) : "");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Raw-text offsets of the company's mentions, with the gate's own matching rule
 * (src/eval.ts `nameMatchesSignal`): word-boundary match on the normalised name tokens
 * ("&" ≡ "and", suffixes like Inc/LLC ignored), else, for names of 8+ chars, the squashed
 * name inside the text with all non-alphanumerics removed ("Diakonlogistics").
 */
export function mentionOffsets(company: string, text: string, max = MAX_MENTIONS): number[] {
  const tokens = normalizeName(company).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const pattern = tokens.map((t) => (t === "and" ? "(?:and|&)" : escapeRegExp(t))).join("[^a-z0-9]+");
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, "gi"))) {
    out.push(m.index!);
    if (out.length >= max) return out;
  }
  if (out.length > 0) return out;
  const squashed = tokens.join("");
  if (squashed.length < 8) return [];
  // Alphanumeric stream of the text ("&" → "and"), each char mapped back to its raw offset.
  let stream = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!.toLowerCase();
    if (/[a-z0-9]/.test(ch)) {
      stream += ch;
      at.push(i);
    } else if (ch === "&") {
      stream += "and";
      at.push(i, i, i);
    }
  }
  for (let from = 0; out.length < max; ) {
    const hit = stream.indexOf(squashed, from);
    if (hit < 0) break;
    out.push(at[hit]!);
    from = hit + squashed.length;
  }
  return out;
}

const STOPWORDS = new Set(["about", "after", "their", "there", "which", "would", "could", "these", "those", "while", "where", "other", "company", "companies", "recent", "recently", "announced", "including"]);

/** Content words of the why-now claim (5+ letters, not the company's own name tokens). */
function eventWords(hint: string, company: string): string[] {
  const own = new Set(normalizeName(company).split(" "));
  const words = (hint.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w) && !own.has(w));
  return [...new Set(words)];
}

/**
 * ≤ EXCERPT_MAX chars of the signal page text, chosen for relevance:
 *  1. whitespace is collapsed; a text that already fits is returned whole;
 *  2. otherwise the window is anchored on a mention of the company (the same match the gate's
 *     entity check makes), starting LEAD_IN chars before it so the headline or dateline stays;
 *  3. among the first MAX_MENTIONS mentions it picks the window containing the most distinct
 *     content words of the event claim (`hint`, the lead's why_now), so the excerpt shows the
 *     company AND the event; ties go to the earliest mention;
 *  4. with no mention, the start of the text.
 * Cut ends are marked with "…" (counted in the limit).
 */
export function signalExcerpt(text: string | undefined, company: string, hint = "", max = EXCERPT_MAX): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const room = max - 2; // two possible "…" markers
  const mentions = mentionOffsets(company, flat);
  const words = eventWords(hint, company);
  let start = 0;
  if (mentions.length > 0) {
    let best = -1;
    for (const m of mentions) {
      const s = Math.max(0, Math.min(m - LEAD_IN, flat.length - room));
      const window = flat.slice(s, s + room).toLowerCase();
      const score = words.filter((w) => window.includes(w)).length;
      if (score > best) {
        best = score;
        start = s;
      }
    }
  }
  // Snap to word boundaries so the excerpt does not open or close mid-word.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space - start < 40) start = space + 1;
  }
  let end = Math.min(flat.length, start + room);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start && end - space < 40) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** The signal part of the evidence, from what the gate checked: title, Exa date, the page text. */
export function signalEvidence(signal: { title?: string; publishedDate?: string; text?: string }, company: string, whyNow = ""): SignalEvidence {
  return {
    signal_title: str(signal.title, TITLE_MAX),
    signal_published_date: str(signal.publishedDate, 40),
    signal_excerpt: signalExcerpt(signal.text, company, whyNow),
  };
}

const LOOKUP_KEYS = new Set(["description", "industry", "employee_estimate", "employee_estimate_source", "is_public_or_enterprise", "hq", "company_name"]);

/** The company lookup as the gate read it (CompanySummary), bounded. null = no lookup. */
export function companyLookupEvidence(enrichment: CompanySummary | undefined): JudgeCompanyLookup | null {
  if (!enrichment || typeof enrichment !== "object" || Object.keys(enrichment).length === 0) return null;
  const estimate = enrichment.employee_estimate;
  const gateFields: Record<string, boolean> = {};
  for (const key of Object.keys(enrichment).sort()) {
    if (!LOOKUP_KEYS.has(key) && typeof enrichment[key] === "boolean") gateFields[key] = enrichment[key] as boolean;
  }
  return {
    description: str(enrichment.description, DESCRIPTION_MAX),
    industry: str(enrichment.industry, SHORT_MAX),
    hq: str(enrichment.hq, SHORT_MAX),
    employee_estimate: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : typeof estimate === "string" && estimate.trim() ? str(estimate, 60) : null,
    employee_estimate_source: str(enrichment.employee_estimate_source, QUOTE_MAX),
    is_public_or_enterprise: typeof enrichment.is_public_or_enterprise === "boolean" ? enrichment.is_public_or_enterprise : null,
    gate_fields: gateFields,
  };
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null);

/** What `checkLead` decided for an accepted lead (its `details`), without the arm-specific fit sentence or score multiplier. null = no details. */
export function gateResultEvidence(details: Record<string, unknown> | undefined): JudgeGateResult | null {
  if (!details || typeof details !== "object" || Object.keys(details).length === 0) return null;
  const required = strings(details.required_gates_passed) ?? [];
  return {
    checks_passed: [...ACCEPTED_LEAD_CHECKS, ...required.map((k) => `required_gate:${k}`)],
    date_source: typeof details.date_source === "string" ? details.date_source : null,
    employees: typeof details.employees === "number" && Number.isFinite(details.employees) ? details.employees : null,
    hq: typeof details.hq === "string" ? str(details.hq, SHORT_MAX) : null,
    hq_basis: typeof details.hq_basis === "string" ? details.hq_basis : null,
    required_gates_passed: required,
    optional_gates_passed: strings(details.optional_gates_passed),
  };
}

/** The full evidence object. Missing parts stay empty ("" / null), never invented. */
export function judgeEvidence(parts: { signal?: Partial<SignalEvidence>; enrichment?: CompanySummary; details?: Record<string, unknown> }): JudgeEvidence {
  const s = parts.signal ?? {};
  return {
    signal_title: str(s.signal_title, TITLE_MAX),
    signal_published_date: str(s.signal_published_date, 40),
    signal_excerpt: typeof s.signal_excerpt === "string" ? clip(s.signal_excerpt, EXCERPT_MAX) : "",
    company_lookup: companyLookupEvidence(parts.enrichment),
    gate_result: gateResultEvidence(parts.details),
  };
}

export function emptyJudgeEvidence(): JudgeEvidence {
  return { ...EMPTY_SIGNAL_EVIDENCE, company_lookup: null, gate_result: null };
}
