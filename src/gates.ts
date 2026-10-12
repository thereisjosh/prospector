/**
 * The deterministic lead gates: one source of truth shared by the batch
 * workflow (src/score.ts) and the agent harness (submit_lead). Everything in
 * here is pure and synchronous: no network, no clock reads (callers pass `now`).
 */
import { nameMatchesSignal, normalizeName } from "./eval";
import { textInCountries } from "./geo";
import { normalizeNullish, normalizeSignalDate, type SearchPlan } from "./plan";
import type { CompanySummary, SignalSummary } from "./types";

export type GateCode =
  | "stale_date"
  | "unparseable_date"
  | `required_gate:${string}`
  | "size"
  | "unknown_size"
  | "hq"
  | "enterprise"
  | "exclude_name"
  | "exclude_domain"
  | "non_company"
  | "entity_mismatch"
  | "no_enrichment"
  | "already_seen"
  | "duplicate";

export type LeadSignal = {
  url: string;
  title?: string;
  text?: string;
  summary: SignalSummary;
  publishedDate?: string;
};

export type LeadInput = {
  company: string;
  signal: LeadSignal;
  /** Result of a company lookup for this company (undefined = not looked up). */
  enrichment?: CompanySummary;
  /** URL of the page the lookup resolved to; used for exclude-domain / job-board checks. */
  companyUrl?: string;
  now: Date;
  /** Squashed keys (see squashName) of companies from earlier runs -> `already_seen`. */
  seen?: Set<string>;
  /** Squashed keys of companies already accepted in this run -> `duplicate`. */
  submitted?: Set<string>;
};

export type LeadDetails = {
  /** squashName(company): the key callers should add to seen/submitted. */
  key: string;
  event_date: string;
  date_source: "signal" | "published_fallback";
  /** Employee estimate used; undefined when unknown or unverified. */
  employees?: number;
  size_basis: "quoted" | "unverified";
  required_gates_passed: string[];
  optional_gates_passed: string[];
  hq: string;
  /** Confidence multiplier from fit (size known? optional gates). */
  multiplier: number;
  fit_reason: string;
};

export type LeadVerdict =
  | { ok: true; details: LeadDetails }
  | { ok: false; code: GateCode; reason: string };

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const CORPORATE_SUFFIXES = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "group",
]);

/**
 * Dedupe key for a company name: lowercase, accents stripped, trailing
 * corporate suffixes (inc/llc/ltd/corp/co/group...) dropped, then all
 * non-alphanumerics removed. "Diakon Logistics" == "Diakonlogistics".
 */
export function squashName(name: string): string {
  const tokens = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join("");
}

export function nameTokens(name: string): string[] {
  return normalizeName(name).split(" ").filter(Boolean);
}

/**
 * Fuzzy denylist match on normalised tokens: the whole name, or its leading
 * token(s), equals a denylisted name ("RXO (formerly XPO Logistics)" and
 * "RXO CORPORATE SOLUTIONS, LLC" vs "RXO"), or the strings are equal with all
 * spaces/punctuation stripped ("Chrobinson" vs "C.H. Robinson").
 */
export function nameExcluded(company: string, excluded: string[][]): boolean {
  const tokens = nameTokens(company);
  if (tokens.length === 0) return false;
  const squashed = tokens.join("");
  return excluded.some(
    (ex) =>
      ex.join("") === squashed ||
      (ex.length <= tokens.length && ex.every((t, i) => tokens[i] === t)),
  );
}

// Generic non-company filter (not ICP-specific): staffing agencies and job
// boards that show up as the "company" on hiring posts, plus placeholder
// names the summariser emits when it finds no real company.
const NON_COMPANY_NAME_PATTERNS: RegExp[] = [
  /\bihire/,
  /jobline/,
  /\bjobrapido\b/,
  /\bindeed\b/,
  /\bziprecruiter\b/,
  /\bglassdoor\b/,
  /\blinkedin\b/,
  /\bremote rush\b/,
  /\bpeople group\b/,
];
const PLACEHOLDER_NAMES = new Set([
  "", "unknown", "na", "none", "null", "role", "final mile", "last mile",
  "company", "employer", "confidential", "undisclosed", "various", "multiple",
]);
// Job-board / staffing domains, checked against a company's own lookup domain.
const NON_COMPANY_DOMAIN_PATTERNS: RegExp[] = [
  /(^|\.)ihirelogistics\.com$/,
  /jobline/,
  /(^|\.)jobrapido\./,
  /(^|\.)indeed\./,
  /(^|\.)ziprecruiter\./,
  /(^|\.)glassdoor\./,
  /(^|\.)linkedin\.com$/,
];

