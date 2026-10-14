import { judgeEvidence, signalEvidence, type JudgeEvidence } from "./evidence";
import { netNew } from "./eval";
import {
  checkDate,
  checkIdentity,
  checkLead,
  freshnessScore,
  parseEmployeeEstimate,
  resolveEventDate,
  safeDomain,
  squashName,
  type GateCode,
} from "./gates";
import { normalizeNullish, OTHER_SIGNAL_TYPE, type SearchPlan } from "./plan";
import type {
  CompanySummary,
  ExaResult,
  ProspectRow,
  SignalSummary,
} from "./types";

// Re-exported so existing imports keep working; the implementations live in gates.ts.
export {
  isNonCompanyName,
  nameExcluded,
  parseEmployeeEstimate,
} from "./gates";

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
  /** Company lookups / follow-up searches skipped because the cost guard refused them. */
  skippedLookups: number;
  skippedFollowUps: number;
  /** Where the cost budget stopped the run, e.g. "signal_search:7" or "enrichment:12"; null if it never did. */
  budgetStoppedAt: string | null;
  spentDollars: number;
  /** Rejection counts keyed by reason: excludeDomains, excludeNames, no_enrichment,
   * enterprise, hq, unknown_size, size, entity_mismatch, required_gate:<key>, weak_why_now. */
  rejections: Record<string, number>;
  finalRows: number;
};

/**
 * `evidence` (optional; set by the caller that wants it, e.g. runProspecting): per accepted row,
 * keyed by `rowEvidenceKey(company, signal_url)`, the evidence the gate accepted it on, for the
 * lead judge (src/evidence.ts). Kept off ProspectRow so the API rows do not carry page text.
 */
export type Trace = { funnel: Funnel; rejected: Rejection[]; evidence?: Map<string, JudgeEvidence> };

