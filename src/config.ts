import "dotenv/config";
import type { ExaSearchType, IcpConfig, IcpId } from "./types";

export const VALID_SEARCH_TYPES = new Set<ExaSearchType>([
  "auto",
  "keyword",
  "neural",
  "fast",
  "deep",
]);

export const ENTERPRISE_DENYLIST: readonly string[] = [
  "RXO",
  "XPO",
  "XPO Logistics",
  "GXO",
  "GXO Logistics",
  "C.H. Robinson",
  "J.B. Hunt",
  "DHL",
  "DHL Supply Chain",
  "FedEx",
  "FedEx Logistics",
  "UPS",
  "UPS Supply Chain Solutions",
  "Walmart",
  "ADP",
  "DSV",
  "Kuehne+Nagel",
  "Kuehne + Nagel",
  "DB Schenker",
  "Ryder",
  "Ryder System",
  "Expeditors",
  "Flexport",
  "Uber Freight",
  "Penske",
  "Penske Logistics",
  "GEODIS",
] as const;

export const ICP_CONFIGS = [
  {
  id: 1,
  name: "Logistics ops scaling now",
  months: 3,
  employeeRange: { min: 100, max: 1000, unknownPolicy: "allow-if-not-enterprise" },
  allowedHqCountries: ["US", "UK"],
  signalQueries: [
    "logistics or 3PL company hiring a wave of operations manager roles / opening a new warehouse",
    "third-party logistics provider opening a new warehouse fulfillment center",
    "3PL fulfillment provider announced expansion new warehouse facility",
    "3PL fulfillment company hiring warehouse operations manager",
    "last-mile logistics company hiring operations manager",
    "US 3PL fulfillment provider hiring operations manager multiple warehouse roles",
    "US third party logistics company opens distribution center expansion",
    "regional logistics provider warehouse expansion operations hiring",
  ],
  summaryQuery: "the why-now signal and its date",
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a third-party logistics/3PL, freight, warehousing, fulfillment, last-mile, or logistics operator, whether it is public or enterprise scale, and headquarters.",
  baseline: [
    ...ENTERPRISE_DENYLIST,
  ],
  enrichmentLimit: 15,
},
{
  id: 2,
  name: "B2B SaaS/marketplace launched payments or billing",
  months: 3,
  employeeRange: { min: 100, max: 800, unknownPolicy: "allow-if-not-enterprise" },
  allowedHqCountries: ["US"],
  signalQueries: [
    "B2B SaaS launched embedded payments billing feature",
    "vertical software company launched embedded payments",
    "B2B marketplace launched payments billing monetization",
    "SaaS platform launched usage-based billing monetization",
    "software company hiring billing operations revenue operations",
    "B2B SaaS finance operations executive billing payments",
    "vertical SaaS payments billing launch customers",
    "B2B marketplace expanded seller payments payouts billing",
  ],
  summaryQuery:
    "the payments or billing launch, billing/revenue operations hire, or finance operations executive signal and its date",
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a B2B SaaS or marketplace, whether it is itself a payments company, payment processor, PSP, acquiring bank, or fintech payments infrastructure provider, whether it is public or enterprise scale, and headquarters.",
  baseline: [],
  enrichmentLimit: 15,
},
{
  id: 3,
  name: "Recently funded B2B hiring first Ops/RevOps",
  months: 6,
  employeeRange: { min: 30, max: 200, unknownPolicy: "allow-if-not-enterprise" },
  allowedHqCountries: ["US"],
  signalQueries: [
    "US B2B startup raised seed funding announced",
    "US B2B startup raised Series A funding announced",
    "vertical software startup raises seed funding",
    "B2B SaaS startup raises Series A funding",
    "enterprise software startup seed funding announcement",
  ],
  summaryQuery:
    "the recent seed or Series A funding announcement, company name, funding round, and announcement date",
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a B2B company, whether it recently raised seed or Series A funding, whether it is hiring an operations, business operations, revenue operations, RevOps, chief of staff, or go-to-market operations person, whether that role appears first/founding/small-team, whether it is public or enterprise scale, and headquarters.",
  baseline: [],
  enrichmentLimit: 15,
},
] as const satisfies readonly IcpConfig[];

export const ICP_1 = ICP_CONFIGS[0];

export function getIcpConfig(id: IcpId): IcpConfig {
  const config = ICP_CONFIGS.find((icp) => icp.id === id);
  if (!config) throw new Error(`Unknown ICP ${id}`);
  return config;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/$/, "");
}

export function parseSearchType(value: string | undefined): ExaSearchType {
  const searchType = (value ?? "neural") as ExaSearchType;
  if (!VALID_SEARCH_TYPES.has(searchType)) {
    throw new Error(
      `Invalid Exa search type "${searchType}". Expected one of: ${[
        ...VALID_SEARCH_TYPES,
      ].join(", ")}`,
    );
  }
  return searchType;
}

export function monthsAgoIso(months: number, now = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}
