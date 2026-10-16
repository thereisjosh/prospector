/**
 * The deterministic lead gates: one source of truth shared by the batch
 * workflow (src/score.ts) and the agent harness (submit_lead). Everything in
 * here is pure and synchronous: no network, no clock reads (callers pass `now`).
 */
import { nameMatchesSignal, normalizeName } from "./eval";
import { textInCountries } from "./geo";
import { normalizeNullish, normalizeSignalDate, type SearchPlan } from "./plan";
import type { CompanySummary, SignalSummary } from "./types";
import { CONTACT_TITLE_MAX, contactEvidence, mentionOffsets, type ContactEvidence } from "./evidence";

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
  /** How the size quote was verified on the lookup page: a phrase match, or a bare number next to an employee word. */
  size_quote_match?: "phrase" | "number_adjacent";
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
  // Added 2026-10-15 (memory-eval-2026-10-15b, S1 verdicts with q3=no on a listing URL).
  "snaprecruit.com",
  "jobtarget.com",
  "jobs.capitalfactory.com",
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

const LISTING_HOST = /^(?:jobs|careers?|apply|boards)\./i;
const LISTING_PATH = /\/(?:jobs?|careers?|vacanc(?:y|ies)|positions?|openings?)(?:\/|$|\?)/i;

/** True when the URL is shaped like a job listing / careers page (host prefix or path segment). */
export function isListingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LISTING_HOST.test(u.hostname) || LISTING_PATH.test(`${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}

/**
 * A job listing on a site that is not the company's own: a board's company page, an aggregator's job page. Own-domain
 * careers pages are not caught here. An unknown company domain counts as "not own domain". The summary's signal_type
 * is deliberately NOT consulted: the rule must not trust the summariser's label.
 */
export function isThirdPartyListing(signal: LeadSignal, companyUrl: string | undefined): boolean {
  if (!isListingUrl(signal.url)) return false;
  const own = registrableDomain(companyUrl);
  const sig = registrableDomain(signal.url);
  if (own !== undefined && sig !== undefined && own === sig) return false;
  return true;
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
 * Cut the quote at explicit elisions (`...` / `…`) first, then split each part on
 * clause punctuation (not the dot inside "17.5M"), strip each piece, and merge
 * pieces shorter than `minClause` into the next one (a short tail joins the
 * previous clause). Merging never crosses an elision: text on either side of
 * "..." is not adjacent on the page, so gluing "+11 people)" onto the words after
 * the ellipsis would demand a string that exists nowhere. A part that stays
 * shorter than `minClause` is kept as its own short clause and the quote is
 * rejected as too_short.
 */
function quoteClauses(quote: string, minClause: number): string[] {
  const out: string[] = [];
  for (const part of quote.split(/\.{3}|\u2026/)) {
    const pieces = part
      .split(/(?<!\d)\.|\.(?!\d)|[,;:"\u201C\u201D\n]/)
      .map(quoteStrip)
      .filter((x) => x.length > 0);
    const clauses: string[] = [];
    let buf = "";
    for (const p of pieces) {
      buf += p;
      if (buf.length >= minClause) { clauses.push(buf); buf = ""; }
    }
    if (buf) {
      if (clauses.length > 0) clauses[clauses.length - 1] += buf;
      else clauses.push(buf);
    }
    out.push(...clauses);
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

const ADJACENT_EMPLOYEE_WORD = /employee|employees|staff|headcount|people/i;
const HEADCOUNT_WINDOW = 40;

/**
 * Size-source quote check (employee_estimate_source only). A quote that is just
 * a number ("281", "281 employees", "281 staff") names no page phrase, but it is
 * verifiable: the page must contain that number within 40 characters of an
 * employee word. "Employees: 281" supports "281"; "281 trucks" does not.
 * Anything else falls through to the general matcher. Returns how it matched.
 */
export function headcountQuoteInText(
  quote: string | undefined,
  text: string | undefined,
): "number_adjacent" | "phrase" | undefined {
  const bare = /^\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\s+(?:employees?|staff))?\s*\.?\s*$/i.exec(quote ?? "");
  if (bare) {
    const n = bare[1]!.replace(/,/g, "");
    const page = decodeHtmlEntities((text ?? "").slice(0, QUOTE_MAX_TEXT)).normalize("NFKC");
    for (const m of page.matchAll(/(?<![\d,.])\d{1,3}(?:,\d{3})+(?![\d])|(?<![\d,.])\d+(?![\d])/g)) {
      if (m[0].replace(/,/g, "") !== n) continue;
      const from = Math.max(0, m.index! - HEADCOUNT_WINDOW);
      const around = page.slice(from, m.index! + m[0].length + HEADCOUNT_WINDOW);
      if (ADJACENT_EMPLOYEE_WORD.test(around)) return "number_adjacent";
    }
  }
  return quoteInText(quote, text, SHORT_QUOTE) ? "phrase" : undefined;
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
  if (isThirdPartyListing(signal, input.companyUrl)) {
    return fail("non_event_page", "job listing on a third-party site");
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
  let sizeQuoteMatch: "phrase" | "number_adjacent" | undefined;
  if (quote?.trim()) {
    if (enforceQuotes && input.lookupText) {
      sizeQuoteMatch = headcountQuoteInText(quote, input.lookupText);
      if (!sizeQuoteMatch) {
        return lookupQuoteMissing(enrichment, "employee_estimate_source", "employee_estimate_source was not found in the lookup page text");
      }
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
      ...(sizeQuoteMatch ? { size_quote_match: sizeQuoteMatch } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Contacts (docs/SPEC-agent.md §5b). Pure, like checkLead: the model never decides a contact's tier.
// ---------------------------------------------------------------------------

export type ContactGateCode = "contact_unverified" | "contact_role_mismatch" | "contact_quote_not_in_page" | "contact_stale" | "contact_role_changed";

/**
 * Hosts that are LinkedIn, a copy of it, or a people-data aggregator. A page here is never evidence for a
 * verified contact (LinkedIn User Agreement §8.2: no LinkedIn data obtained through search tools or
 * aggregators is copied), and the contact page search excludes them.
 */
export const CONTACT_NON_EVIDENCE_DOMAINS = [
  "linkedin.com",
  "exa.ai",
  "theorg.com",
  "datanyze.com",
  "zoominfo.com",
  "rocketreach.co",
  "apollo.io",
  "signalhire.com",
  "contactout.com",
  "lusha.com",
  "leadiq.com",
  "seamless.ai",
  "clearbit.com",
  "peopledatalabs.com",
  "crunchbase.com",
  "cbinsights.com",
  "owler.com",
  "craft.co",
  "zippia.com",
  "adapt.io",
  // Added 2026-10-16 (FAILURES #29): the list is a floor, not the rule. A page off the company's own domain
  // must also pass the aggregator-shape and prose checks in checkContact, so mirrors this list misses fail too.
  "muraena.ai",
  "rocketreach.com",
  "pitchbook.com",
  "kaspr.io",
  "hunter.io",
  "findymail.com",
  "snov.io",
  "getprospect.com",
  "wiza.co",
  "uplead.com",
  "cognism.com",
  "6sense.com",
  "lead411.com",
  // Added 2026-10-16 (FAILURES #30): company directories. A company page that lists "employees" is a field list
  // with a title per person, not evidence that the title is current.
  "visualvisitor.com",
  "dnb.com",
  "hoovers.com",
  "buzzfile.com",
  "manta.com",
  "bizapedia.com",
  "opencorporates.com",
  "corporationwiki.com",
  "growjo.com",
  "tracxn.com",
  "aeroleads.com",
  "globaldatabase.com",
  "kompass.com",
] as const;

/** Path segments (or a `person` query key) that mark a scraped-profile / people-directory page. */
const AGGREGATOR_PATH_SEGMENTS = new Set(["profile", "profiles", "person", "people", "employee", "employees", "contact", "contacts", "in", "pub", "directory"]);

/** A URL shaped like a person profile or people directory: /profile/, /person/, /people/, /in/, /pub/, /directory/, /company/<x>/people, /company(ies)/<digits>, ?person=. */
export function isAggregatorShapedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.has("person")) return true;
    // Company-directory records: /companies/5788692/bay_logistics_inc, /company/12345/acme.
    if (/\/compan(?:y|ies)\/\d+(?:\/|$)/i.test(u.pathname)) return true;
    return u.pathname.toLowerCase().split("/").some((seg) => AGGREGATOR_PATH_SEGMENTS.has(seg));
  } catch {
    return true;
  }
}

/** Evidence older than this cannot verify a press/news contact on its own. */
export const CONTACT_MAX_PAGE_AGE_MONTHS = 24;
/** Characters of prose a press/news page must hold around the name and title (aggregators are field lists). */
export const CONTACT_MIN_PROSE_CHARS = 200;

/** Characters in prose sentences (7+ words, mostly lowercase function words) within 600 chars of the span. */
export function proseCharsAround(text: string, start: number, end: number): number {
  const window = text.slice(Math.max(0, start - 600), Math.min(text.length, end + 600));
  let total = 0;
  for (const raw of window.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length < 7) continue;
    const lower = words.filter((w) => /^[a-z][a-z'’-]*[,.;:!?]?$/.test(w)).length;
    if (lower / words.length >= 0.3) total += sentence.length;
  }
  return total;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoFrom(year: number, month?: number, day?: number): string {
  const y = String(year).padStart(4, "0");
  if (!month) return y;
  const m = String(month).padStart(2, "0");
  return day ? `${y}-${m}-${String(day).padStart(2, "0")}` : `${y}-${m}`;
}

/** A page date as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, or undefined (not a plausible past-or-today date). */
export function normalizePageDate(raw: string | undefined, now: Date = new Date()): string | undefined {
  const s = (raw ?? "").trim();
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(s);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : undefined;
  const day = m[3] ? Number(m[3]) : undefined;
  if (year < 1990 || (month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > 31))) return undefined;
  const iso = isoFrom(year, month, day);
  const upper = new Date(Date.UTC(year, (month ?? 12) - 1, day ?? 28));
  return upper.getTime() > now.getTime() + 2 * 86_400_000 ? undefined : iso;
}

/** The full date written nearest the span (within 400 chars): "Jun 3, 2019", "3 June 2019", "June 2019", "2019-06-03". */
export function dateNearSpan(text: string, start: number, end: number, now: Date = new Date()): string | undefined {
  const from = Math.max(0, start - 400);
  const window = text.slice(from, Math.min(text.length, end + 400));
  const mon = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string | undefined]> = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => normalizePageDate(`${m[1]}-${m[2]}-${m[3]}`, now)],
    [new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), (m) => normalizePageDate(isoFrom(Number(m[3]), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, Number(m[2])), now)],
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon},?\\s+(\\d{4})\\b`, "gi"), (m) => normalizePageDate(isoFrom(Number(m[3]), MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, Number(m[1])), now)],
    [new RegExp(`\\b${mon},?\\s+(\\d{4})\\b`, "gi"), (m) => normalizePageDate(isoFrom(Number(m[2]), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1), now)],
  ];
  const mid = (start + end) / 2;
  let best: { date: string; dist: number } | undefined;
  for (const [re, toDate] of patterns) {
    for (const m of window.matchAll(re)) {
      const date = toDate(m as RegExpExecArray);
      if (!date) continue;
      const dist = Math.abs(from + (m.index ?? 0) - mid);
      if (!best || dist < best.dist) best = { date, dist };
    }
  }
  return best?.date;
}

