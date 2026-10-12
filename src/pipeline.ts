import { monthsAgoIso, parseSearchType } from "./config";
import {
  BudgetExceededError,
  CostGuard,
  COST_ESTIMATE,
  estimateExaCost,
  exaSearch,
  lookupCompany,
  ReplayMissError,
  type ExaCredentials,
} from "./exa";
import {
  buildCompanySchema,
  buildSignalSchema,
  composeCompanySummaryQuery,
  composeSignalSummaryQuery,
  type SearchPlan,
} from "./plan";
import {
  createTrace,
  parseSignalSummary,
  rankCompaniesForEnrichment,
  scoreAndRank,
  type Funnel,
  type Rejection,
} from "./score";
import { squashName } from "./gates";
import { getV1Plan } from "../eval/fixtures/v1-plans";
import type {
  ExaCostDollars,
  ExaSearchType,
  IcpId,
  ProspectRow,
} from "./types";

/** Hard ceiling on companies enriched per run, regardless of budget. */
export const MAX_ENRICHED_COMPANIES = 60;
export const DEFAULT_MAX_COST_DOLLARS = 0.6;

export type ProspectRun = {
  rows: ProspectRow[];
  totalCostDollars: number;
  startPublishedDate: string;
  plan: SearchPlan;
  funnel: Funnel;
  rejected: Rejection[];
  /** Companies enriched, in rank order. */
  enriched: string[];
  /** Full ranked enrichment queue (before the budget cut). */
  enrichmentQueue: string[];
};

export type EnrichmentCache = Map<
  string,
  Awaited<ReturnType<typeof lookupCompany>>
>;

export async function runIcp1Prospecting(options: {
  type: ExaSearchType;
  numResults?: number;
  now?: Date;
  credentials?: ExaCredentials;
}): Promise<ProspectRun> {
  return runProspecting(getV1Plan(1), options);
}

export async function runProspect(
  icpId: IcpId,
  options: {
    /** Omit to fall back to the server-side EXA_API_KEY (see src/exa.ts). */
    exaKey?: string;
    signalQuery?: string;
    type?: ExaSearchType;
    numResults?: number;
    maxCandidates?: number;
    maxCostDollars?: number;
    now?: Date;
  },
): Promise<{
  rows: ProspectRow[];
  costDollars: number;
  funnel: Funnel;
  rejected: Rejection[];
}> {
  const run = await runProspecting(getV1Plan(icpId), {
    type: parseSearchType(options.type),
    numResults: options.numResults ?? 12,
    maxCandidates: options.maxCandidates,
    maxCostDollars: options.maxCostDollars,
    signalQuery: options.signalQuery,
    now: options.now,
    credentials: options.exaKey ? { apiKey: options.exaKey } : undefined,
  });

  return {
    rows: run.rows,
    costDollars: run.totalCostDollars,
    funnel: run.funnel,
    rejected: run.rejected,
  };
}

/** Max concurrent enrichment lookups / follow-up searches; reservations still happen in ranked order. */
const ENRICHMENT_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight, starting them in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function runProspecting(
  plan: SearchPlan,
  options: RunOptions,
): Promise<ProspectRun> {
  const spent: { value: number; read?: () => number } = { value: 0 };
  try {
    return await runProspectingInner(plan, options, spent);
  } catch (error) {
    // Attach what was already spent so a harness can record it for a failed run.
    if (error && typeof error === "object") (error as { spendDollars?: number }).spendDollars = spent.read?.() ?? spent.value;
    throw error;
  }
}

type RunOptions = {
    type: ExaSearchType;
    numResults?: number;
    /** Optional extra cap on companies enriched (the budget and MAX_ENRICHED_COMPANIES still apply). */
    maxCandidates?: number;
    /** Hard per-run spend cap, enforced in exaSearch. Default $0.60. */
    maxCostDollars?: number;
    /** Eval-script only: treat a replay miss on a company lookup as "no enrichment". */
    lenientReplay?: boolean;
    signalQuery?: string;
    now?: Date;
    enrichmentCache?: EnrichmentCache;
    credentials?: ExaCredentials;
};