export function rowEvidenceKey(company: string, signalUrl: string): string {
  return `${company}\u0000${signalUrl}`;
}

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
      skippedLookups: 0,
      skippedFollowUps: 0,
      budgetStoppedAt: null,
      spentDollars: 0,
      rejections: {},
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
    return {
      company_name: str(raw.company_name) ?? extractCompanyName(fallback),
      signal_type: str(raw.signal_type) ?? OTHER_SIGNAL_TYPE,
      signal_summary: str(raw.signal_summary) ?? fallback.title ?? "",
      signal_date: str(raw.signal_date) ?? "",
      ...(str(raw.signal_quote) ? { signal_quote: str(raw.signal_quote) } : {}),
      ...(str(raw.signal_date_quote) ? { signal_date_quote: str(raw.signal_date_quote) } : {}),
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
 * Rank companies for enrichment (best first), before any lookup is paid for:
 * signal strength + freshness only.
 */
export function rankCompaniesForEnrichment(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now = new Date(),
): string[] {
  return aggregateCandidates(plan, candidates, startIso, now)
    .map((group) => ({ group, score: preliminaryScore(plan, group, startIso, now) }))
    .sort((a, b) => b.score - a.score)
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

/** Resolve a candidate's EVENT date (see gates.resolveEventDate). */
export function resolveCandidateDate(candidate: Candidate, now: Date) {
  return resolveEventDate(signalDates(candidate), now);
}

/** The resolved event date (ISO) or "" if unparseable/implausible. */
export function eventDate(candidate: Candidate, now: Date = new Date()): string {
  return resolveEventDate(signalDates(candidate), now).date;
}

function signalDates(candidate: Candidate) {
  return {
    signal_date: candidate.summary.signal_date,
    publishedDate: candidate.result.publishedDate,
  };
}

function aggregateCandidates(
  plan: SearchPlan,
  candidates: Candidate[],
  startIso: string,
  now: Date,
  trace?: Trace,
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();

  for (const candidate of candidates) {
    const url = candidate.result.url;
    if (isRejectedSourceUrl(url)) continue;
    const company = cleanCompanyName(
      candidate.summary.company_name || extractCompanyName(candidate.result),
    );
    const key = squashName(company);
    if (!key) continue;

    // Same gates the agent harness runs, applied before any lookup is paid for.
    const identity = checkIdentity(plan, company, url);
    if (identity) {
      reject(trace, [funnelCode(identity.code)], company, url, `${funnelCode(identity.code)}: ${identity.reason}`);
      continue;
    }
    const date = checkDate(plan, signalDates(candidate), now);
    if (!date.ok) {
      if (trace) trace.funnel.droppedStaleOrUnparseableDate += 1;
      reject(trace, [], company, url, `${date.code}: ${date.reason}`);
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
  const ranked = [...group.candidates].sort(
    (a, b) => candidateStrength(plan, b) - candidateStrength(plan, a),
  );
  const company = group.company;
  const enrichment = group.companyEnrichment;

  // The strongest candidate that passes every gate becomes the row's evidence.
  let best: Candidate | undefined;
  let details: Extract<ReturnType<typeof checkLead>, { ok: true }>["details"] | undefined;
  let firstFailure: Extract<ReturnType<typeof checkLead>, { ok: false }> | undefined;
  for (const candidate of ranked) {
    const verdict = checkLead(plan, {
      company,
      signal: {
        url: candidate.result.url,
        title: candidate.result.title,
        text: [candidate.result.text, candidate.result.highlights?.join(" ")].filter(Boolean).join(" "),
        summary: candidate.summary,
        publishedDate: candidate.result.publishedDate,
      },
      enrichment: enrichment?.summary,
      companyUrl: enrichment?.result?.url,
      lookupText: enrichment?.result?.text,
      now,
    });
    if (verdict.ok) {
      best = candidate;
      details = verdict.details;
      break;
    }
    firstFailure ??= verdict;
  }
  if (!best || !details) {
    const failure = firstFailure!;
    const code = funnelCode(failure.code);
    reject(trace, [code], company, ranked[0]!.result.url, `Excluded: ${failure.reason}.`);
    return undefined;
  }

  const { result, summary } = best;
  const aggregateCount = distinctSignalCount(group.candidates);
  if (isWeakWhyNow(summary.signal_summary) && aggregateCount < 2) {
    reject(trace, ["weak_why_now"], company, result.url, "weak_why_now: summary has no explicit signal");
    return undefined;
  }

  const strength = groupStrength(plan, group.candidates, aggregateCount);
  const confidence = clamp(details.multiplier * strength.score);
  const whyNow =
    isWeakWhyNow(summary.signal_summary) && aggregateCount >= 2
      ? `${company} has ${aggregateCount} distinct recent signals; strongest dated source is ${result.title ?? result.url}.`
      : summary.signal_summary || result.title || "";

  trace?.evidence?.set(
    rowEvidenceKey(company, result.url),
    judgeEvidence({
      // Exactly the haystack checkLead read above (text + highlights).
      signal: signalEvidence({ title: result.title, publishedDate: result.publishedDate, text: [result.text, result.highlights?.join(" ")].filter(Boolean).join(" ") }, company, whyNow),
      enrichment: enrichment?.summary,
      details,
    }),
  );

  return {
    company,
    one_liner: oneLiner(company, enrichment, strength.label),
    fit_reason: details.fit_reason,
    why_now_signal: whyNow,
    signal_strength: strength.label,
    signal_source_url: result.url,
    signal_date: details.event_date,
    date_source: details.date_source,
    confidence_score: round(confidence),
    freshness_score: round(freshnessScore(details.event_date, startIso, now)),
    net_new: netNew(company, plan.excludeNames),
  };
}

/** Gate codes -> the funnel rejection keys used since the first recorded runs. */
function funnelCode(code: GateCode): string {
  if (code === "exclude_name") return "excludeNames";
  if (code === "exclude_domain") return "excludeDomains";
  return code;
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

function dedupeKey(url: string, companyKey: string): string {
  const domain = safeDomain(url) ?? companyKey;
  return isAggregatorDomain(domain) ? `${domain}:${companyKey}` : domain;
}

function distinctSignalCount(candidates: Candidate[]): number {
  return new Set(
    candidates.map((candidate) =>
      dedupeKey(candidate.result.url, squashName(candidate.summary.company_name)),
    ),
  ).size;
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