/** Whole months from a page date (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) to now; a bare year counts from its December. */
export function monthsSince(date: string, now: Date = new Date()): number {
  const [y, mo] = date.split("-").map(Number);
  return (now.getUTCFullYear() - y!) * 12 + (now.getUTCMonth() + 1 - (mo ?? 12));
}

export function isContactNonEvidenceUrl(url: string): boolean {
  if (!safeDomain(url)) return true;
  return domainExcluded(url, CONTACT_NON_EVIDENCE_DOMAINS);
}

/** Multi-word titles folded to one token before splitting ("Chief Operating Officer" -> coo). */
const TITLE_PHRASES: Array<[RegExp, string]> = [
  [/\bchief executive officer\b/g, " ceo "],
  [/\bchief operat(?:ing|ions) officer\b/g, " coo "],
  [/\bchief financial officer\b/g, " cfo "],
  [/\bchief technology officer\b/g, " cto "],
  [/\bchief marketing officer\b/g, " cmo "],
  [/\bchief revenue officer\b/g, " cro "],
  [/\bchief people officer\b/g, " people "],
  [/\bhuman resources\b/g, " people "],
  [/\bsupply chain\b/g, " supplychain "],
  [/\bco-?founder\b/g, " founder "],
  [/\bgeneral manager\b/g, " gm "],
  [/\bmanaging director\b/g, " md "],
  [/\bvice[\s-]+president\b/g, " vp "],
];

