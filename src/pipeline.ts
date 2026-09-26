import { ICP_1, monthsAgoIso } from "./config.js";
import { exaSearch, lookupCompany, SIGNAL_SCHEMA } from "./exa.js";
import {
  parseSignalSummary,
  scoreAndRank,
  selectCompaniesForEnrichment,
} from "./score.js";
import { normalizeName } from "./eval.js";
import type {
  ExaCostDollars,
  ExaSearchType,
  IcpConfig,
  ProspectRow,
} from "./types.js";

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
}): Promise<ProspectRun> {
  return runProspecting(ICP_1, options);
}

export async function runProspecting(
  icp: IcpConfig,
  options: {
    type: ExaSearchType;
    numResults?: number;
    now?: Date;
    enrichmentCache?: EnrichmentCache;
  },
): Promise<ProspectRun> {
  const now = options.now ?? new Date();
  const startPublishedDate = monthsAgoIso(icp.months, now);
  const numResults = options.numResults ?? 50;
  let totalCostDollars = 0;
  const signalResponses = await Promise.all(
    icp.signalQueries.map((query) =>
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
      }),
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
    icp.enrichmentLimit,
  );
  const cache = options.enrichmentCache ?? new Map();
  const companyMap = new Map<string, Awaited<ReturnType<typeof lookupCompany>>>();

  for (const company of companiesToEnrich) {
    const key = normalizeName(company);
    const cached = cache.get(key);
    if (cached) {
      companyMap.set(key, cached);
      continue;
    }
    const lookup = await lookupCompany(company, icp.companySummaryQuery);
    totalCostDollars += costTotal(lookup.costDollars);
    cache.set(key, lookup);
    companyMap.set(key, lookup);
  }

  const opsHiringCandidates = [];
  if (icp.id === 3) {
    for (const company of companiesToEnrich) {
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
      });
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
