import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProspecting } from "../src/pipeline";
import type { SearchPlan } from "../src/plan";

const NOW = new Date("2026-09-24T12:00:00.000Z");

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "Engine test",
  months: 3,
  signalQueries: ["companies opening facilities"],
  signalSummaryQuery: "the facility opening and its date",
  companySummaryQuery: "firmographics",
  gateFields: [
    { key: "is_operator", question: "Is it an operator?", required: true },
    { key: "is_growing", question: "Is it growing?", required: false },
  ],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["new_facility", "ops_hire"],
  ...over,
});

type Sig = {
  company: string;
  url: string;
  type?: string;
  date: string;
  published?: string;
};

const sig = (s: Sig) => ({
  url: s.url,
  title: `${s.company} news`,
  publishedDate: s.published ?? `${s.date}T00:00:00.000Z`,
  text: `${s.company} opened a new facility.`,
  summary: JSON.stringify({
    company_name: s.company,
    signal_type: s.type ?? "new_facility",
    signal_summary: `${s.company} opened a new facility.`,
    signal_date: s.date,
    signal_quote: `${s.company} opened a new facility.`,
    signal_date_quote: "",
  }),
});

const COMPANY_DB: Record<string, Record<string, unknown>> = {
  GoodCo: { is_operator: true, is_growing: true, employee_estimate: 200, hq: "Austin, TX" },
  NotOperatorCo: { is_operator: false, employee_estimate: 200, hq: "Austin, TX" },
  BlockedCo: { is_operator: true, employee_estimate: 200, hq: "Austin, TX" },
  StaleCo: { is_operator: true, employee_estimate: 200, hq: "Austin, TX" },
};

type Call = { query: string; body: Record<string, any> };
let calls: Call[];

function mockFetch(opts: { signalResults: unknown[]; followUpResults?: unknown[] }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, any>;
      calls.push({ query: body.query, body });
      if (body.category === "company") {
        const name = body.query as string;
        return new Response(
          JSON.stringify({
            results: [
              {
                url: `https://${name.toLowerCase()}.com`,
                title: name,
                summary: JSON.stringify({
                  description: `${name} description`,
                  industry: "X",
                  is_public_or_enterprise: false,
                  ...COMPANY_DB[name],
                  employee_estimate_source: `${COMPANY_DB[name]?.employee_estimate ?? 200} employees`,
                  hq_quote: String(COMPANY_DB[name]?.hq ?? ""),
                  is_operator_quote: `${name} is an operator. ${name} is growing.`,
                  is_growing_quote: `${name} is an operator. ${name} is growing.`,
                }),
                text: `${name} is an operator. ${name} is growing. ${COMPANY_DB[name]?.employee_estimate ?? 200} employees. ${COMPANY_DB[name]?.hq ?? ""}.`,
              },
            ],
            costDollars: { total: 0.001 },
          }),
          { status: 200 },
        );
      }
      if (/\bhiring a RevOps lead\b/.test(body.query as string)) {
        return new Response(
          JSON.stringify({ results: opts.followUpResults ?? [], costDollars: { total: 0.005 } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ results: opts.signalResults, costDollars: { total: 0.01 } }),
        { status: 200 },
      );
    }),
  );
}