/** Abbreviations: the C-suite ones also carry their function, so "COO" shares "operations" with "VP of Operations". */
const TITLE_ABBREVIATIONS: Record<string, string[]> = {
  coo: ["coo", "operations"],
  cfo: ["cfo", "finance"],
  cto: ["cto", "technology"],
  cmo: ["cmo", "marketing"],
  cro: ["cro", "revenue"],
  ceo: ["ceo"],
  vp: ["vp"],
  svp: ["vp"],
  evp: ["vp"],
  avp: ["vp"],
  ops: ["operations"],
  hr: ["people"],
};

/** Word stems folded to one canonical function word ("operational", "operating" -> operations). First match wins. */
const TITLE_STEMS: Array<[string, string]> = [
  ["operat", "operations"],
  ["logistic", "logistics"],
  ["warehous", "warehouse"],
  ["fulfil", "fulfillment"],
  ["procure", "procurement"],
  ["purchas", "procurement"],
  ["financ", "finance"],
  ["partnership", "partnerships"],
  ["marketing", "marketing"],
  ["sales", "sales"],
  ["technolog", "technology"],
  ["engineer", "engineering"],
  ["production", "production"],
  ["product", "product"],
  ["transport", "transportation"],
  ["distribut", "distribution"],
  ["facilit", "facilities"],
  ["recruit", "recruiting"],
  ["talent", "recruiting"],
];

