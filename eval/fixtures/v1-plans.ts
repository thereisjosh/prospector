/**
 * v1's three hand-written ICPs, re-expressed as SearchPlans (translated from
 * the old src/config.ts IcpConfigs). These are golden fixtures for the
 * regression gate (SPEC-v2 6.1).
 *
 * Deliberately NOT ported: v1's hand-curated EXCLUDED_COMPANIES list of
 * off-profile firms (Amazon, Chewy, Quince, ...). The regression gate must
 * measure whether the generic gates catch those on their own.
 */
import { ENTERPRISE_DENYLIST } from "../../src/config";
import type { SearchPlan } from "../../src/plan";
import type { IcpId } from "../../src/types";

export const V1_PLAN_1: SearchPlan = {
  label: "Logistics ops scaling now",
  months: 3,
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
  signalSummaryQuery: "the why-now signal and its date",
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a third-party logistics/3PL, freight, warehousing, fulfillment, last-mile, or logistics operator, whether it is public or enterprise scale, and headquarters.",
  gateFields: [
    {
      key: "is_third_party_logistics",
      question:
        "Is this company itself a third-party logistics/3PL, freight, warehousing, fulfillment, last-mile, or logistics operator (not a retailer, consumer brand, manufacturer, or software/robotics vendor)?",
      required: true,
    },
  ],
  employeeRange: { min: 100, max: 1000, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US", "GB"],
  excludeDomains: [],
  excludeNames: [...ENTERPRISE_DENYLIST],
  signalTypes: ["new_facility", "expansion", "ops_hiring_wave", "ops_hire"],
};

export const V1_PLAN_2: SearchPlan = {
  label: "B2B SaaS/marketplace launched payments or billing",
  months: 3,
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
  signalSummaryQuery:
    "the payments or billing launch, billing/revenue operations hire, or finance operations executive signal and its date",
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a B2B SaaS or marketplace, whether it is itself a payments company, payment processor, PSP, acquiring bank, or fintech payments infrastructure provider, whether it is public or enterprise scale, and headquarters.",
  gateFields: [
    {
      key: "is_b2b_saas_or_marketplace",
      question: "Is this company a B2B SaaS or B2B marketplace business?",
      required: true,
    },
    {
      key: "is_not_payments_provider",
      question:
        "Is this company NOT itself a payments company, payment processor, PSP, acquiring bank, or fintech payments infrastructure provider? Answer true only if it is not.",
      required: true,
    },
  ],
  employeeRange: { min: 100, max: 800, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [...ENTERPRISE_DENYLIST],
  signalTypes: ["payments_launch", "billing_ops_hire", "finance_ops_exec"],
};

export const V1_PLAN_3: SearchPlan = {
  label: "Recently funded B2B hiring first Ops/RevOps",
  months: 6,
  signalQueries: [
    "US B2B startup raised seed funding announced",
    "US B2B startup raised Series A funding announced",
    "vertical software startup raises seed funding",
    "B2B SaaS startup raises Series A funding",
    "enterprise software startup seed funding announcement",
  ],
  signalSummaryQuery:
    "the recent seed or Series A funding announcement, company name, funding round, and announcement date",
  followUp: {
    queryTemplate:
      "{company} hiring RevOps revenue operations business operations head of operations chief of staff",
    summaryQuery:
      "whether this company is hiring an operations, business operations, RevOps, revenue operations, chief of staff, or go-to-market operations role; prefer first, founding, or small-team signals; include the date",
  },
  companySummaryQuery:
    "Firmographics for this company: description, industry, employee estimate, whether it is a B2B company, whether it recently raised seed or Series A funding, whether it is hiring an operations, business operations, revenue operations, RevOps, chief of staff, or go-to-market operations person, whether that role appears first/founding/small-team, whether it is public or enterprise scale, and headquarters.",
  gateFields: [
    { key: "is_b2b_company", question: "Is this a B2B company?", required: true },
    {
      key: "recently_funded_seed_or_series_a",
      question: "Did this company recently raise seed or Series A funding?",
      required: true,
    },
    {
      key: "hiring_first_ops_or_revops",
      question:
        "Is this company hiring an operations, business operations, revenue operations, RevOps, chief of staff, or go-to-market operations person, and does that role appear first/founding/small-team?",
      required: false,
    },
  ],
  employeeRange: { min: 30, max: 200, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [...ENTERPRISE_DENYLIST],
  signalTypes: ["first_ops_hire", "ops_hire", "funding_round"],
};

export const V1_PLANS: Record<IcpId, SearchPlan> = {
  1: V1_PLAN_1,
  2: V1_PLAN_2,
  3: V1_PLAN_3,
};

export function getV1Plan(id: IcpId): SearchPlan {
  const plan = V1_PLANS[id];
  if (!plan) throw new Error(`Unknown ICP ${id}`);
  return plan;
}
