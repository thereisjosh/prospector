import { getIcpConfig, ICP_1, monthsAgoIso, parseSearchType } from "./config";
import {
  exaSearch,
  lookupCompany,
  SIGNAL_SCHEMA,
  type ExaCredentials,
} from "./exa";
import {
  parseSignalSummary,
  scoreAndRank,
  selectCompaniesForEnrichment,
} from "./score";
import { normalizeName } from "./eval";
import type {
  ExaCostDollars,
  ExaSearchType,
  IcpConfig,
  IcpId,
  ProspectRow,
} from "./types";

export type ProspectRun = {
  rows: ProspectRow[];
  totalCostDollars: number;
  startPublishedDate: string;
  icp: IcpConfig;
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
  return runProspecting(ICP_1, options);
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
    now?: Date;
  },
): Promise<{ rows: ProspectRow[]; costDollars: number }> {
  const run = await runProspecting(getIcpConfig(icpId), {
    type: parseSearchType(options.type),
    numResults: options.numResults ?? 12,
    maxCandidates: options.maxCandidates ?? 12,
    signalQuery: options.signalQuery,
    now: options.now,
    credentials: options.exaKey ? { apiKey: options.exaKey } : undefined,
  });

  return {
    rows: run.rows,
    costDollars: run.totalCostDollars,
  };
}

export async function runProspecting(
  icp: IcpConfig,
  options: {
    type: ExaSearchType;
    numResults?: number;
    maxCandidates?: number;
    signalQuery?: string;
    now?: Date;
    enrichmentCache?: EnrichmentCache;
    credentials?: ExaCredentials;
  },
): Promise<ProspectRun> {
  const now = options.now ?? new Date();
  const startPublishedDate = monthsAgoIso(icp.months, now);
  const numResults = options.numResults ?? 50;
  const signalQueries = options.signalQuery?.trim()
    ? [options.signalQuery.trim()]
    : icp.signalQueries;
  let totalCostDollars = 0;
  const signalResponses = await Promise.all(
    signalQueries.map((query) =>
      exaSearch({
        query,
        type: options.type,
        startPublishedDate,
        numResults,
        contents: {
          text: { maxCharacters: 500 },
          highlights: { query, numSentences: 2 },
          summary: {
            query: icp.summaryQuery,
            schema: SIGNAL_SCHEMA,
          },
          livecrawl: "fallback",
        },
      }, options.credentials),
    ),
  );

  for (const response of signalResponses) {
    totalCostDollars += costTotal(response.costDollars);
  }

  const candidates = signalResponses.flatMap((response) =>
    response.results.map((result) => ({
      result,
      summary: parseSignalSummary(result.summary, result),
    })),
  );

  const companiesToEnrich = selectCompaniesForEnrichment(
    icp,
    candidates,
    startPublishedDate,
    now,
    options.maxCandidates ?? icp.enrichmentLimit,
  );
  const cache = options.enrichmentCache ?? new Map();
  const companyMap = new Map<string, Awaited<ReturnType<typeof lookupCompany>>>();

  const lookups = await Promise.all(companiesToEnrich.map(async (company) => {
    const key = normalizeName(company);
    const cached = cache.get(key);
    if (cached) {
      return { key, lookup: cached, fromCache: true };
    }
    const lookup = await lookupCompany(
      company,
      icp.companySummaryQuery,
      options.credentials,
    );
    return { key, lookup, fromCache: false };
  }));

  for (const { key, lookup, fromCache } of lookups) {
    if (!fromCache) totalCostDollars += costTotal(lookup.costDollars);
    cache.set(key, lookup);
    companyMap.set(key, lookup);
  }

  const opsHiringCandidates = [];
  if (icp.id === 3) {
    const opsResponses = await Promise.all(companiesToEnrich.map(async (company) => {
      const query = `${company} hiring RevOps revenue operations business operations head of operations chief of staff`;
      const response = await exaSearch({
        query,
        type: options.type,
        startPublishedDate,
        numResults: 3,
        contents: {
          text: { maxCharacters: 500 },
          highlights: { query, numSentences: 2 },
          summary: {
            query:
              "whether this company is hiring an operations, business operations, RevOps, revenue operations, chief of staff, or go-to-market operations role; prefer first, founding, or small-team signals; include the date",
            schema: SIGNAL_SCHEMA,
          },
          livecrawl: "fallback",
        },
      }, options.credentials);
      return { company, response };
    }));

    for (const { company, response } of opsResponses) {
      totalCostDollars += costTotal(response.costDollars);
      opsHiringCandidates.push(
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

  const enrichedCandidates = [...candidates, ...opsHiringCandidates].map((candidate) => {
    const companyName = normalizeName(candidate.summary.company_name);
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

  return {
    rows: scoreAndRank(icp, enrichedCandidates, startPublishedDate, now).slice(0, 15),
    totalCostDollars,
    startPublishedDate,
    icp,
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