export function isNonCompanyName(name: string): boolean {
  const n = normalizeName(name);
  return PLACEHOLDER_NAMES.has(n) || NON_COMPANY_NAME_PATTERNS.some((p) => p.test(n));
}

export function safeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function isNonCompanyDomain(url: string): boolean {
  const d = safeDomain(url);
  return !!d && NON_COMPANY_DOMAIN_PATTERNS.some((p) => p.test(d));
}

export function domainExcluded(url: string, excluded: readonly string[]): boolean {
  const domain = safeDomain(url);
  if (!domain) return false;
  return excluded.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function addMonthsMs(iso: string, months: number): number {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/** Start of the recency window: `months` before the UTC date of `now`. */
export function windowStartIso(months: number, now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/**
 * Resolve the EVENT date. Exa summaries sometimes hallucinate the year, so
 * signal_date is trusted only if it falls within publishedDate minus 12 months
 * to plus 7 days (and not after now + 1 day). Otherwise publishedDate is used
 * and date_source is "published_fallback". With no publishedDate, an
 * implausible signal_date (future, or > 24 months before now) is unparseable.
 */
export function resolveEventDate(
  signal: { signal_date?: string; publishedDate?: string },
  now: Date,
): { date: string; source: "signal" | "published_fallback" | "" } {
  const sig = normalizeSignalDate(signal.signal_date);
  const pub = normalizeSignalDate(signal.publishedDate);
  const sigMs = sig ? Date.parse(`${sig}T00:00:00.000Z`) : undefined;
  const notFuture = sigMs !== undefined && sigMs <= now.getTime() + DAY_MS;

  if (pub) {
    const pubMs = Date.parse(`${pub}T00:00:00.000Z`);
    const plausible =
      sigMs !== undefined &&
      notFuture &&
      sigMs >= addMonthsMs(pub, -12) &&
      sigMs <= pubMs + 7 * DAY_MS;
    return plausible ? { date: sig!, source: "signal" } : { date: pub, source: "published_fallback" };
  }
  if (sig && notFuture && sigMs! >= addMonthsMs(now.toISOString().slice(0, 10), -24)) {
    return { date: sig, source: "signal" };
  }
  return { date: "", source: "" };
}

export function freshnessScore(value: string, startIso: string, now: Date): number {
  const signal = new Date(value).getTime();
  const start = new Date(startIso).getTime();
  const end = now.getTime();
  if (!Number.isFinite(signal) || signal < start || signal > end) return 0;
  return Math.max(0, Math.min(1, (signal - start) / (end - start)));
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

export function parseEmployeeEstimate(value: CompanySummary["employee_estimate"]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.toLowerCase().replace(/,/g, "");
  const range = normalized.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range?.[1] && range[2]) {
    return Math.round((Number(range[1]) + Number(range[2])) / 2);
  }

  const plus = normalized.match(/(\d+)\s*\+/);
  if (plus?.[1]) return Number(plus[1]);

  const number = normalized.match(/\d+/);
  return number ? Number(number[0]) : undefined;
}

const HEADCOUNT_WORD = /^\s*(?:\S+\s+){0,2}?(?:employees|staff|people|headcount|team\s+members)\b/i;

/**
 * All numbers in a quote: "3,560", "350+", "~350", "1.2k", "200-500". Bare
 * 4-digit numbers in 1900-2099 look like years ("founded 2004"), so they are
 * ignored unless a headcount word follows within two words.
 */
function numbersIn(quote: string): number[] {
  const out: number[] = [];
  for (const m of quote.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g)) {
    const raw = m[1]!.replace(/,+$/, "");
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const yearLike = /^(19|20)\d\d$/.test(raw) && !m[2];
    if (yearLike && !HEADCOUNT_WORD.test(quote.slice(m.index! + m[0].length))) continue;
    out.push(m[2] ? n * 1000 : n);
  }
  return out;
}

/**
 * Does the quoted source phrase back the employee estimate? True if any number
 * in the quote is within +/-25% of the estimate, or the estimate lies inside a
 * quoted range ("200-500 employees"). Empty or number-free quotes never do.
 */
export function sizeQuoteSupports(estimate: number, quote: string | undefined): boolean {
  if (!quote) return false;
  const nums = numbersIn(quote);
  if (nums.some((n) => Math.abs(n - estimate) <= 0.25 * estimate)) return true;
  return nums.length >= 2 && estimate >= Math.min(...nums) && estimate <= Math.max(...nums);
}

// ---------------------------------------------------------------------------
// Staged checks (the pre-enrichment ones are reused by score.ts before selection)
// ---------------------------------------------------------------------------

type Fail = { ok: false; code: GateCode; reason: string };
const fail = (code: GateCode, reason: string): Fail => ({ ok: false, code, reason });

/** Name / domain checks that need no lookup. */
export function checkIdentity(
  plan: SearchPlan,
  company: string,
  signalUrl: string,
  companyUrl?: string,
): Fail | undefined {
  if (isNonCompanyName(company)) {
    return fail("non_company", "placeholder, staffing or job-board name");
  }
  const excluded = plan.excludeNames.map(nameTokens).filter((t) => t.length > 0);
  if (nameExcluded(company, excluded)) {
    return fail("exclude_name", "company is on the plan's exclusion list");
  }
  if (domainExcluded(signalUrl, plan.excludeDomains)) {
    return fail("exclude_domain", "signal source domain is excluded");
  }
  if (companyUrl) {
    if (domainExcluded(companyUrl, plan.excludeDomains)) {
      return fail("exclude_domain", "company domain is excluded");
    }
    if (isNonCompanyDomain(companyUrl)) {
      return fail("non_company", "lookup resolved to a job-board/staffing domain");
    }
  }
  return undefined;
}

/** Event-date check against the plan window. */
export function checkDate(
  plan: SearchPlan,
  signal: { signal_date?: string; publishedDate?: string },
  now: Date,
):
  | { ok: true; date: string; source: "signal" | "published_fallback" }
  | Fail {
  const resolved = resolveEventDate(signal, now);
  if (!resolved.date || !resolved.source) {
    return fail(
      "unparseable_date",
      `no plausible event date (signal_date "${signal.signal_date ?? ""}", published ${signal.publishedDate ?? "n/a"})`,
    );
  }
  const start = windowStartIso(plan.months, now);
  if (freshnessScore(resolved.date, start, now) <= 0) {
    return fail(
      "stale_date",
      `event date ${resolved.date} is outside the ${plan.months}-month window starting ${start.slice(0, 10)}`,
    );
  }
  return { ok: true, date: resolved.date, source: resolved.source };
}

function entityMatches(company: string, haystack: string): boolean {
  if (nameMatchesSignal({ company, text: haystack })) return true;
  // "Diakonlogistics" vs a page that says "Diakon Logistics": compare squashed,
  // but only for names long enough that a substring match is meaningful.
  const key = squashName(company);
  if (key.length < 6) return false;
  return haystack.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").includes(key);
}

/**
 * Run every deterministic gate for one lead. Pure: it never mutates `seen` or
 * `submitted`; on `ok`, callers add `details.key` themselves.
 */
export function checkLead(plan: SearchPlan, input: LeadInput): LeadVerdict {
  const { company, signal, enrichment, now } = input;
  const key = squashName(company);

  const identity = checkIdentity(plan, company, signal.url, input.companyUrl);
  if (identity) return identity;

  if (input.seen?.has(key)) return fail("already_seen", "company was delivered or rejected in an earlier run");
  if (input.submitted?.has(key)) return fail("duplicate", "company was already accepted in this run");

  const date = checkDate(
    plan,
    { signal_date: signal.summary.signal_date, publishedDate: signal.publishedDate },
    now,
  );
  if (!date.ok) return date;

  const haystack = [signal.title, signal.text, signal.summary.signal_summary].filter(Boolean).join(" ");
  if (!entityMatches(company, haystack)) {
    return fail("entity_mismatch", `"${company}" does not appear in the signal page`);
  }

  if (!enrichment || Object.keys(enrichment).length === 0) {
    return fail("no_enrichment", "no company lookup available to verify the fit gates");
  }
  if (enrichment.is_public_or_enterprise === true) {
    return fail("enterprise", "company appears public/enterprise scale");
  }

  const hq = typeof enrichment.hq === "string" ? normalizeNullish(enrichment.hq) ?? "" : "";
  if (
    !textInCountries(hq, plan.hqCountries, true) &&
    !textInCountries(`${haystack}`, plan.hqCountries, false)
  ) {
    return fail("hq", `HQ "${hq || "unknown"}" is outside ${plan.hqCountries.join("/")}`);
  }

  // Size: the estimate counts only if its quoted source backs it up.
  const claimed = parseEmployeeEstimate(enrichment.employee_estimate);
  const quote =
    typeof enrichment.employee_estimate_source === "string"
      ? enrichment.employee_estimate_source
      : undefined;
  const quoted = claimed !== undefined && sizeQuoteSupports(claimed, quote);
  const employees = quoted ? claimed : undefined;
  const { min, max, unknownPolicy } = plan.employeeRange;
  if (employees === undefined) {
    if (unknownPolicy === "reject") {
      return fail(
        "unknown_size",
        claimed === undefined
          ? "employee estimate unknown"
          : `employee estimate ${claimed.toLocaleString()} is not backed by its source quote`,
      );
    }
  } else if (employees < min || employees > max) {
    return fail(
      "size",
      `employee estimate ${employees.toLocaleString()} is outside the approximate ${min}-${max} target`,
    );
  }
  // An unverified estimate is weaker evidence, not none: it can still rule a
  // company out if it is far outside the band (below min/2 or above 1.5x max).
  if (!quoted && claimed !== undefined && (claimed < min / 2 || claimed > max * 1.5)) {
    return fail(
      "size",
      `unverified estimate ${claimed.toLocaleString()} is far outside ${min}\u2013${max}`,
    );
  }

  const required = plan.gateFields.filter((g) => g.required);
  const optional = plan.gateFields.filter((g) => !g.required);
  const failed = required.filter((g) => enrichment[g.key] !== true);
  if (failed.length > 0) {
    return fail(
      `required_gate:${failed[0]!.key}`,
      `required gate(s) not satisfied: ${failed.map((g) => g.key).join(", ")}`,
    );
  }

  const optionalPassed = optional.filter((g) => enrichment[g.key] === true).map((g) => g.key);
  const optionalFrac = optional.length > 0 ? optionalPassed.length / optional.length : 1;
  const multiplier = (employees === undefined ? 0.82 : 1) * (0.9 + 0.1 * optionalFrac);

  const parts = [
    required.length > 0
      ? `required gates passed: ${required.map((g) => g.key).join(", ")}`
      : "no required gates",
  ];
  if (optional.length > 0) {
    parts.push(
      optionalPassed.length > 0
        ? `optional gates passed: ${optionalPassed.join(", ")}`
        : "no optional gates passed",
    );
  }
  parts.push(
    employees !== undefined
      ? `${employees.toLocaleString()} estimated employees (quoted)`
      : claimed !== undefined
        ? `employee count ${claimed.toLocaleString()} unverified by its source`
        : "employee count not exposed by lookup",
  );
  parts.push(`HQ ${hq || "inferred from signal text"}`);

  return {
    ok: true,
    details: {
      key,
      event_date: date.date,
      date_source: date.source,
      ...(employees !== undefined ? { employees } : {}),
      size_basis: quoted ? "quoted" : "unverified",
      required_gates_passed: required.map((g) => g.key),
      optional_gates_passed: optionalPassed,
      hq,
      multiplier,
      fit_reason: `${parts.join("; ")}.`,
    },
  };
}
