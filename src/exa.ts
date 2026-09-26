import { requireEnv } from "./config.js";
import type { CompanySummary, ExaSearchResponse } from "./types.js";

export const SIGNAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    company_name: { type: "string" },
    signal_type: { type: "string" },
    signal_summary: { type: "string" },
    signal_date: { type: "string" },
  },
  required: ["company_name", "signal_type", "signal_summary", "signal_date"],
} as const;

export const COMPANY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    industry: { type: "string" },
    employee_estimate: {
      anyOf: [{ type: "number" }, { type: "string" }],
    },
    is_third_party_logistics: { type: "boolean" },
    is_b2b_saas_or_marketplace: { type: "boolean" },
    is_payments_company_or_psp: { type: "boolean" },
    is_b2b_company: { type: "boolean" },
    recently_funded_seed_or_series_a: { type: "boolean" },
    hiring_first_ops_or_revops: { type: "boolean" },
    is_public_or_enterprise: { type: "boolean" },
    hq: { type: "string" },
  },
  required: [
    "description",
    "industry",
    "employee_estimate",
    "is_third_party_logistics",
    "is_b2b_saas_or_marketplace",
    "is_payments_company_or_psp",
    "is_b2b_company",
    "recently_funded_seed_or_series_a",
    "hiring_first_ops_or_revops",
    "is_public_or_enterprise",
    "hq",
  ],
} as const;

export async function exaSearch(body: Record<string, unknown>) {
  const baseUrl = requireEnv("EXA_BASE_URL");
  const apiKey = requireEnv("EXA_API_KEY");
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  };
  let response = await fetch(`${baseUrl}/search`, request);
  for (let attempt = 0; response.status === 429 && attempt < 3; attempt += 1) {
    await sleep(1000 * (attempt + 1));
    response = await fetch(`${baseUrl}/search`, request);
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Exa returned non-JSON HTTP ${response.status}: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Exa search failed HTTP ${response.status}: ${text}`);
  }

  return json as ExaSearchResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function lookupCompany(companyName: string, summaryQuery: string) {
  const response = await exaSearch({
    query: companyName,
    category: "company",
    numResults: 2,
    contents: {
      summary: {
        query: summaryQuery,
        schema: COMPANY_SCHEMA,
      },
      livecrawl: "fallback",
    },
  });

  return {
    result: response.results[0],
    summary: parseCompanySummary(response.results[0]?.summary),
    costDollars: response.costDollars,
  };
}

function parseCompanySummary(summary: unknown): CompanySummary {
  if (typeof summary === "object" && summary) return summary as CompanySummary;
  if (typeof summary === "string") {
    try {
      const parsed = JSON.parse(summary) as CompanySummary;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { description: summary };
    }
  }
  return {};
}
