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
  | "non_event_page"
  | "weak_hiring_signal"
  | "unquoted_signal"
  | "unquoted_gate"
  | "quote_not_in_page"
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
  /** Text of the lookup page Exa summarised, when captured. */
  lookupText?: string;
  now: Date;
  /** Squashed keys (see squashName) of companies from earlier runs -> `already_seen`. */
  seen?: Set<string>;
  /** Squashed keys of companies already accepted in this run -> `duplicate`. */
  submitted?: Set<string>;
};

export type CheckLeadOptions = {
  /** Production default: enforce verbatim quotes. Replay can skip quote-only gates to project deterministic rules. */
  evidenceMode?: "full" | "skip-quotes";
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
  /** Where the HQ country evidence came from: the lookup, or (only when the lookup had no HQ) the signal page text. */
  hq_basis?: "enrichment" | "signal_text";
  /** Confidence multiplier from fit (size known? optional gates). */
  multiplier: number;
  fit_reason: string;
  /** True when a quote was checked against an estimate but the lookup page text was not captured. */
  size_quote_unverified?: true;
};

export type LeadVerdict =
  | { ok: true; details: LeadDetails }
  | { ok: false; code: GateCode; reason: string; tier?: "candidate"; details?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const CORPORATE_SUFFIXES = new Set([
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "group",
]);

/**
 * Dedupe key for a company name: lowercase, accents stripped, a trailing
 * domain suffix (".ai", ".io", ".com"...) dropped, trailing
 * corporate suffixes (inc/llc/ltd/corp/co/group...) dropped, then all
 * non-alphanumerics removed. "Diakon Logistics" == "Diakonlogistics".
 */
export function squashName(name: string): string {
  const tokens = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    // "Avarra.ai" == "Avarra": drop a trailing domain suffix attached to the last word.
    .replace(/(?<=[a-z0-9])\.(?:ai|io|com|co|app|dev|net|org|tech|so|xyz)$/, "")
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

export const BUILTIN_EXCLUDED_SIGNAL_DOMAINS = [
  "indeed.com",
  "glassdoor.com",
  "snagajob.com",
  "tealhq.com",
  "ihire.com",
  "ihirelogistics.com",
  "ziprecruiter.com",
  "linkedin.com/jobs",
  "jobs.ashbyhq.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "apply.workable.com",
  "builtin.com",
  "wellfound.com/jobs",
  "simplyhired.com",
  "monster.com",
  "careerbuilder.com",
  "jobvite.com",
  "smartrecruiters.com",
  "workdayjobs.com",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "breezy.hr",
  "recruitee.com",
  "comeet.com",
  "jobberman.com",
  "jobrapido.com",
  "jobera.com",
  "intern-flow.in",
  "zerogtalent.com",
] as const;

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

function builtInSignalDomainExcluded(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const domain = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase();
  return BUILTIN_EXCLUDED_SIGNAL_DOMAINS.some((entry) => {
    const [host, ...pathParts] = entry.split("/");
    const domainMatch = domain === host || domain.endsWith(`.${host}`);
    if (!domainMatch) return false;
    const pathPrefix = pathParts.join("/");
    return !pathPrefix || path.startsWith(`/${pathPrefix}`);
  });
}

function isPersonalProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, "");
    return (domain === "linkedin.com" || domain.endsWith(".linkedin.com")) && /^\/in\/[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function registrableDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const domain = safeDomain(url);
  if (!domain) return undefined;
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const twoPartSuffixes = new Set(["co.uk", "com.au", "co.nz", "com.sg", "co.in"]);
  const suffix = parts.slice(-2).join(".");
  return twoPartSuffixes.has(suffix) && parts.length >= 3 ? parts.slice(-3).join(".") : suffix;
}

// A hiring signal is declared by the summariser's signal_type (a snake_case
// plan type such as ops_hire / ops_hiring_wave) or is an explicit job-post
// shape (job-board style URL path, or a title that IS a hiring notice). It is
// NOT inferred from incidental words in the summary: a facility/lease article
// that mentions "jobs" or "planned staffing" is not a job post.
const HIRING_TYPE_TOKENS = new Set([
  "hire", "hires", "hiring", "recruit", "recruiting", "recruitment", "job", "jobs", "role", "roles", "career", "careers",
]);
const JOB_POST_PATH = /\/(?:jobs?|careers?|openings?|vacancies|positions?)(?:\/|$)/i;
const JOB_POST_TITLE = /^\s*(?:we(?:'|’)re hiring|now hiring|hiring[:\s-])|\bis hiring\b|\bjob (?:posting|opening|listing)s?\b|\bapply now\b/i;

function isHiringSignal(signal: LeadSignal): boolean {
  const type = (signal.summary.signal_type ?? "").toLowerCase();
  if (type.split(/[^a-z0-9]+/).some((tok) => HIRING_TYPE_TOKENS.has(tok))) return true;
  try {
    if (JOB_POST_PATH.test(new URL(signal.url).pathname)) return true;
  } catch {
    // unparseable URL: no path evidence
  }
  return JOB_POST_TITLE.test(signal.title ?? "");
}

const ROLE_WORDS = [
  "manager", "director", "engineer", "developer", "operator", "associate", "coordinator",
  "specialist", "analyst", "representative", "lead", "supervisor", "driver", "technician",
  "sales", "marketing", "operations", "warehouse", "accountant", "designer", "recruiter",
];

function distinctRoles(text: string): Set<string> {
  const lower = text.toLowerCase();
  const roles = new Set<string>();
  for (const role of ROLE_WORDS) {
    if (new RegExp(`\\b${role}\\b`).test(lower)) roles.add(role);
  }
  for (const m of lower.matchAll(/\b([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,3})\s+(?:role|position|job|opening)s?\b/g)) {
    if (m[1]) roles.add(m[1]);
  }
  return roles;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Letters and digits only, after NFKC / entity decoding / lowercasing. */
function quoteStrip(value: string): string {
  return decodeHtmlEntities(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const QUOTE_MAX_TEXT = 20_000;
const QUOTE_MAX_QUOTE = 500;
const QUOTE_MIN_SEGMENT = 12;
const QUOTE_MIN_TOTAL = 20;

export interface QuoteMatch {
  ok: boolean;
  reason?: "too_short" | "segment_missing" | "empty";
}

export interface QuoteMatchOptions {
  /** Minimum alphanumeric characters per segment (default 12). */
  minSegment?: number;
  /** Minimum alphanumeric characters across the whole quote (default 20). */
  minTotal?: number;
}

/** Max distance (stripped chars) between the starts of consecutive clause matches. */
const QUOTE_LOCALITY = 600;

/**
 * Split on clause punctuation (not the dot inside "17.5M"), strip each piece,
 * then merge pieces shorter than `minClause` into the next one (a short tail
 * joins the previous clause).
 */
function quoteClauses(quote: string, minClause: number): string[] {
  const pieces = quote
    .split(/\.{3}|\u2026|(?<!\d)\.|\.(?!\d)|[,;:"\u201C\u201D\n]/)
    .map(quoteStrip)
    .filter((x) => x.length > 0);
  const out: string[] = [];
  let buf = "";
  for (const p of pieces) {
    buf += p;
    if (buf.length >= minClause) { out.push(buf); buf = ""; }
  }
  if (buf) {
    if (out.length > 0) out[out.length - 1] += buf;
    else out.push(buf);
  }
  return out;
}

/**
 * Does `quote` appear in `text`, ignoring case, punctuation, bullets, whitespace
 * and symbols? The quote is cut into clauses (at . , ; : " newline and ...);
 * every clause must occur in the text, in order, each starting within
 * QUOTE_LOCALITY stripped characters of the previous clause's start. That
 * tolerates a summariser dropping an attribution or flattening a list, but
 * rejects clauses that are reordered, absent, or pulled from distant sections.
 */
export function quoteMatch(
  quote: string | undefined,
  text: string | undefined,
  opts: QuoteMatchOptions = {},
): QuoteMatch {
  const minSegment = opts.minSegment ?? QUOTE_MIN_SEGMENT;
  const minTotal = opts.minTotal ?? QUOTE_MIN_TOTAL;
  const clauses = quoteClauses((quote ?? "").slice(0, QUOTE_MAX_QUOTE), minSegment);
  if (clauses.length === 0) return { ok: false, reason: "empty" };
  if (clauses.some((x) => x.length < minSegment) || clauses.reduce((n, x) => n + x.length, 0) < minTotal) {
    return { ok: false, reason: "too_short" };
  }
  const haystack = quoteStrip((text ?? "").slice(0, QUOTE_MAX_TEXT));
  const place = (i: number, prevStart: number, prevEnd: number): boolean => {
    if (i === clauses.length) return true;
    const c = clauses[i]!;
    const limit = i === 0 ? Infinity : prevStart + QUOTE_LOCALITY;
    for (let at = haystack.indexOf(c, prevEnd); at >= 0 && at <= limit; at = haystack.indexOf(c, at + 1)) {
      if (place(i + 1, at, at + c.length)) return true;
    }
    return false;
  };
  return place(0, 0, 0) ? { ok: true } : { ok: false, reason: "segment_missing" };
}

export function quoteInText(
  quote: string | undefined,
  text: string | undefined,
  opts?: QuoteMatchOptions,
): boolean {
  return quoteMatch(quote, text, opts).ok;
}

/** Short, inherently compact quotes (a headcount, date or location phrase). */
const SHORT_QUOTE: QuoteMatchOptions = { minSegment: 6, minTotal: 6 };

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

/** A signal_date this close (in days) to the publish date's month/day, in another year, is a year-slip. */
const YEAR_SLIP_DAYS = 90;

function isYearSlip(sig: string, pub: string): boolean {
  const [sy, sm, sd] = sig.split("-").map(Number) as [number, number, number];
  const [py, pm, pd] = pub.split("-").map(Number) as [number, number, number];
  if (sy === py) return false;
  const sigMs = Date.UTC(sy, sm - 1, sd);
  // The publish month/day placed in the signal's year and its neighbours (Dec/Jan wrap).
  return [sy - 1, sy, sy + 1].some(
    (y) => Math.abs(sigMs - Date.UTC(y, pm - 1, pd)) <= YEAR_SLIP_DAYS * DAY_MS,
  );
}

/**
 * Resolve the EVENT date. Exa summaries sometimes hallucinate the YEAR, so
 * signal_date is trusted if it falls within publishedDate minus 12 months to
 * plus 7 days (and not after now + 1 day). If it does not, publishedDate
 * replaces it only for an apparent year-slip (same time of year as the publish
 * date, different year) or a future / after-publish date; otherwise the window
 * is judged on the signal date itself, so "opened its facility in March 2024"
 * in a 2026-09 article is stale, not fresh. With no publishedDate, an
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
    if (sig && sigMs !== undefined && notFuture && sigMs <= pubMs + 7 * DAY_MS) {
      if (sigMs >= addMonthsMs(pub, -12)) return { date: sig, source: "signal" };
      // Older than 12 months before publication: a year-slip, or a genuinely old event.
      return isYearSlip(sig, pub)
        ? { date: pub, source: "published_fallback" }
        : { date: sig, source: "signal" };
    }
    return { date: pub, source: "published_fallback" };
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

const HEADCOUNT_WORD = /^\s*(?:\S+\s+){0,2}?(?:employees|staff|people|headcount|team\s+members)\b/i;

/**
 * All numbers in a text: "3,560", "350+", "~350", "1.2k", "10k+". With
 * `keepYears` false, bare 4-digit numbers in 1900-2099 look like years
 * ("founded 2004") and are ignored unless a headcount word follows within two
 * words.
 */
function extractNumbers(quote: string, keepYears: boolean): Array<{ value: number; index: number; end: number }> {
  const out: Array<{ value: number; index: number; end: number }> = [];
  for (const m of quote.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?(?![a-zA-Z])/g)) {
    const raw = m[1]!.replace(/,+$/, "");
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const yearLike = /^(19|20)\d\d$/.test(raw) && !m[2];
    if (!keepYears && yearLike && !HEADCOUNT_WORD.test(quote.slice(m.index! + m[0].length))) continue;
    out.push({ value: m[2] ? n * 1000 : n, index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function numbersIn(quote: string): number[] {
  return extractNumbers(quote, false).map((n) => n.value);
}

/**
 * Employee count from Exa's free-form estimate: 350, "~350", "350+", "1.2k",
 * "10k+", "3,560", "200-500" (midpoint 350).
 */
export function parseEmployeeEstimate(value: CompanySummary["employee_estimate"]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const nums = extractNumbers(value, true);
  if (nums.length === 0) return undefined;
  const first = nums[0]!;
  const second = nums[1];
  if (second && /^\s*[-\u2013\u2014]\s*$/.test(value.slice(first.end, second.index))) {
    // "1-2k": a trailing k applies to both ends when the first has none.
    const secondK = /k\s*$/i.test(value.slice(second.index, second.end));
    const firstK = /k\s*$/i.test(value.slice(first.index, first.end));
    const a = secondK && !firstK && first.value < 1000 ? first.value * 1000 : first.value;
    return Math.round((a + second.value) / 2);
  }
  return Math.round(first.value);
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
const candidate = (key: string, reason: string) => ({
  ok: false as const,
  code: "unquoted_gate" as const,
  reason,
  tier: "candidate" as const,
  details: { key },
});

/** Name / domain checks that need no lookup. */
export function checkIdentity(
  plan: SearchPlan,
  company: string,
  signalUrl: string,
  companyUrl?: string,
): Fail | undefined {
  if (isPersonalProfileUrl(signalUrl)) {
    return fail("non_event_page", "signal source is a personal profile, not an event page");
  }
  if (builtInSignalDomainExcluded(signalUrl)) {
    return fail("exclude_domain", "signal source is a built-in excluded job-board domain");
  }
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
  const eventMs = Date.parse(`${resolved.date}T00:00:00.000Z`);
  // Inclusive window: start <= event <= now (the start day itself is fresh).
  if (!(eventMs >= Date.parse(start) && eventMs <= now.getTime())) {
    return fail(
      "stale_date",
      `event date ${resolved.date} is outside the ${plan.months}-month window starting ${start.slice(0, 10)}`,
    );
  }
  return { ok: true, date: resolved.date, source: resolved.source };
}

/** A lookup quote missing from a truncated page is unproven, not false: candidate tier instead of a hard reject. */
function lookupQuoteMissing(enrichment: { lookup_text_truncated?: boolean }, key: string, reason: string): LeadVerdict {
  if (enrichment.lookup_text_truncated === true) {
    return {
      ok: false,
      code: "unquoted_gate",
      reason: `${key} quote not found in the first 20,000 characters of the lookup page (page was truncated)`,
      tier: "candidate",
      details: { key },
    };
  }
  return { ok: false, code: "quote_not_in_page", reason, details: { key } };
}

function entityMatches(company: string, haystack: string): boolean {
  return nameMatchesSignal({ company, text: haystack });
}

/**
 * Run every deterministic gate for one lead. Pure: it never mutates `seen` or
 * `submitted`; on `ok`, callers add `details.key` themselves.
 */
export function checkLead(plan: SearchPlan, input: LeadInput, options: CheckLeadOptions = {}): LeadVerdict {
  const { company, signal, enrichment, now } = input;
  const enforceQuotes = options.evidenceMode !== "skip-quotes";
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

  // Page evidence only: signal_summary is Exa's own LLM output and would confirm itself.
  const haystack = [signal.title, signal.text].filter(Boolean).join(" ").trim();
  if (!haystack) {
    return fail("entity_mismatch", "no page text to verify the company name");
  }
  if (!entityMatches(company, haystack)) {
    return fail("entity_mismatch", `"${company}" does not appear in the signal page`);
  }
  if (isHiringSignal(signal)) {
    const sameDomain = registrableDomain(signal.url) !== undefined && registrableDomain(signal.url) === registrableDomain(input.companyUrl);
    if (!sameDomain && distinctRoles(haystack).size < 2) {
      return fail("weak_hiring_signal", "hiring signal is not on the company's own domain and does not name at least two distinct roles");
    }
  }
  const signalQuote = typeof signal.summary.signal_quote === "string" ? signal.summary.signal_quote : "";
  if (enforceQuotes && !signalQuote.trim()) {
    return { ok: false, code: "unquoted_signal", reason: "summary gives no verbatim sentence stating an event", tier: "candidate" };
  }
  if (enforceQuotes && !quoteInText(signalQuote, haystack)) {
    return fail("quote_not_in_page", "signal_quote was not found in the signal page text");
  }
  const dateQuote = typeof signal.summary.signal_date_quote === "string" ? signal.summary.signal_date_quote : "";
  if (enforceQuotes && dateQuote.trim() && !quoteInText(dateQuote, haystack, SHORT_QUOTE)) {
    return fail("quote_not_in_page", "signal_date_quote was not found in the signal page text");
  }

  if (!enrichment || Object.keys(enrichment).length === 0) {
    return fail("no_enrichment", "no company lookup available to verify the fit gates");
  }
  if (enrichment.is_public_or_enterprise === true) {
    return fail("enterprise", "company appears public/enterprise scale");
  }

  const hq = typeof enrichment.hq === "string" ? normalizeNullish(enrichment.hq) ?? "" : "";
  const hqKnown = hq !== "" && !/^unknown$/i.test(hq);
  let hqBasis: "enrichment" | "signal_text" = "enrichment";
  if (hqKnown) {
    // A known HQ decides, whatever the signal page says.
    if (!textInCountries(hq, plan.hqCountries, true)) {
      return fail("hq", `HQ "${hq}" is outside ${plan.hqCountries.join("/")}`);
    }
    const hqQuote = typeof enrichment.hq_quote === "string" ? enrichment.hq_quote : "";
    if (enforceQuotes && plan.hqCountries.length > 0 && !hqQuote.trim()) {
      return candidate("hq", `HQ "${hq}" is not backed by a verbatim lookup-page quote`);
    }
    if (enforceQuotes && plan.hqCountries.length > 0 && input.lookupText && !quoteInText(hqQuote, input.lookupText, SHORT_QUOTE)) {
      return lookupQuoteMissing(enrichment, "hq", "hq_quote was not found in the lookup page text");
    }
  } else if (plan.hqCountries.length > 0) {
    // No HQ from the lookup: fall back to the page text, at a confidence penalty.
    if (!textInCountries(haystack, plan.hqCountries, false)) {
      return fail("hq", `HQ unknown and the signal page does not place the company in ${plan.hqCountries.join("/")}`);
    }
    hqBasis = "signal_text";
  }

  // Size: the estimate counts only if its quoted source backs it up.
  const claimed = parseEmployeeEstimate(enrichment.employee_estimate);
  const quote =
    typeof enrichment.employee_estimate_source === "string"
      ? enrichment.employee_estimate_source
      : undefined;
  let sizeQuoteUnverified: true | undefined;
  if (quote?.trim()) {
    if (enforceQuotes && input.lookupText && !quoteInText(quote, input.lookupText, SHORT_QUOTE)) {
      return lookupQuoteMissing(enrichment, "employee_estimate_source", "employee_estimate_source was not found in the lookup page text");
    }
    if (!input.lookupText) sizeQuoteUnverified = true;
  }
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
  for (const gate of required) {
    const value = enrichment[gate.key];
    const quote = typeof enrichment[`${gate.key}_quote`] === "string" ? String(enrichment[`${gate.key}_quote`]) : "";
    if (enforceQuotes && value !== true && (value === null || value === undefined || !quote.trim())) {
      return candidate(gate.key, `required gate "${gate.key}" was not stated on the lookup page`);
    }
    if (enforceQuotes && value === true && !quote.trim()) {
      return candidate(gate.key, `required gate "${gate.key}" is not backed by a verbatim lookup-page quote`);
    }
    if (enforceQuotes && quote.trim() && input.lookupText && !quoteInText(quote, input.lookupText)) {
      return lookupQuoteMissing(enrichment, gate.key, `quote for required gate "${gate.key}" was not found in the lookup page text`);
    }
  }
  const failed = required.filter((g) => enrichment[g.key] !== true);
  if (failed.length > 0) {
    return fail(
      `required_gate:${failed[0]!.key}`,
      `required gate(s) not satisfied: ${failed.map((g) => g.key).join(", ")}`,
    );
  }

  const optionalPassed = optional.filter((g) => {
    if (enrichment[g.key] !== true) return false;
    const quote = typeof enrichment[`${g.key}_quote`] === "string" ? String(enrichment[`${g.key}_quote`]) : "";
    if (!quote.trim()) return false;
    return !input.lookupText || quoteInText(quote, input.lookupText);
  }).map((g) => g.key);
  const optionalFrac = optional.length > 0 ? optionalPassed.length / optional.length : 1;
  const multiplier = (employees === undefined ? 0.82 : 1) * (0.9 + 0.1 * optionalFrac) * (hqBasis === "signal_text" ? 0.9 : 1);

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
  parts.push(hqBasis === "signal_text" ? "HQ inferred from signal text" : `HQ ${hq}`);

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
      hq_basis: hqBasis,
      multiplier,
      fit_reason: `${parts.join("; ")}.`,
      ...(sizeQuoteUnverified ? { size_quote_unverified: true } : {}),
    },
  };
}