/**
 * Seniority, scope and filler words. They say how senior someone is, not what they do, so they never
 * count as the shared role word when the role phrase names a function ("VP" alone would match "VP of Sales"
 * to "VP of Operations").
 */
const TITLE_RANK_WORDS = new Set([
  "vp", "president", "director", "head", "chief", "officer", "manager", "management", "lead", "leader", "senior", "sr",
  "junior", "jr", "gm", "md", "executive", "founder", "owner", "partner", "principal", "managing", "ceo", "coo",
  "cfo", "cto", "cmo", "cro", "associate", "assistant", "deputy", "staff", "team", "global", "regional",
  "national", "group", "division", "department", "country", "area", "site", "interim", "acting", "coordinator",
  "specialist", "supervisor", "administrator", "analyst", "consultant", "advisor", "board", "member", "general",
  "of", "the", "and", "for", "at", "in", "to", "a", "an", "on", "with", "s",
]);

function titleTokens(text: string): string[] {
  let s = ` ${text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")} `;
  for (const [pattern, replacement] of TITLE_PHRASES) s = s.replace(pattern, replacement);
  const out: string[] = [];
  for (const raw of s.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const abbreviation = TITLE_ABBREVIATIONS[raw];
    if (abbreviation) {
      out.push(...abbreviation);
      continue;
    }
    const stem = TITLE_STEMS.find(([prefix]) => raw.startsWith(prefix));
    out.push(stem ? stem[1] : raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * Does a page title fit one approved buyer role phrase? Deterministic token overlap, case-insensitive:
 * - both sides are folded (abbreviations, "Vice President" -> vp, "Chief Operating Officer" -> coo + operations,
 *   word stems: "operational" -> operations);
 * - when the role names a function (any word that is not a rank or filler word, e.g. "operations",
 *   "warehouse", "logistics"), the title must share at least one of those function words;
 * - when the role is rank only ("CEO", "Founder", "VP"), the title must share one of its rank words.
 */
export function titleMatchesRole(title: string, role: string): boolean {
  const roleTokens = titleTokens(role);
  const titleSet = new Set(titleTokens(title));
  if (roleTokens.length === 0 || titleSet.size === 0) return false;
  const functions = roleTokens.filter((t) => !TITLE_RANK_WORDS.has(t));
  if (functions.length > 0) return functions.some((t) => titleSet.has(t));
  const ranks = roleTokens.filter((t) => !["of", "the", "and", "for", "at", "in", "to", "a", "an", "on", "with", "s"].includes(t));
  return ranks.some((t) => titleSet.has(t));
}

/** The first approved role the title fits, or undefined. */
export function matchedBuyerRole(title: string, buyerRoles: readonly string[]): string | undefined {
  return buyerRoles.find((role) => titleMatchesRole(title, role));
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "sir", "dame"]);

/** Post-nominals and suffixes that trail a name ("Neil Midgley FCILT", "Pat Lee, MBA", "Sam Ray Jr."): not part of the person's name. */
const POST_NOMINALS = new Set([
  "jr", "sr", "ii", "iii", "iv", "mba", "phd", "cpa", "esq", "dba", "msc", "bsc", "mbe", "obe", "cbe", "cfa", "cma",
  "fcilt", "mcilt", "cmilt", "cilt", "cips", "mcips", "fcips", "cpsm", "cscp", "cpim", "cltd", "cwlp", "pmp", "fca", "aca", "fcca", "fcmi",
]);

/** Trailing post-nominal tokens dropped, leaving at least two tokens. Explicit list only: an all-caps trailing token can be a real surname ("Anna SMITH"). */
function dropPostNominals(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 2) {
    const last = out[out.length - 1]!;
    const bare = last.replace(/\./g, "").toLowerCase();
    if (!POST_NOMINALS.has(bare)) break;
    out.pop();
  }
  return out;
}

/** A person's name as tokens (honorifics and trailing post-nominals dropped). Fewer than 2 tokens is not a checkable full name. */
export function personNameTokens(name: string): string[] {
  return dropPostNominals(
    name
      .normalize("NFC")
      .split(/[^\p{L}\p{N}'’-]+/u)
      .map((t) => t.replace(/^['’-]+|['’-]+$/g, ""))
      .filter((t) => t.length > 0 && !HONORIFICS.has(t.toLowerCase().replace(/\.$/, ""))),
  );
}

const NAME_PARTICLES = new Set(["van", "von", "de", "del", "della", "der", "den", "di", "da", "du", "la", "le", "bin", "ibn", "al", "el"]);

/** Title-case a name that arrived all lowercase or all uppercase: "kurt cuncannan" -> "Kurt Cuncannan", "o'brien" -> "O'Brien". Mixed-case input is returned as is. */
export function properCaseName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word, i) => {
      if (i > 0 && NAME_PARTICLES.has(word)) return word;
      const cased = word.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
      return cased.replace(/^Mc(\p{L})/u, (_m, ch: string) => `Mc${ch.toUpperCase()}`);
    })
    .join(" ");
}

