import { describe, expect, it } from "vitest";
import { monthsAgoIso } from "../src/config";
import {
  companyFitChecks,
  dateInWindow,
  nameMatchesSignal,
  netNew,
} from "../src/eval";
import { scoreAndRank, type Candidate } from "../src/score";
import { V1_PLAN_1, V1_PLAN_2, V1_PLAN_3 } from "./fixtures/v1-plans";

type CandidateArgs = {
  url: string;
  title: string;
  publishedDate: string;
  text: string;
  company: string;
  signalType: string;
  summary: string;
  signalDate: string;
  enrichment?: Record<string, unknown>;
};

function candidate(a: CandidateArgs): Candidate {
  return {
    result: { url: a.url, title: a.title, publishedDate: a.publishedDate, text: a.text },
    summary: {
      company_name: a.company,
      signal_type: a.signalType,
      signal_summary: a.summary,
      signal_date: a.signalDate,
    },
    ...(a.enrichment ? { company: { summary: a.enrichment } } : {}),
  };
}

const fulfillmentCompany = (hq: string, employees: number | string) => ({
  description: "Third-party logistics fulfillment and warehousing provider",
  industry: "Logistics",
  employee_estimate: employees,
  is_third_party_logistics: true,
  hq,
});

describe("deterministic evals", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const start = monthsAgoIso(3, now);
  const icp1 = V1_PLAN_1;
  const icp2 = V1_PLAN_2;
  const icp3 = V1_PLAN_3;

  it("date_in_window accepts fresh dates and rejects stale dates", () => {
    expect(dateInWindow("2026-08-13", start, now)).toBe(true);
    expect(dateInWindow("2026-05-13", start, now)).toBe(false);
  });

  it("name_matches_signal checks that the company is present in the signal", () => {
    expect(
      nameMatchesSignal({
        company: "ShipMonk",
        title: "Operations Manager @ ShipMonk",
        summary: "ShipMonk is hiring an operations manager.",
      }),
    ).toBe(true);
    expect(
      nameMatchesSignal({
        company: "ShipMonk",
        title: "Operations Manager at OtherCo",
        summary: "OtherCo is opening a warehouse.",
      }),
    ).toBe(false);
  });

  it("net_new compares against the enterprise baseline", () => {
    expect(netNew("ShipMonk")).toBe(true);
    expect(netNew("Flexport")).toBe(false);
    expect(netNew("Flexport", icp1.excludeNames)).toBe(false);
  });

  it("checks best-effort ICP fit from plan gates and size", () => {
    expect(
      companyFitChecks({
        plan: icp1,
        employeeEstimate: 500,
        gates: { is_third_party_logistics: true },
      }),
    ).toEqual({ size_in_range: true, required_gates_pass: true });
    expect(
      companyFitChecks({
        plan: icp1,
        employeeEstimate: 130000,
        gates: { is_third_party_logistics: true },
      }),
    ).toEqual({ size_in_range: false, required_gates_pass: true });
    expect(
      companyFitChecks({
        plan: icp1,
        employeeEstimate: 700,
        gates: { is_third_party_logistics: false },
      }),
    ).toEqual({ size_in_range: true, required_gates_pass: false });
  });

  it("dedupes by company and ranks stronger, fresher signals", () => {
    const rows = scoreAndRank(
      icp1,
      [
        candidate({
          url: "https://jobs.example.com/a",
          title: "Operations Manager at ShipMonk",
          publishedDate: "2026-08-13T00:00:00.000Z",
          text: "ShipMonk 3PL fulfillment network is hiring operations manager roles.",
          company: "ShipMonk",
          signalType: "ops_hiring_wave",
          summary: "ShipMonk is hiring operations managers for its 3PL fulfillment network.",
          signalDate: "2026-08-13",
          enrichment: fulfillmentCompany("Fort Lauderdale, FL", 650),
        }),
        candidate({
          url: "https://jobs.example.com/b",
          title: "Older Operations Manager at ShipMonk",
          publishedDate: "2026-07-01T00:00:00.000Z",
          text: "ShipMonk 3PL operations role.",
          company: "ShipMonk",
          signalType: "ops_hire",
          summary: "ShipMonk posted an operations role.",
          signalDate: "2026-07-01",
          enrichment: fulfillmentCompany("Fort Lauderdale, FL", 650),
        }),
      ],
      start,
      now,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal_date).toBe("2026-08-13");
    expect(rows[0]?.fit_reason).toContain("is_third_party_logistics");
  });

  it("hard-gates enterprise and non-3PL company enrichments", () => {
    const rows = scoreAndRank(
      icp1,
      [
        candidate({
          url: "https://jobs.example.com/gxo",
          title: "Operations Manager at GXO Logistics",
          publishedDate: "2026-08-13T00:00:00.000Z",
          text: "GXO Logistics contract logistics warehouse operations role.",
          company: "GXO Logistics",
          signalType: "ops_hire",
          summary: "GXO Logistics is hiring operations managers for warehouse operations.",
          signalDate: "2026-08-13",
          enrichment: {
            description: "Global contract logistics provider",
            industry: "Logistics",
            employee_estimate: 130000,
            is_third_party_logistics: true,
            hq: "Greenwich, CT",
          },
        }),
        candidate({
          url: "https://jobs.example.com/quince",
          title: "Warehouse Operations Manager at Quince",
          publishedDate: "2026-08-14T00:00:00.000Z",
          text: "Quince retail warehouse operations role.",
          company: "Quince",
          signalType: "ops_hire",
          summary: "Quince is hiring a warehouse operations manager.",
          signalDate: "2026-08-14",
          enrichment: {
            description: "Consumer retail brand selling apparel and home goods",
            industry: "Retail",
            employee_estimate: 500,
            is_third_party_logistics: false,
            hq: "San Francisco, CA",
          },
        }),
        candidate({
          url: "https://jobs.example.com/shipmonk",
          title: "Operations Manager at ShipMonk",
          publishedDate: "2026-08-15T00:00:00.000Z",
          text: "ShipMonk 3PL fulfillment network is hiring operations manager roles.",
          company: "ShipMonk",
          signalType: "ops_hiring_wave",
          summary: "ShipMonk is hiring operations managers for its 3PL fulfillment network.",
          signalDate: "2026-08-15",
          enrichment: fulfillmentCompany("Fort Lauderdale, FL", 650),
        }),
      ],
      start,
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["ShipMonk"]);
  });

  it("hard-gates out-of-geo and known enterprise unknown-size logistics companies", () => {
    const rows = scoreAndRank(
      icp1,
      [
        candidate({
          url: "https://jobs.example.com/emiza",
          title: "Operations Manager at Emiza",
          publishedDate: "2026-08-15T00:00:00.000Z",
          text: "Emiza 3PL fulfillment network is hiring operations manager roles.",
          company: "Emiza",
          signalType: "ops_hire",
          summary: "Emiza is hiring operations managers.",
          signalDate: "2026-08-15",
          enrichment: fulfillmentCompany("Mumbai, India", 500),
        }),
        candidate({
          url: "https://jobs.example.com/rxo",
          title: "Operations Manager at RXO",
          publishedDate: "2026-08-16T00:00:00.000Z",
          text: "RXO logistics operations manager role.",
          company: "RXO",
          signalType: "ops_hire",
          summary: "RXO posted an operations manager role.",
          signalDate: "2026-08-16",
          enrichment: {
            description: "Public logistics and freight brokerage company",
            industry: "Logistics",
            employee_estimate: "unknown",
            is_third_party_logistics: true,
            hq: "Charlotte, NC, United States",
          },
        }),
      ],
      start,
      now,
    );

    expect(rows).toHaveLength(0);
  });

  it("keeps unknown-size mid-market-looking 3PLs unless they are enterprise denied", () => {
    const rows = scoreAndRank(
      icp1,
      [
        candidate({
          url: "https://jobs.example.com/regional-fulfill",
          title: "Operations Manager at Regional Fulfill",
          publishedDate: "2026-08-17T00:00:00.000Z",
          text: "Regional Fulfill is a 3PL fulfillment company hiring warehouse operations managers.",
          company: "Regional Fulfill",
          signalType: "ops_hiring_wave",
          summary:
            "Regional Fulfill is hiring warehouse operations managers for its 3PL fulfillment network.",
          signalDate: "2026-08-17",
          enrichment: {
            ...fulfillmentCompany("Columbus, OH, United States", "unknown"),
            is_public_or_enterprise: false,
          },
        }),
      ],
      start,
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["Regional Fulfill"]);
  });

  it("ICP 2 keeps B2B SaaS billing launches and rejects payments companies", () => {
    const rows = scoreAndRank(
      icp2,
      [
        candidate({
          url: "https://news.example.com/fieldops",
          title: "FieldOps launches embedded billing",
          publishedDate: "2026-08-15T00:00:00.000Z",
          text: "FieldOps launched embedded payments and billing for its B2B SaaS customers.",
          company: "FieldOps",
          signalType: "payments_launch",
          summary: "FieldOps launched embedded payments and billing.",
          signalDate: "2026-08-15",
          enrichment: {
            description: "B2B vertical SaaS platform for field service teams",
            industry: "Software",
            employee_estimate: 250,
            is_b2b_saas_or_marketplace: true,
            is_not_payments_provider: true,
            hq: "Austin, TX, United States",
          },
        }),
        candidate({
          url: "https://news.example.com/stripe",
          title: "Stripe expands billing",
          publishedDate: "2026-08-15T00:00:00.000Z",
          text: "Stripe expanded billing products.",
          company: "Stripe",
          signalType: "payments_launch",
          summary: "Stripe expanded billing products.",
          signalDate: "2026-08-15",
          enrichment: {
            description: "Payments infrastructure and payment processor",
            industry: "Payments",
            employee_estimate: 700,
            is_b2b_saas_or_marketplace: false,
            is_not_payments_provider: false,
            hq: "San Francisco, CA, United States",
          },
        }),
      ],
      start,
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["FieldOps"]);
    expect(rows[0]?.signal_strength).toBe("payments launch");
  });

  it("ICP 3 keeps funded rows and ranks ops hiring evidence above funding only", () => {
    const b2b = (employees: number, hq: string, hiring: boolean) => ({
      description: "B2B SaaS company",
      industry: "Software",
      employee_estimate: employees,
      is_b2b_company: true,
      recently_funded_seed_or_series_a: true,
      hiring_first_ops_or_revops: hiring,
      hq,
    });
    const rows = scoreAndRank(
      icp3,
      [
        candidate({
          url: "https://news.example.com/nova",
          title: "NovaCRM raises Series A and hires founding RevOps",
          publishedDate: "2026-07-10T00:00:00.000Z",
          text: "NovaCRM raised Series A funding and is hiring its first RevOps lead.",
          company: "NovaCRM",
          signalType: "first_ops_hire",
          summary: "NovaCRM raised Series A funding and is hiring its first RevOps lead.",
          signalDate: "2026-07-10",
          enrichment: b2b(80, "Boston, MA, United States", true),
        }),
        candidate({
          url: "https://news.example.com/oldops",
          title: "OldOps raises Series A",
          publishedDate: "2026-07-10T00:00:00.000Z",
          text: "OldOps raised Series A funding.",
          company: "OldOps",
          signalType: "funding_round",
          summary: "OldOps raised Series A funding.",
          signalDate: "2026-07-10",
          enrichment: b2b(90, "Denver, CO, United States", false),
        }),
      ],
      monthsAgoIso(6, now),
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["NovaCRM", "OldOps"]);
    expect(rows[0]?.signal_strength).toBe("first ops hire");
    expect(rows[1]?.signal_strength).toBe("funding round");
  });

  it("judges freshness on the event date, not the article publish date", () => {
    const rows = scoreAndRank(
      icp1,
      [
        candidate({
          url: "https://news.example.com/stale",
          title: "StaleCo opens new warehouse",
          publishedDate: "2026-09-01T00:00:00.000Z",
          text: "StaleCo opened a new warehouse.",
          company: "StaleCo",
          signalType: "new_facility",
          summary: "StaleCo opened a new warehouse.",
          signalDate: "2026-02-10",
          enrichment: fulfillmentCompany("Dallas, TX", 400),
        }),
      ],
      start,
      now,
    );
    expect(rows).toHaveLength(0);
  });
});
