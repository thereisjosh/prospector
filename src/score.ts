import { nameMatchesSignal, netNew, normalizeName } from "./eval";
import { textInCountries } from "./geo";
import {
  normalizeNullish,
  normalizeSignalDate,
  OTHER_SIGNAL_TYPE,
  PRESCREEN_PREFIX,
  type SearchPlan,
} from "./plan";
import type {
  CompanySummary,
  ExaResult,
  ProspectRow,
  SignalSummary,
} from "./types";

export type Candidate = {
  result: ExaResult;
  summary: SignalSummary;
  company?: CompanyEnrichment;
};

export type CompanyEnrichment = {
  result?: ExaResult;
  summary: CompanySummary;
};

export type Rejection = { company: string; reason: string; signal_url: string };

export type Funnel = {
  rawSignalResults: number;
  withCompanyName: number;
  afterDedupeByCompany: number;
  droppedStaleOrUnparseableDate: number;
  selectedForEnrichment: number;
  cutByEnrichmentLimit: number;
  enrichmentNoResult: number;
  /** Company lookups missing from a lenient replay (eval script only). */
  replayMiss: number;
  /** Where the cost budget stopped the run, e.g. "signal_search:7" or "enrichment:12"; null if it never did. */
  budgetStoppedAt: string | null;
  spentDollars: number;
  /** Rejection counts keyed by reason: excludeDomains, excludeNames, no_enrichment,
   * enterprise, hq, unknown_size, size, required_gate:<key>, weak_why_now. */
  rejections: Record<string, number>;
  /** Not a rejection: confidence penalty applied when the company is absent from its own signal text. */
  entityMismatchPenalised: number;
  finalRows: number;
};

export type Trace = { funnel: Funnel; rejected: Rejection[] };

export function createTrace(): Trace {
  return {
    funnel: {
      rawSignalResults: 0,
      withCompanyName: 0,
      afterDedupeByCompany: 0,
      droppedStaleOrUnparseableDate: 0,
      selectedForEnrichment: 0,
      cutByEnrichmentLimit: 0,
      enrichmentNoResult: 0,
      replayMiss: 0,
      budgetStoppedAt: null,
      spentDollars: 0,
      rejections: {},
      entityMismatchPenalised: 0,
      finalRows: 0,
    },
    rejected: [],
  };
}

function reject(trace: Trace | undefined, codes: string[], company: string, url: string, detail: string) {
  if (!trace) return;
  for (const code of codes) {
    trace.funnel.rejections[code] = (trace.funnel.rejections[code] ?? 0) + 1;
  }
  trace.rejected.push({ company, reason: detail, signal_url: url });
}

/**
 * Generic, plan-independent wording cues. Used ONLY as a tie-breaker between
 * candidates of the same signal_type; the plan's signalTypes order is what
 * decides signal strength.
 */
const TIE_BREAK_WEIGHTS: Array<[RegExp, number]> = [
  [/\b(funding|funded|series [abc]|raises?|raised|investment)\b/i, 0.95],
  [/\b(opening|opened|new|launch(?:ed)?|announced)\b/i, 0.9],
  [/\b(first|founding)\b/i, 0.85],
  [/\b(hiring wave|multiple roles|expanding|expansion|scal(?:e|ing))\b/i, 0.8],
  [/\b(hiring|hires?|appointed|joins?)\b/i, 0.6],
];

const TIE_BREAK_SHARE = 0.04;

export function parseSignalSummary(
  summary: ExaResult["summary"],
  fallback: ExaResult,
): SignalSummary {
  const build = (raw: Record<string, unknown>): SignalSummary => {
    const str = (v: unknown) => (typeof v === "string" ? normalizeNullish(v) : undefined);
    const prescreen: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const val = typeof v === "string" ? normalizeNullish(v)?.toLowerCase() : undefined;
      if (k.startsWith(PRESCREEN_PREFIX) && val) prescreen[k.slice(PRESCREEN_PREFIX.length)] = val;
    }
    const scale = str(raw.company_scale_guess)?.toLowerCase();
    return {
      company_name: str(raw.company_name) ?? extractCompanyName(fallback),
      signal_type: str(raw.signal_type) ?? OTHER_SIGNAL_TYPE,
      signal_summary: str(raw.signal_summary) ?? fallback.title ?? "",
      signal_date: str(raw.signal_date) ?? "",
      ...(scale ? { company_scale_guess: scale } : {}),
      ...(Object.keys(prescreen).length > 0 ? { prescreen } : {}),
    };
  };

  if (
    typeof summary === "object" &&
    summary &&
    ("company_name" in summary || "signal_summary" in summary)
  ) {
    return build(summary as Record<string, unknown>);
  }
  if (typeof summary === "string") {
    const trimmed = summary.trim();
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && (parsed.company_name || parsed.signal_summary)) {
        return build(parsed);
      }
    } catch {
      // Exa may fall back to prose summaries; keep the row and score it lower.
    }
    return build({ signal_summary: normalizeNullish(trimmed) });
  }
  return build({});
}