/** Raw [start, end) spans where the full name appears (word-bounded, case-insensitive; one middle initial allowed). */
export function personNameSpans(name: string, text: string): Array<[number, number]> {
  const tokens = personNameTokens(name);
  if (tokens.length < 2) return [];
  const body = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(?:\\s+\\p{L}\\.?)?\\s+");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
  const out: Array<[number, number]> = [];
  for (const m of text.normalize("NFC").matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Raw [start, end) spans of `phrase` in `text`, matched on letters and digits only (case, punctuation and spacing ignored). */
function strippedSpans(phrase: string, text: string): Array<[number, number]> {
  const needle = phrase.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!needle) return [];
  let stream = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const folded = text[i]!.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    for (const ch of folded) {
      stream += ch;
      at.push(i);
    }
  }
  const out: Array<[number, number]> = [];
  for (let hit = stream.indexOf(needle); hit >= 0; hit = stream.indexOf(needle, hit + 1)) {
    out.push([at[hit]!, at[hit + needle.length - 1]! + 1]);
  }
  return out;
}

/** Max characters between the name and the title on the page; further apart, the title may be someone else's. */
export const CONTACT_PROXIMITY = 200;
/** Page text window the contact gate reads (the contact page search asks for up to this much). */
export const CONTACT_PAGE_TEXT_MAX = 20_000;