const run = (p: SearchPlan) =>
  runProspecting(p, { type: "neural", numResults: 10, now: NOW, credentials: { apiKey: "test-key" } });

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runProspecting (mocked fetch)", () => {
  const signals = [
    sig({ company: "GoodCo", url: "https://news.example.com/goodco", date: "2026-08-20" }),
    sig({ company: "NotOperatorCo", url: "https://news.example.com/notop", date: "2026-08-21" }),
    sig({ company: "BlockedCo", url: "https://news.example.com/blocked", date: "2026-08-22" }),
    // Article published in window, but the EVENT happened before the window.
    sig({
      company: "StaleCo",
      url: "https://news.example.com/stale",
      date: "2026-04-15",
      published: "2026-09-10T00:00:00.000Z",
    }),
  ];

  it("excludes required-gate failures and stale event dates, keeps the good company", async () => {
    mockFetch({ signalResults: signals });
    const result = await run(plan());
    const names = result.rows.map((r) => r.company);
    expect(names).toContain("GoodCo");
    // NotOperatorCo was looked up (fresh, in-geo, in-range) and then failed its required gate.
    expect(calls.some((c) => c.body.category === "company" && c.query === "NotOperatorCo")).toBe(true);
    expect(names).not.toContain("NotOperatorCo");
    expect(names).not.toContain("StaleCo");
    // StaleCo is dropped before enrichment, so it is never looked up.
    expect(calls.some((c) => c.body.category === "company" && c.query === "StaleCo")).toBe(false);
    const good = result.rows.find((r) => r.company === "GoodCo")!;
    expect(good.signal_date).toBe("2026-08-20");
    expect(good.fit_reason).toContain("is_operator");
    expect(good.fit_reason).toContain("is_growing");
  });

  it("honours excludeNames and passes excludeDomains to Exa", async () => {
    mockFetch({ signalResults: signals });
    const result = await run(plan({ excludeNames: ["blockedco"], excludeDomains: ["spam.example"] }));
    const names = result.rows.map((r) => r.company);
    expect(names).toEqual(["GoodCo"]);
    expect(calls.some((c) => c.body.category === "company" && c.query === "BlockedCo")).toBe(false);
    const signalCall = calls.find((c) => !c.body.category)!;
    expect(signalCall.body.excludeDomains).toEqual(["spam.example"]);
  });

  it("sends plan-derived search params: startPublishedDate, enum schema, ISO-date instruction", async () => {
    mockFetch({ signalResults: [] });
    await run(plan({ months: 2 }));
    const call = calls[0]!;
    expect(call.body.startPublishedDate).toBe("2026-07-24T00:00:00.000Z");
    expect(call.body.excludeDomains).toBeUndefined();
    const summary = call.body.contents.summary;
    expect(summary.schema.properties.signal_type.enum).toEqual(["new_facility", "ops_hire", "other"]);
    expect(summary.query).toContain("YYYY-MM-DD");
  });

  it("drops candidates whose domain is in excludeDomains even if Exa returns them", async () => {
    mockFetch({ signalResults: signals });
    const result = await run(plan({ excludeDomains: ["news.example.com"] }));
    expect(result.rows).toEqual([]);
  });

  it("invokes followUp only when plan.followUp is set, and sums cost", async () => {
    const followUp = {
      queryTemplate: "{company} is hiring a RevOps lead",
      summaryQuery: "is the company hiring a RevOps lead; include the date",
    };
    const followUpResults = [
      sig({
        company: "GoodCo",
        url: "https://jobs.example.com/goodco-revops",
        type: "ops_hire",
        date: "2026-09-01",
      }),
    ];

    mockFetch({ signalResults: [signals[0]], followUpResults });
    const without = await run(plan());
    expect(calls.some((c) => /RevOps lead/.test(c.query))).toBe(false);
    // 1 signal search (0.01) + 1 company lookup (0.001)
    expect(without.totalCostDollars).toBeCloseTo(0.011, 6);

    mockFetch({ signalResults: [signals[0]], followUpResults });
    const withFollowUp = await run(plan({ followUp }));
    const fuCalls = calls.filter((c) => /RevOps lead/.test(c.query));
    expect(fuCalls).toHaveLength(1);
    expect(fuCalls[0]!.query).toBe("GoodCo is hiring a RevOps lead");
    expect(fuCalls[0]!.body.numResults).toBe(3);
    expect(fuCalls[0]!.body.contents.summary.query).toContain("RevOps lead");
    // 0.01 + 0.001 + 0.005 follow-up
    expect(withFollowUp.totalCostDollars).toBeCloseTo(0.016, 6);
    expect(withFollowUp.rows).toHaveLength(1);
  });

  it("reuses the enrichment cache without re-billing the lookup", async () => {
    mockFetch({ signalResults: [signals[0]] });
    const cache = new Map();
    const first = await runProspecting(plan(), {
      type: "neural", now: NOW, credentials: { apiKey: "k" }, enrichmentCache: cache,
    });
    const second = await runProspecting(plan(), {
      type: "neural", now: NOW, credentials: { apiKey: "k" }, enrichmentCache: cache,
    });
    expect(first.totalCostDollars).toBeCloseTo(0.011, 6);
    expect(second.totalCostDollars).toBeCloseTo(0.01, 6);
  });

  it("funnel counts add up and rejections are inspectable by name", async () => {
    mockFetch({ signalResults: signals });
    const result = await run(plan());
    const f = result.funnel;
    expect(f.rawSignalResults).toBe(4);
    expect(f.withCompanyName).toBe(4);
    expect(f.droppedStaleOrUnparseableDate).toBe(1);
    expect(f.afterDedupeByCompany).toBe(3);
    expect(f.selectedForEnrichment).toBe(3);
    expect(f.cutByEnrichmentLimit).toBe(0);
    expect(f.enrichmentNoResult).toBe(0);
    expect(f.rejections["required_gate:is_operator"]).toBe(1);
    expect(f.finalRows).toBe(result.rows.length);
    // every company that survived dedupe is either a final row or a fit rejection
    const fitRejections = result.rejected.filter((r) => r.reason.startsWith("Excluded:"));
    expect(f.afterDedupeByCompany).toBe(f.finalRows + fitRejections.length);
    expect(result.rejected.find((r) => r.company === "NotOperatorCo")).toMatchObject({
      signal_url: "https://news.example.com/notop",
    });
    expect(result.rejected.find((r) => r.company === "StaleCo")?.reason).toMatch(/^stale_date/);
  });

  it("counts companies cut by the enrichment limit", async () => {
    mockFetch({ signalResults: signals });
    const result = await runProspecting(plan(), {
      type: "neural", numResults: 10, maxCandidates: 2, now: NOW, credentials: { apiKey: "k" },
    });
    expect(result.funnel.selectedForEnrichment).toBe(2);
    expect(result.funnel.cutByEnrichmentLimit).toBe(1);
  });

  it("counts excludeNames / excludeDomains drops in the funnel", async () => {
    mockFetch({ signalResults: signals });
    const byName = await run(plan({ excludeNames: ["BlockedCo"] }));
    expect(byName.funnel.rejections.excludeNames).toBe(1);
    expect(byName.rejected.some((r) => r.company === "BlockedCo")).toBe(true);
    const byDomain = await run(plan({ excludeDomains: ["news.example.com"] }));
    expect(byDomain.funnel.rejections.excludeDomains).toBe(4);
    expect(byDomain.funnel.finalRows).toBe(0);
  });
});