/**
 * Rank companies for enrichment (best first), before any lookup is paid for.
 * Enterprise-looking companies and any pre-screen "no" go to the back of the
 * queue (not dropped); within each tier: signal strength + freshness.
 */
export function rankCompaniesForEnrichment(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
): string[] {
  return aggregateCandidates(plan, candidates, startIso, now)
    .map((group) => ({
      group,
      demoted: prescreenDemoted(group),
      score: preliminaryScore(plan, group, startIso, now),
    }))
    .sort((a, b) => Number(a.demoted) - Number(b.demoted) || b.score - a.score)
    .map(({ group }) => group.company);
}

export function selectCompaniesForEnrichment(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
  limit = 20,
  trace?: Trace,
): string[] {
  const ranked = rankCompaniesForEnrichment(plan, candidates, startIso, now);
  if (trace) trace.funnel.cutByEnrichmentLimit = Math.max(0, ranked.length - limit);
  return ranked.slice(0, limit);
}

function prescreenDemoted(group: CandidateGroup): boolean {
  return group.candidates.some(
    (c) =>
      c.summary.company_scale_guess === "enterprise" ||
      Object.values(c.summary.prescreen ?? {}).includes("no"),
  );
}

export function scoreAndRank(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
  trace?: Trace,
): ProspectRow[] {
  return aggregateCandidates(plan, candidates, startIso, now, trace)
    .map((group) => toRow(plan, group, startIso, now, trace))
    .filter((row): row is ProspectRow => Boolean(row))
    .sort((a, b) => {
      const bScore = b.confidence_score * 0.75 + b.freshness_score * 0.25;
      const aScore = a.confidence_score * 0.75 + a.freshness_score * 0.25;
      return bScore - aScore;
    })
    .slice(0, 15);
}

type CandidateGroup = {
  company: string;
  candidates: Candidate[];
  companyEnrichment?: CompanyEnrichment;
};

const DAY_MS = 86_400_000;