export type ContactCheckInput = {
  name: string;
  /** The accepted lead's company. */
  company: string;
  /** The title phrase as the page writes it (from the page summariser); verified here, never trusted. */
  title_quote?: string;
};

export type ContactPage = {
  url: string;
  text?: string;
  /** Exa's `publishedDate` for the result, if any. */
  publishedDate?: string;
};

export type ContactVerdict =
  | {
      ok: true;
      tier: "verified";
      role: string;
      evidence: ContactEvidence;
      /** The name as the evidence page writes it (title-cased only when the page has it all lower/upper case). */
      name: string;
    }
  | {
      ok: false;
      tier: "inferred" | "rejected";
      code: ContactGateCode;
      reason: string;
      /** `contact_stale` only: the title the old page gave and when it was written (the person is not shown as verified). */
      stale?: { role: string; title_quote: string; published: string; url: string };
      /** `contact_role_changed` only: the approved role the page names as FORMER, and the phrase that says so. */
      changed?: { role: string; title_quote: string; marker: string; url: string };
    };

/**
 * Phrases that make a matched title NOT current (FAILURES #30): "stepping up from his previous role as COO",
 * "former COO", "retired", "until 2024". Deliberately narrow: "previously" alone is common in a current
 * executive's bio ("Previously, Troy led ...") and must not flag it.
 */
const FORMER_ROLE_PATTERNS: RegExp[] = [
  /\bformer(?:ly)?\b/i,
  /\bprevious(?:ly)?\s+(?:role|position|title|post|job)\b/i,
  /\bprior\s+(?:role|position|title|post)\b/i,
  /\bstepp(?:ing|ed|s)\s+(?:up|down|aside)\b/i,
  /\bmov(?:ing|ed)\s+(?:up\s+)?from\b/i,
  /\bpromoted\s+from\b/i,
  /\boutgoing\b/i,
  /\bretir(?:ed|ing|es|ement)\b/i,
  /\bsucceeded\s+by\b/i,
  /\bex-[a-z]/i,
  /\buntil\s+(?:(?:early|late|mid)[-\s])?(?:[A-Za-z]+\s+)?(?:19|20)\d{2}\b/i,
  /\bwas\s+(?:the\s+|our\s+|a\s+)?(?:chief|vice|vp\b|svp\b|director|head\b|managing|general\s+manager|president|coo\b|ceo\b|cfo\b)/i,
  /[,–—-]\s*now\s+(?:the\s+)?[A-Z]/,
];

/** Characters read on each side of the title when looking for a former-role phrase (bounded by the paragraph). */
export const CONTACT_FORMER_WINDOW = 160;

/** The earliest former-role match in `text` (earliest position, not first pattern in the list). */
function firstFormerMatch(text: string): RegExpExecArray | undefined {
  let best: RegExpExecArray | undefined;
  for (const re of FORMER_ROLE_PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = m;
  }
  return best;
}