async function runProspectingInner(
  plan: SearchPlan,
  options: RunOptions,
  spent: { value: number; read?: () => number },
): Promise<ProspectRun> {
  const now = options.now ?? new Date();
  const startPublishedDate = monthsAgoIso(plan.months, now);
  const numResults = options.numResults ?? 50;
  const signalQueries = options.signalQuery?.trim()
    ? [options.signalQuery.trim()]
    : plan.signalQueries;
  const guard = new CostGuard(options.maxCostDollars ?? DEFAULT_MAX_COST_DOLLARS);
  const signalSchema = buildSignalSchema(plan);
  const companySchema = buildCompanySchema(plan);
  const signalSummaryQuery = composeSignalSummaryQuery(plan, plan.signalSummaryQuery);
  let totalCostDollars = 0;
  const trace = createTrace();
  const spentSoFar = () => Math.max(guard.spent, totalCostDollars);
  spent.read = spentSoFar;

  // Requests are reserved against the cap synchronously, in query order, so a
  // refused query never blocks the ones before it.
  const skippedSignalQueries: number[] = [];
  const signalResponses = (
    await Promise.all(
      signalQueries.map((query, index) =>
        exaSearch({
          query,
          type: options.type,
          startPublishedDate,
          numResults,
          ...(plan.excludeDomains.length > 0
            ? { excludeDomains: plan.excludeDomains }
            : {}),
          contents: {
            text: { maxCharacters: 500 },
            highlights: { query, numSentences: 2 },
            summary: { query: signalSummaryQuery, schema: signalSchema },
            livecrawl: "fallback",
          },
        }, options.credentials, guard).catch((error: unknown) => {
          if (error instanceof BudgetExceededError) {
            skippedSignalQueries.push(index);
            return undefined;
          }
          throw error;
        }),
      ),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== undefined);
  if (skippedSignalQueries.length > 0) {
    trace.funnel.budgetStoppedAt = `signal_search:${Math.min(...skippedSignalQueries)}`;
  }

  for (const response of signalResponses) {
    totalCostDollars += costTotal(response.costDollars);
  }
  spent.value = spentSoFar();

  const candidates = signalResponses.flatMap((response) =>
    response.results.map((result) => ({
      result,
      summary: parseSignalSummary(result.summary, result),
    })),
  );

  trace.funnel.rawSignalResults = candidates.length;
  trace.funnel.withCompanyName = candidates.filter((c) => c.summary.company_name.trim()).length;

  const queue = rankCompaniesForEnrichment(plan, candidates, startPublishedDate, now);
  const hardCap = Math.min(MAX_ENRICHED_COMPANIES, options.maxCandidates ?? MAX_ENRICHED_COMPANIES);
  const followUpCost = plan.followUp
    ? estimateExaCost({ numResults: 3, contents: { summary: true } })
    : 0;
  const preCache = options.enrichmentCache ?? new Map();
  const companiesToEnrich: string[] = [];
  let planned = 0;
  for (const company of queue) {
    if (companiesToEnrich.length >= hardCap) break;
    const cost =
      (preCache.has(squashName(company)) ? 0 : COST_ESTIMATE.companyLookup) + followUpCost;
    if (planned + cost > guard.remaining + 1e-9) {
      trace.funnel.budgetStoppedAt ??= `enrichment:${companiesToEnrich.length}`;
      break;
    }
    planned += cost;
    companiesToEnrich.push(company);
  }
  trace.funnel.selectedForEnrichment = companiesToEnrich.length;
  trace.funnel.cutByEnrichmentLimit = queue.length - companiesToEnrich.length;

  const cache = preCache;
  const companyMap = new Map<string, Awaited<ReturnType<typeof lookupCompany>>>();
  const companySummaryQuery = composeCompanySummaryQuery(plan);

  const lookups = await mapLimit(companiesToEnrich, ENRICHMENT_CONCURRENCY, async (company, index) => {
    const key = squashName(company);
    const cached = cache.get(key);
    if (cached) {
      return { key, lookup: cached, fromCache: true };
    }
    try {
      const lookup = await lookupCompany(
        company,
        companySummaryQuery,
        companySchema,
        options.credentials,
        guard,
      );
      return { key, lookup, fromCache: false };
    } catch (error) {
      if (options.lenientReplay && error instanceof ReplayMissError) {
        trace.funnel.replayMiss += 1;
        return { key, lookup: undefined, fromCache: false };
      }
      if (error instanceof BudgetExceededError) {
        // Out of budget: skip this lookup and keep going with what we have.
        trace.funnel.skippedLookups += 1;
        trace.funnel.budgetStoppedAt ??= `enrichment:${index}`;
        return { key, lookup: undefined, fromCache: false };
      }
      throw error;
    }
  });

  for (const { key, lookup, fromCache } of lookups) {
    if (!lookup) continue;
    if (!fromCache) {
      totalCostDollars += costTotal(lookup.costDollars);
      spent.value = spentSoFar();
    }
    cache.set(key, lookup);
    companyMap.set(key, lookup);
    if (!lookup.result) trace.funnel.enrichmentNoResult += 1;
  }

  const followUpCandidates = [];
  if (plan.followUp) {
    const followUp = plan.followUp;
    const followUpSummaryQuery = composeSignalSummaryQuery(plan, followUp.summaryQuery);
    // Reserved in ranked order (best candidates first); once the guard refuses, the rest are skipped.
    let budgetHit = false;
    const followUpResponses = await mapLimit(companiesToEnrich, ENRICHMENT_CONCURRENCY, async (company, index) => {
      if (budgetHit) {
        trace.funnel.skippedFollowUps += 1;
        return { company, response: undefined };
      }
      const query = followUp.queryTemplate.split("{company}").join(company);
      try {
        const response = await exaSearch({
          query,
          type: options.type,
          startPublishedDate,
          numResults: 3,
          contents: {
            text: { maxCharacters: 500 },
            highlights: { query, numSentences: 2 },
            summary: { query: followUpSummaryQuery, schema: signalSchema },
            livecrawl: "fallback",
          },
        }, options.credentials, guard);
        return { company, response };
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          budgetHit = true;
          trace.funnel.skippedFollowUps += 1;
          trace.funnel.budgetStoppedAt ??= `follow_up:${index}`;
          return { company, response: undefined };
        }
        throw error;
      }
    });

    for (const { company, response } of followUpResponses) {
      if (!response) continue;
      totalCostDollars += costTotal(response.costDollars);
      spent.value = spentSoFar();
      followUpCandidates.push(
        ...response.results.map((result) => {
          const summary = parseSignalSummary(result.summary, result);
          return {
            result,
            summary: {
              ...summary,
              company_name: company,
            },
          };
        }),
      );
    }
  }

  const enrichedCandidates = [...candidates, ...followUpCandidates].map((candidate) => {
    const companyName = squashName(candidate.summary.company_name);
    const lookup = companyMap.get(companyName);
    return lookup
      ? {
          ...candidate,
          company: {
            result: lookup.result,
            summary: lookup.summary,
          },
        }
      : candidate;
  });

  const rows = scoreAndRank(plan, enrichedCandidates, startPublishedDate, now, trace).slice(0, 15);
  trace.funnel.finalRows = rows.length;
  trace.funnel.spentDollars = Math.round(totalCostDollars * 1e6) / 1e6;

  return {
    rows,
    totalCostDollars,
    startPublishedDate,
    plan,
    funnel: trace.funnel,
    rejected: trace.rejected,
    enriched: companiesToEnrich,
    enrichmentQueue: queue,
  };
}

function costTotal(cost: ExaCostDollars | undefined): number {
  if (!cost) return 0;
  if (typeof cost.total === "number") return cost.total;
  let sum = 0;
  for (const value of Object.values(cost)) {
    if (typeof value === "number") sum += value;
  }
  return sum;
}