function addMonthsIso(iso: string, months: number): number {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/**
 * Resolve the EVENT date. Exa summaries sometimes hallucinate the year, so
 * signal_date is trusted only if publishedDate - 12 months <= signal_date <=
 * publishedDate + 7 days (and not after now + 1 day). Otherwise publishedDate
 * is used and date_source is "published_fallback". With no publishedDate, an
 * implausible signal_date (future, or > 24 months before now) is unparseable.
 */
export function resolveEventDate(
  candidate: Candidate,
  now: Date,
): { date: string; source: "signal" | "published_fallback" | "" } {
  const sig = normalizeSignalDate(candidate.summary.signal_date);
  const pub = normalizeSignalDate(candidate.result.publishedDate);
  const sigMs = sig ? Date.parse(`${sig}T00:00:00.000Z`) : undefined;
  const notFuture = sigMs !== undefined && sigMs <= now.getTime() + DAY_MS;

  if (pub) {
    const pubMs = Date.parse(`${pub}T00:00:00.000Z`);
    const plausible =
      sigMs !== undefined &&
      notFuture &&
      sigMs >= addMonthsIso(pub, -12) &&
      sigMs <= pubMs + 7 * DAY_MS;
    return plausible ? { date: sig!, source: "signal" } : { date: pub, source: "published_fallback" };
  }
  if (sig && notFuture && sigMs! >= addMonthsIso(now.toISOString().slice(0, 10), -24)) {
    return { date: sig, source: "signal" };
  }
  return { date: "", source: "" };
}

/** The resolved event date (ISO) or "" if unparseable/implausible. */
export function eventDate(candidate: Candidate, now: Date = new Date()): string {
  return resolveEventDate(candidate, now).date;
}

function aggregateCandidates(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now: Date,
  trace?: Trace,
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  const excluded = plan.excludeNames.map(nameTokens).filter((t) => t.length > 0);

  for (const candidate of candidates) {
    const url = candidate.result.url;
    if (isRejectedSourceUrl(url)) continue;
    const company = cleanCompanyName(
      candidate.summary.company_name || extractCompanyName(candidate.result),
    );
    if (domainExcluded(url, plan.excludeDomains)) {
      reject(trace, ["excludeDomains"], company, url, "excludeDomains: signal source domain excluded");
      continue;
    }
    if (!company) continue;

    // Freshness is judged on the event date, not the article's publish date.
    if (freshnessScore(eventDate(candidate, now), startIso, now) <= 0) {
      if (trace) trace.funnel.droppedStaleOrUnparseableDate += 1;
      reject(trace, [], company, url, `stale_or_unparseable_date: "${candidate.summary.signal_date}" / published ${candidate.result.publishedDate ?? "n/a"}`);
      continue;
    }

    const key = normalizeName(company);
    if (!key) continue;
    if (isNonCompanyName(company)) {
      reject(trace, ["non_company"], company, url, "non_company: placeholder, staffing or job-board name");
      continue;
    }
    if (nameExcluded(company, excluded)) {
      reject(trace, ["excludeNames"], company, url, "excludeNames: company on plan denylist");
      continue;
    }

    const group = groups.get(key) ?? { company, candidates: [] };
    group.candidates.push(candidate);
    group.companyEnrichment ??= candidate.company;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const byUrl = new Map<string, Candidate>();
    for (const candidate of group.candidates) {
      const existing = byUrl.get(candidate.result.url);
      if (
        !existing ||
        candidateStrength(plan, candidate) > candidateStrength(plan, existing)
      ) {
        byUrl.set(candidate.result.url, candidate);
      }
    }
    group.candidates = [...byUrl.values()];
  }

  if (trace) trace.funnel.afterDedupeByCompany = groups.size;
  return [...groups.values()];
}

function toRow(
  plan: SearchPlan,
  group: CandidateGroup,
  startIso: string,
  now: Date,
  trace?: Trace,
): ProspectRow | undefined {
  const best = bestCandidate(plan, group.candidates);
  if (!best) return undefined;

  const { result, summary } = best;
  const resolved = resolveEventDate(best, now);
  const signalDate = resolved.date;
  const company = group.company;
  const enrichment = group.companyEnrichment;

  if (
    enrichment?.result &&
    domainExcluded(enrichment.result.url, plan.excludeDomains)
  ) {
    reject(trace, ["excludeDomains"], group.company, best.result.url, "excludeDomains: company domain excluded");
    return undefined;
  }
  if (enrichment?.result && isNonCompanyDomain(enrichment.result.url)) {
    reject(trace, ["non_company"], group.company, best.result.url, "non_company: lookup resolved to a job-board/staffing domain");
    return undefined;
  }

  const groupSourceText = group.candidates
    .map((candidate) =>
      [
        candidate.result.title,
        candidate.result.text,
        candidate.result.highlights?.join(" "),
        candidate.summary.signal_summary,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");

  const fit = evaluateFit(plan, enrichment, groupSourceText);
  if (!fit.keep) {
    reject(trace, fit.codes, company, result.url, fit.reason);
    return undefined;
  }

  const aggregateCount = distinctSignalCount(group.candidates);
  if (isWeakWhyNow(summary.signal_summary) && aggregateCount < 2) {
    reject(trace, ["weak_why_now"], company, result.url, "weak_why_now: summary has no explicit signal");
    return undefined;
  }

  const strength = groupStrength(plan, group.candidates, aggregateCount);
  const wrongCompanyPenalty = nameMatchesSignal({
    company,
    title: result.title,
    text: [result.text, result.highlights?.join(" ")].filter(Boolean).join(" "),
    summary: summary.signal_summary,
  })
    ? 1
    : 0.72;
  if (wrongCompanyPenalty < 1 && trace) trace.funnel.entityMismatchPenalised += 1;
  const confidence = clamp(fit.multiplier * strength.score * wrongCompanyPenalty);
  const whyNow =
    isWeakWhyNow(summary.signal_summary) && aggregateCount >= 2
      ? `${company} has ${aggregateCount} distinct recent signals; strongest dated source is ${result.title ?? result.url}.`
      : summary.signal_summary || result.title || "";

  return {
    company,
    one_liner: oneLiner(company, enrichment, strength.label),
    fit_reason: fit.reason,
    why_now_signal: whyNow,
    signal_strength: strength.label,
    signal_source_url: result.url,
    signal_date: signalDate,
    ...(resolved.source ? { date_source: resolved.source } : {}),
    confidence_score: round(confidence),
    freshness_score: round(freshnessScore(signalDate, startIso, now)),
    net_new: netNew(company, plan.excludeNames),
  };
}

function isWeakWhyNow(value: string | undefined): boolean {
  return /no explicit why-now signal|not explicitly stated|not explicitly provided|cannot be determined|not determinable|does not provide|no explicit why-now|\bnull\b|not provided on the page/i.test(value ?? "");
}

function preliminaryScore(
  plan: SearchPlan,
  group: CandidateGroup,
  startIso: string,
  now: Date,
): number {
  const best = bestCandidate(plan, group.candidates);
  if (!best) return 0;
  return (
    groupStrength(plan, group.candidates, distinctSignalCount(group.candidates)).score * 0.75 +
    freshnessScore(eventDate(best, now), startIso, now) * 0.25
  );
}

// ---------------------------------------------------------------------------
// Generic fit: required gates + size + geo + not enterprise.
// ---------------------------------------------------------------------------

function evaluateFit(
  plan: SearchPlan,
  enrichment: CompanyEnrichment | undefined,
  signalText: string,
): { keep: boolean; multiplier: number; reason: string; codes: string[] } {
  const reject = (reason: string, ...codes: string[]) => ({
    keep: false,
    multiplier: 0,
    reason: `Excluded: ${reason}`,
    codes,
  });

  if (!enrichment || Object.keys(enrichment.summary).length === 0) {
    return reject("no company lookup available to verify the fit gates.", "no_enrichment");
  }
  const summary = enrichment.summary;

  if (summary.is_public_or_enterprise === true) {
    return reject("company appears public/enterprise scale.", "enterprise");
  }

  const hq = typeof summary.hq === "string" ? summary.hq : "";
  if (
    !textInCountries(hq, plan.hqCountries, true) &&
    !textInCountries(signalText, plan.hqCountries, false)
  ) {
    return reject(`HQ "${hq || "unknown"}" is outside ${plan.hqCountries.join("/")}.`, "hq");
  }

  const employees = parseEmployeeEstimate(summary.employee_estimate);
  const { min, max, unknownPolicy } = plan.employeeRange;
  if (employees === undefined) {
    if (unknownPolicy === "reject") return reject("employee estimate unknown.", "unknown_size");
  } else if (employees < min || employees > max) {
    return reject(
      `employee estimate ${employees.toLocaleString()} is outside the approximate ${min}-${max} target.`,
      "size",
    );
  }

  const required = plan.gateFields.filter((g) => g.required);
  const optional = plan.gateFields.filter((g) => !g.required);
  const failed = required.filter((g) => summary[g.key] !== true);
  if (failed.length > 0) {
    return reject(
      `required gate(s) not satisfied: ${failed.map((g) => g.key).join(", ")}.`,
      ...failed.map((g) => `required_gate:${g.key}`),
    );
  }

  const optionalPassed = optional.filter((g) => summary[g.key] === true);
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
        ? `optional gates passed: ${optionalPassed.map((g) => g.key).join(", ")}`
        : "no optional gates passed",
    );
  }
  parts.push(
    employees === undefined
      ? "employee count not exposed by lookup"
      : `${employees.toLocaleString()} estimated employees`,
  );
  parts.push(`HQ ${hq || "inferred from signal text"}`);
  return { keep: true, multiplier, reason: `${parts.join("; ")}.`, codes: [] };
}

// ---------------------------------------------------------------------------
// Signal strength: rank of signal_type within plan.signalTypes.
// ---------------------------------------------------------------------------

function normalizeSignalType(plan: SearchPlan, value: string | undefined): string {
  const t = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return plan.signalTypes.includes(t) ? t : OTHER_SIGNAL_TYPE;
}

function candidateText(candidate: Candidate): string {
  return [
    candidate.result.title,
    candidate.result.text,
    candidate.result.highlights?.join(" "),
    candidate.summary.signal_summary,
  ]
    .filter(Boolean)
    .join(" ");
}

function candidateStrength(plan: SearchPlan, candidate: Candidate): number {
  const type = normalizeSignalType(plan, candidate.summary.signal_type);
  const rank = plan.signalTypes.indexOf(type);
  const n = plan.signalTypes.length;
  // First type -> 0.95, last listed type -> 0.55, "other"/unknown -> 0.5.
  const base = rank < 0 ? 0.5 : 0.95 - 0.4 * (rank / Math.max(n - 1, 1));
  const text = candidateText(candidate);
  let tie = 0;
  for (const [pattern, weight] of TIE_BREAK_WEIGHTS) {
    if (pattern.test(text)) tie = Math.max(tie, weight);
  }
  return base * (1 - TIE_BREAK_SHARE) + tie * TIE_BREAK_SHARE + (candidate.result.score ?? 0) / 1e4;
}

function bestCandidate(plan: SearchPlan, candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort(
    (a, b) => candidateStrength(plan, b) - candidateStrength(plan, a),
  )[0];
}

function groupStrength(
  plan: SearchPlan,
  candidates: Candidate[],
  aggregateCount: number,
): { score: number; label: string } {
  const best = bestCandidate(plan, candidates);
  if (!best) return { score: 0, label: "no signal" };
  const bonus = Math.min(0.03 * (aggregateCount - 1), 0.06);
  const type = normalizeSignalType(plan, best.summary.signal_type);
  const label = type === OTHER_SIGNAL_TYPE ? "other signal" : type.replace(/_/g, " ");
  return {
    score: clamp(candidateStrength(plan, best) + bonus),
    label: aggregateCount >= 2 ? `${label} (${aggregateCount} signals)` : label,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCompanyName(result: ExaResult): string {
  const title = result.title ?? "";
  const patterns = [
    /\bat\s+([^|@–—-]+)/i,
    /^([^|@–—-]+?)\s+(?:to|opens|opening|hiring|adds|expands)\b/i,
    /^([^|@–—-]+?)\s*[@|]/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match?.[1]) return cleanCompanyName(match[1]);
  }
  return title.split(/[|–—-]/)[0]?.trim() || safeDomain(result.url) || "";
}

function cleanCompanyName(value: string): string {
  return value
    .replace(/^company:\s*/i, "")
    .replace(/\s+(jobs?|careers?|job board)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function freshnessScore(value: string, startIso: string, now: Date): number {
  const signal = new Date(value).getTime();
  const start = new Date(startIso).getTime();
  const end = now.getTime();
  if (!Number.isFinite(signal) || signal < start || signal > end) return 0;
  return clamp((signal - start) / (end - start));
}

function safeDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function nameTokens(name: string): string[] {
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

function isNonCompanyDomain(url: string): boolean {
  const d = safeDomain(url);
  return !!d && NON_COMPANY_DOMAIN_PATTERNS.some((p) => p.test(d));
}

function domainExcluded(url: string, excluded: readonly string[]): boolean {
  const domain = safeDomain(url);
  if (!domain) return false;
  return excluded.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function dedupeKey(url: string, companyKey: string): string {
  const domain = safeDomain(url) ?? companyKey;
  return isAggregatorDomain(domain) ? `${domain}:${companyKey}` : domain;
}

function distinctSignalCount(candidates: Candidate[]): number {
  return new Set(
    candidates.map((candidate) =>
      dedupeKey(candidate.result.url, normalizeName(candidate.summary.company_name)),
    ),
  ).size;
}

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

function isAggregatorDomain(domain: string): boolean {
  return [
    "greenhouse.io",
    "smartrecruiters.com",
    "themuse.com",
    "venturefizz.com",
  ].some((aggregator) => domain === aggregator || domain.endsWith(`.${aggregator}`));
}

function isRejectedSourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "exa.ai" && parsed.pathname.startsWith("/library/person/");
  } catch {
    return false;
  }
}

function oneLiner(
  company: string,
  enrichment: CompanyEnrichment | undefined,
  label: string,
): string {
  const description = enrichment?.summary.description;
  if (typeof description === "string" && description.trim()) {
    const d = description.trim();
    return d.length > 160 ? `${d.slice(0, 157)}...` : d;
  }
  return `${company} shows a recent ${label} signal.`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
