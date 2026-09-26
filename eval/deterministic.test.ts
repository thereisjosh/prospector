import { describe, expect, it } from "vitest";
import { getIcpConfig, monthsAgoIso } from "../src/config.js";
import {
  companyFitChecks,
  dateInWindow,
  nameMatchesSignal,
  netNew,
} from "../src/eval.js";
import { scoreAndRank } from "../src/score.js";

describe("deterministic evals", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const start = monthsAgoIso(3, now);
  const icp1 = getIcpConfig(1);
  const icp2 = getIcpConfig(2);
  const icp3 = getIcpConfig(3);

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

  it("net_new compares against the ICP 1 Apollo baseline", () => {
    expect(netNew("ShipMonk")).toBe(true);
    expect(netNew("Flexport")).toBe(false);
  });

  it("checks best-effort ICP fit from company firmographics", () => {
    expect(
      companyFitChecks({
        company: "ShipMonk",
        description: "3PL fulfillment and warehousing operator",
        employeeEstimate: 500,
        isThirdPartyLogistics: true,
      }),
    ).toEqual({ size_in_range: true, is_3pl: true });
    expect(
      companyFitChecks({
        company: "GXO Logistics",
        description: "contract logistics provider",
        employeeEstimate: 130000,
        isThirdPartyLogistics: true,
      }),
    ).toEqual({ size_in_range: false, is_3pl: true });
    expect(
      companyFitChecks({
        company: "Quince",
        description: "consumer retail brand",
        employeeEstimate: 700,
        isThirdPartyLogistics: false,
      }),
    ).toEqual({ size_in_range: true, is_3pl: false });
  });

  it("dedupes by domain and ranks stronger, fresher signals", () => {
    const rows = scoreAndRank(
      icp1,
      [
        {
          result: {
            url: "https://jobs.example.com/a",
            title: "Operations Manager at ShipMonk",
            publishedDate: "2026-08-13T00:00:00.000Z",
            text: "ShipMonk 3PL fulfillment network is hiring operations manager roles.",
          },
          summary: {
            company_name: "ShipMonk",
            signal_type: "operations hiring",
            signal_summary:
              "ShipMonk is hiring operations managers for its 3PL fulfillment network.",
            signal_date: "2026-08-13",
          },
          company: {
            summary: {
              description: "Third-party logistics fulfillment and warehousing provider",
              industry: "Logistics",
              employee_estimate: 650,
              is_third_party_logistics: true,
              hq: "Fort Lauderdale, FL",
            },
          },
        },
        {
          result: {
            url: "https://jobs.example.com/b",
            title: "Older Operations Manager at ShipMonk",
            publishedDate: "2026-07-01T00:00:00.000Z",
            text: "ShipMonk 3PL operations role.",
          },
          summary: {
            company_name: "ShipMonk",
            signal_type: "single role",
            signal_summary: "ShipMonk posted an operations role.",
            signal_date: "2026-07-01",
          },
          company: {
            summary: {
              description: "Third-party logistics fulfillment and warehousing provider",
              industry: "Logistics",
              employee_estimate: 650,
              is_third_party_logistics: true,
              hq: "Fort Lauderdale, FL",
            },
          },
        },
      ],
      start,
      now,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.signal_date).toBe("2026-08-13");
  });

  it("hard-gates enterprise and non-3PL company enrichments", () => {
    const rows = scoreAndRank(
      icp1,
      [
        {
          result: {
            url: "https://jobs.example.com/gxo",
            title: "Operations Manager at GXO Logistics",
            publishedDate: "2026-08-13T00:00:00.000Z",
            text: "GXO Logistics contract logistics warehouse operations role.",
          },
          summary: {
            company_name: "GXO Logistics",
            signal_type: "operations hiring",
            signal_summary:
              "GXO Logistics is hiring operations managers for warehouse operations.",
            signal_date: "2026-08-13",
          },
          company: {
            summary: {
              description: "Global contract logistics provider",
              industry: "Logistics",
              employee_estimate: 130000,
              is_third_party_logistics: true,
              hq: "Greenwich, CT",
            },
          },
        },
        {
          result: {
            url: "https://jobs.example.com/quince",
            title: "Warehouse Operations Manager at Quince",
            publishedDate: "2026-08-14T00:00:00.000Z",
            text: "Quince retail warehouse operations role.",
          },
          summary: {
            company_name: "Quince",
            signal_type: "operations hiring",
            signal_summary:
              "Quince is hiring a warehouse operations manager.",
            signal_date: "2026-08-14",
          },
          company: {
            summary: {
              description: "Consumer retail brand selling apparel and home goods",
              industry: "Retail",
              employee_estimate: 500,
              is_third_party_logistics: false,
              hq: "San Francisco, CA",
            },
          },
        },
        {
          result: {
            url: "https://jobs.example.com/shipmonk",
            title: "Operations Manager at ShipMonk",
            publishedDate: "2026-08-15T00:00:00.000Z",
            text: "ShipMonk 3PL fulfillment network is hiring operations manager roles.",
          },
          summary: {
            company_name: "ShipMonk",
            signal_type: "operations hiring",
            signal_summary:
              "ShipMonk is hiring operations managers for its 3PL fulfillment network.",
            signal_date: "2026-08-15",
          },
          company: {
            summary: {
              description: "Third-party logistics fulfillment and warehousing provider",
              industry: "Logistics",
              employee_estimate: 650,
              is_third_party_logistics: true,
              hq: "Fort Lauderdale, FL",
            },
          },
        },
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
        {
          result: {
            url: "https://jobs.example.com/emiza",
            title: "Operations Manager at Emiza",
            publishedDate: "2026-08-15T00:00:00.000Z",
            text: "Emiza 3PL fulfillment network is hiring operations manager roles.",
          },
          summary: {
            company_name: "Emiza",
            signal_type: "operations hiring",
            signal_summary: "Emiza is hiring operations managers.",
            signal_date: "2026-08-15",
          },
          company: {
            summary: {
              description: "Third-party logistics fulfillment and warehousing provider",
              industry: "Logistics",
              employee_estimate: 500,
              is_third_party_logistics: true,
              hq: "Mumbai, India",
            },
          },
        },
        {
          result: {
            url: "https://jobs.example.com/rxo",
            title: "Operations Manager at RXO",
            publishedDate: "2026-08-16T00:00:00.000Z",
            text: "RXO logistics operations manager role.",
          },
          summary: {
            company_name: "RXO",
            signal_type: "operations hiring",
            signal_summary: "RXO posted an operations manager role.",
            signal_date: "2026-08-16",
          },
          company: {
            summary: {
              description: "Public logistics and freight brokerage company",
              industry: "Logistics",
              employee_estimate: "unknown",
              is_third_party_logistics: true,
              hq: "Charlotte, NC, United States",
            },
          },
        },
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
        {
          result: {
            url: "https://jobs.example.com/regional-fulfill",
            title: "Operations Manager at Regional Fulfill",
            publishedDate: "2026-08-17T00:00:00.000Z",
            text: "Regional Fulfill is a 3PL fulfillment company hiring warehouse operations managers.",
          },
          summary: {
            company_name: "Regional Fulfill",
            signal_type: "operations hiring",
            signal_summary:
              "Regional Fulfill is hiring warehouse operations managers for its 3PL fulfillment network.",
            signal_date: "2026-08-17",
          },
          company: {
            summary: {
              description: "Third-party logistics fulfillment and warehousing provider",
              industry: "Logistics",
              employee_estimate: "unknown",
              is_third_party_logistics: true,
              is_public_or_enterprise: false,
              hq: "Columbus, OH, United States",
            },
          },
        },
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
        {
          result: {
            url: "https://news.example.com/fieldops",
            title: "FieldOps launches embedded billing",
            publishedDate: "2026-08-15T00:00:00.000Z",
            text: "FieldOps launched embedded payments and billing for its B2B SaaS customers.",
          },
          summary: {
            company_name: "FieldOps",
            signal_type: "payments launch",
            signal_summary: "FieldOps launched embedded payments and billing.",
            signal_date: "2026-08-15",
          },
          company: {
            summary: {
              description: "B2B vertical SaaS platform for field service teams",
              industry: "Software",
              employee_estimate: 250,
              is_b2b_saas_or_marketplace: true,
              is_payments_company_or_psp: false,
              hq: "Austin, TX, United States",
            },
          },
        },
        {
          result: {
            url: "https://news.example.com/stripe",
            title: "Stripe expands billing",
            publishedDate: "2026-08-15T00:00:00.000Z",
            text: "Stripe expanded billing products.",
          },
          summary: {
            company_name: "Stripe",
            signal_type: "billing launch",
            signal_summary: "Stripe expanded billing products.",
            signal_date: "2026-08-15",
          },
          company: {
            summary: {
              description: "Payments infrastructure and payment processor",
              industry: "Payments",
              employee_estimate: 700,
              is_b2b_saas_or_marketplace: false,
              is_payments_company_or_psp: true,
              hq: "San Francisco, CA, United States",
            },
          },
        },
      ],
      start,
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["FieldOps"]);
    expect(rows[0]?.signal_strength).toBe("payments/billing launch");
  });

  it("ICP 3 keeps funding-first rows and ranks ops hiring evidence above funding only", () => {
    const rows = scoreAndRank(
      icp3,
      [
        {
          result: {
            url: "https://news.example.com/nova",
            title: "NovaCRM raises Series A and hires founding RevOps",
            publishedDate: "2026-07-10T00:00:00.000Z",
            text: "NovaCRM raised Series A funding and is hiring its first RevOps lead.",
          },
          summary: {
            company_name: "NovaCRM",
            signal_type: "funding plus first revops hire",
            signal_summary:
              "NovaCRM raised Series A funding and is hiring its first RevOps lead.",
            signal_date: "2026-07-10",
          },
          company: {
            summary: {
              description: "B2B SaaS company",
              industry: "Software",
              employee_estimate: 80,
              is_b2b_company: true,
              hq: "Boston, MA, United States",
            },
          },
        },
        {
          result: {
            url: "https://news.example.com/oldops",
            title: "OldOps raises Series A",
            publishedDate: "2026-07-10T00:00:00.000Z",
            text: "OldOps raised Series A funding.",
          },
          summary: {
            company_name: "OldOps",
            signal_type: "funding",
            signal_summary: "OldOps raised Series A funding.",
            signal_date: "2026-07-10",
          },
          company: {
            summary: {
              description: "B2B SaaS company with an existing revenue operations team",
              industry: "Software",
              employee_estimate: 90,
              is_b2b_company: true,
              hq: "Denver, CO, United States",
            },
          },
        },
      ],
      monthsAgoIso(6, now),
      now,
    );

    expect(rows.map((row) => row.company)).toEqual(["NovaCRM", "OldOps"]);
    expect(rows[0]?.signal_strength).toBe("funding + first-ops hire");
    expect(rows[1]?.signal_strength).toBe("funding only");
  });
});