/** The former-role phrase in `text`, if any. `surname` makes "succeeds <name>" count (the named person is the one replaced). */
export function formerRoleMarker(text: string, surname?: string): string | undefined {
  const first = firstFormerMatch(text);
  if (first) return first[0].trim();
  if (surname) {
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\bsucceed(?:s|ed)\\s+(?:\\S+\\s+){0,3}${escaped}\\b`, "i").exec(text);
    if (m) return m[0].trim();
  }
  return undefined;
}

/** The former-role phrase within CONTACT_FORMER_WINDOW characters of [start, end), not crossing a paragraph or heading break. */
export function formerRoleNear(text: string, start: number, end: number, surname?: string): string | undefined {
  let from = Math.max(0, start - CONTACT_FORMER_WINDOW);
  let to = Math.min(text.length, end + CONTACT_FORMER_WINDOW);
  const before = text.slice(from, start);
  const breakBefore = Math.max(before.lastIndexOf("\n\n"), before.search(/\n#{1,6}\s[^\n]*$/));
  if (breakBefore >= 0) from += breakBefore;
  const after = text.slice(end, to);
  const breakAfter = after.search(/\n\s*\n|\n#{1,6}\s/);
  if (breakAfter >= 0) to = end + breakAfter;
  return formerRoleMarker(text.slice(from, to), surname);
}

/**
 * Is this person a verified contact on this page? Verified needs all of:
 * 1. a page with its text captured that is not LinkedIn, a LinkedIn copy or a people-data aggregator;
 * 2. the page is the company's own registrable domain, OR a press/news page: not shaped like a profile or
 *    directory (isAggregatorShapedUrl), naming the company, with at least CONTACT_MIN_PROSE_CHARS of prose
 *    around the name and title (aggregators are field lists; the domain list can never be complete);
 * 3. a title quote of at most 120 characters;
 * 4. the full name, and the title quote verbatim (quoteMatch), both on the page text,
 *    the title within CONTACT_PROXIMITY characters of the name;
 * 5. the title fits an approved buyer role (titleMatchesRole).
 * 6. recency: a press/news page older than CONTACT_MAX_PAGE_AGE_MONTHS (Exa `publishedDate`, else a date
 *    written near the quote; no date = no age rule) verifies only with `ctx.currentInIndex` (the people index
 *    lists the same person in a current approved role at the company). Otherwise `contact_stale` (inferred),
 *    carrying `stale` so the caller can say "last confirmed <year>". Company-domain pages have no age rule.
 *    The evidence records the page date when one is known.
 * 7. the title is current: a former-role phrase ("previous role", "former", "stepping up from", "retired",
 *    "until 2024", "was COO", ...) in the quote or within CONTACT_FORMER_WINDOW characters of the title (inside its
 *    paragraph) makes the matched role not current. A quote that splits on such a phrase is judged on the part
 *    before it (the new title); if that fits no role the verdict is `contact_role_changed` (inferred, `changed`).
 * Failing 1-3 is `contact_unverified` (tier inferred: nothing on the page contradicts the person);
 * failing 4 is `contact_quote_not_in_page` and 5 is `contact_role_mismatch` (tier rejected).
 */
export function checkContact(
  contact: ContactCheckInput,
  ctx: { page?: ContactPage; buyerRoles: readonly string[]; companyUrl?: string; currentInIndex?: boolean; now?: Date },
): ContactVerdict {
  const inferred = (reason: string): ContactVerdict => ({ ok: false, tier: "inferred", code: "contact_unverified", reason });
  const notInPage = (reason: string): ContactVerdict => ({ ok: false, tier: "rejected", code: "contact_quote_not_in_page", reason });
  const page = ctx.page;
  if (!page || !/^https?:\/\//i.test(page.url) || !safeDomain(page.url)) return inferred("no page other than a profile names this person");
  if (isContactNonEvidenceUrl(page.url)) return inferred(`${safeDomain(page.url)} is LinkedIn or a people-data site, not evidence`);
  const text = (page.text ?? "").slice(0, CONTACT_PAGE_TEXT_MAX).normalize("NFC");
  if (!text.trim()) return inferred("the page text was not captured");
  const now = ctx.now ?? new Date();
  const pageDomain = registrableDomain(page.url);
  const ownDomain = pageDomain !== undefined && pageDomain === registrableDomain(ctx.companyUrl);
  if (!ownDomain && isAggregatorShapedUrl(page.url)) return inferred(`${safeDomain(page.url)} is not the company's site and the URL looks like a profile or directory page, not press`);
  if (!ownDomain && mentionOffsets(contact.company, text, 1).length === 0) return inferred(`the page does not name ${contact.company}`);
  const title = (contact.title_quote ?? "").replace(/\s+/g, " ").trim();
  if (!title) return inferred("the page gives no title for this person");
  if (title.length > CONTACT_TITLE_MAX) return notInPage(`the title quote is ${title.length} characters; the limit is ${CONTACT_TITLE_MAX}`);
  if (personNameTokens(contact.name).length < 2) return notInPage("a full name (first and last) is needed to check the page");
  const names = personNameSpans(contact.name, text);
  if (names.length === 0) return notInPage("the name is not on the page");
  if (!quoteMatch(title, text, { minSegment: 2, minTotal: 2 }).ok) return notInPage("the title is not on the page");
  let titles = strippedSpans(title, text);
  if (titles.length === 0) {
    // quoteMatch accepted it clause by clause; anchor on the longest clause.
    const longest = title.split(/[,;:|·–—]/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0] ?? "";
    titles = strippedSpans(longest, text);
  }
  let best: { gap: number; start: number; end: number; nameStart: number; nameEnd: number } | undefined;
  for (const [ns, ne] of names) {
    for (const [ts, te] of titles) {
      const gap = Math.max(0, Math.max(ns, ts) - Math.min(ne, te));
      if (!best || gap < best.gap) best = { gap, start: Math.min(ns, ts), end: Math.max(ne, te), nameStart: ns, nameEnd: ne };
    }
  }
  if (!best || best.gap > CONTACT_PROXIMITY) return notInPage("the title is not next to the name on the page");
  if (!ownDomain && proseCharsAround(text, best.start, best.end) < CONTACT_MIN_PROSE_CHARS) {
    return inferred(`${safeDomain(page.url)} is not the company's site and the page has under ${CONTACT_MIN_PROSE_CHARS} characters of prose around the name: a field list, not press`);
  }
  // Former roles are not current (FAILURES #30). A phrase in the title quote that splits it ("Managing Director,
  // stepping up from his previous role as COO"): the part before it is the person's NEW title and must fit a role
  // itself; otherwise the fitting part is the old one and the contact is "role changed", never verified.
  const surname = personNameTokens(contact.name).slice(-1)[0];
  const titleMarker = firstFormerMatch(title);
  let roleTitle = title;
  let role: string | undefined;
  let formerPhrase: string | undefined;
  if (titleMarker) {
    const head = title.slice(0, titleMarker.index).replace(/[\s,;:–—-]+$/, "").trim();
    const headRole = head ? matchedBuyerRole(head, ctx.buyerRoles) : undefined;
    if (headRole) {
      role = headRole;
      roleTitle = head;
    } else {
      role = matchedBuyerRole(title, ctx.buyerRoles);
      formerPhrase = titleMarker[0].trim();
    }
  } else {
    role = matchedBuyerRole(title, ctx.buyerRoles);
    if (role) formerPhrase = formerRoleNear(text, best.start, best.end, surname);
  }
  if (!role) return { ok: false, tier: "rejected", code: "contact_role_mismatch", reason: `the title "${title}" fits none of the approved roles` };
  if (formerPhrase) {
    return {
      ok: false,
      tier: "inferred",
      code: "contact_role_changed",
      reason: `the page says "${formerPhrase}" next to the title: the role is no longer current`,
      changed: { role, title_quote: title, marker: formerPhrase, url: page.url },
    };
  }
  const published = normalizePageDate(page.publishedDate, now) ?? dateNearSpan(text, best.start, best.end, now);
  const evidence = contactEvidence({ url: page.url, quote: text.slice(best.start, best.end), title_quote: roleTitle, ...(published ? { published } : {}) });
  if (!evidence) return notInPage("the name and title span is too long to quote");
  if (!ownDomain && published && monthsSince(published, now) > CONTACT_MAX_PAGE_AGE_MONTHS && !ctx.currentInIndex) {
    return {
      ok: false,
      tier: "inferred",
      code: "contact_stale",
      reason: `the page is from ${published}, over ${CONTACT_MAX_PAGE_AGE_MONTHS} months old, and the people index does not list this person in a current approved role`,
      stale: { role, title_quote: roleTitle, published, url: page.url },
    };
  }
  const onPage = text.slice(best.nameStart, best.nameEnd).replace(/\s+/g, " ").trim();
  return { ok: true, tier: "verified", role, evidence, name: onPage ? properCaseName(onPage) : properCaseName(contact.name) };
}
