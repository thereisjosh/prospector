import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthsAgoIso } from "../src/config";
import { BudgetExceededError, CostGuard, estimateExaCost, exaSearch } from "../src/exa";
import { runProspecting } from "../src/pipeline";
import type { SearchPlan } from "../src/plan";
import {
  createTrace,
  isNonCompanyName,
  nameExcluded,
  rankCompaniesForEnrichment,
  resolveEventDate,
  scoreAndRank,
  type Candidate,
} from "../src/score";
import { V1_PLAN_1 } from "./fixtures/v1-plans";

const NOW = new Date("2026-10-11T03:00:00.000Z");

const cand = (over: {
  company?: string;
  sig?: string;
  pub?: string;
  type?: string;
  url?: string;
  scale?: string;
  prescreen?: Record<string, string>;
  enrichment?: Record<string, unknown>;
}): Candidate => ({
  result: {
    url: over.url ?? `https://news.example.com/${over.company ?? "x"}`,
    title: `${over.company ?? "x"} news`,
    ...(over.pub ? { publishedDate: `${over.pub}T00:00:00.000Z` } : {}),
    text: `${over.company ?? "x"} did a thing`,
  },
  summary: {
    company_name: over.company ?? "x",
    signal_type: over.type ?? "new_facility",
    signal_summary: `${over.company ?? "x"} opened a facility`,
    signal_date: over.sig ?? "",
    ...(over.scale ? { company_scale_guess: over.scale } : {}),
    ...(over.prescreen ? { prescreen: over.prescreen } : {}),
  },
  ...(over.enrichment ? { company: { summary: over.enrichment } } : {}),
});

describe("date reconciliation (Exa hallucinates the year)", () => {
  const r = (sig: string | undefined, pub: string | undefined) =>
    resolveEventDate(cand({ sig, pub }), NOW);

  it("RGL: signal 2023-10-05 vs published 2026-10-05 -> published_fallback", () => {
    expect(r("2023-10-05", "2026-10-05")).toEqual({ date: "2026-10-05", source: "published_fallback" });
  });
  it("FST: 2023-12-05 vs 2026-09-25 -> published_fallback", () => {
    expect(r("2023-12-05", "2026-09-25")).toEqual({ date: "2026-09-25", source: "published_fallback" });
  });
  it("G10: 2024-10-24 vs 2026-09-11 -> published_fallback", () => {
    expect(r("2024-10-24", "2026-09-11")).toEqual({ date: "2026-09-11", source: "published_fallback" });
  });
  it("Associated: future 2026-10-15 -> published_fallback", () => {
    expect(r("2026-10-15", "2026-10-09")).toEqual({ date: "2026-10-09", source: "published_fallback" });
  });
  it("Levi's: future 2026-12-07 -> published_fallback", () => {
    expect(r("2026-12-07", "2026-10-02")).toEqual({ date: "2026-10-02", source: "published_fallback" });
  });
  it("trusts a plausible signal_date (up to 12 months before, 7 days after publish)", () => {
    expect(r("2026-04-15", "2026-08-20")).toEqual({ date: "2026-04-15", source: "signal" });
    expect(r("2025-09-20", "2026-09-20")).toEqual({ date: "2025-09-20", source: "signal" });
    expect(r("2025-09-19", "2026-09-20").source).toBe("published_fallback");
    expect(r("2026-09-27", "2026-09-20").source).toBe("signal");
    expect(r("2026-09-28", "2026-09-20").source).toBe("published_fallback");
  });
  it("uses publishedDate when signal_date is missing or unparseable", () => {
    expect(r(undefined, "2026-09-20")).toEqual({ date: "2026-09-20", source: "published_fallback" });
    expect(r("sometime soon", "2026-09-20").date).toBe("2026-09-20");
  });
  it("with no publishedDate, implausible signal dates are unparseable", () => {
    expect(r("2026-12-07", undefined)).toEqual({ date: "", source: "" }); // future
    expect(r("2023-01-01", undefined)).toEqual({ date: "", source: "" }); // > 24 months before now
    expect(r(undefined, undefined)).toEqual({ date: "", source: "" });
    expect(r("2026-08-01", undefined)).toEqual({ date: "2026-08-01", source: "signal" });
  });

  it("a legit stale event (April Series A reported in August) is still dropped by the window", () => {
    const trace = createTrace();
    const rows = scoreAndRank(
      V1_PLAN_1,
      [cand({ company: "StaleCo", sig: "2026-04-15", pub: "2026-08-20", enrichment: { is_third_party_logistics: true, employee_estimate: 300, hq: "Ohio, US" } })],
      monthsAgoIso(3, NOW),
      NOW,
      trace,
    );
    expect(rows).toEqual([]);
    expect(trace.funnel.droppedStaleOrUnparseableDate).toBe(1);
  });

  it("a hallucinated year no longer drops a fresh article, and the row says so", () => {
    const rows = scoreAndRank(
      V1_PLAN_1,
      [cand({ company: "RGL Logistics", sig: "2023-10-05", pub: "2026-10-05", enrichment: { is_third_party_logistics: true, employee_estimate: 300, hq: "Ohio, US" } })],
      monthsAgoIso(3, NOW),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signal_date: "2026-10-05", date_source: "published_fallback" });
  });
});

describe("fuzzy excludeNames", () => {
  const tok = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  const deny = ["RXO", "XPO", "C.H. Robinson", "GXO Logistics", "UPS"].map((n) =>
    // mirror score.ts nameTokens via nameExcluded's own normalisation
    n,
  );
  const excluded = deny.map((n) => n.toLowerCase().replace(/&/g, "and").replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" "));
  void tok;

  it.each([
    "RXO (formerly XPO Logistics)",
    "RXO CORPORATE SOLUTIONS, LLC",
    "RXO, Inc.",
    "Rxo",
    "Chrobinson",
    "C.H. Robinson Worldwide",
    "XPO, Inc.",
    "GXO Logistics",
  ])("excludes %s", (name) => {
    expect(nameExcluded(name, excluded)).toBe(true);
  });

  it.each(["ShipMonk", "Upsilon Freight", "Robinson Fulfillment", "Rxoo Labs", "Logistics GXO"])(
    "keeps %s",
    (name) => {
      expect(nameExcluded(name, excluded)).toBe(false);
    },
  );

  it("is applied before selection (excluded variants never enter the queue)", () => {
    const plan: SearchPlan = { ...V1_PLAN_1, excludeNames: ["RXO", "C.H. Robinson"] };
    const queue = rankCompaniesForEnrichment(
      plan,
      [
        cand({ company: "RXO (formerly XPO Logistics)", pub: "2026-10-01" }),
        cand({ company: "Chrobinson", pub: "2026-10-01" }),
        cand({ company: "ShipMonk", pub: "2026-10-01" }),
      ],
      monthsAgoIso(3, NOW),
      NOW,
    );
    expect(queue).toEqual(["ShipMonk"]);
  });
});

describe("generic non-company filter", () => {
  it.each([
    "iHireLogistics", "Amazon (via iHireLogistics)", "Energy Jobline", "Apex People Group", "Remote Rush",
    "Jobrapido", "Indeed", "ZipRecruiter", "LinkedIn Jobs", "Glassdoor",
    "Unknown", "Final Mile", "Role, Inc.", "", "  ",
  ])("rejects %j", (name) => {
    expect(isNonCompanyName(name)).toBe(true);
  });
  it.each(["ShipMonk", "Indeedy Freight Co", "Final Mile Logistics", "Peoples Logistics"])("keeps %s", (name) => {
    expect(isNonCompanyName(name)).toBe(false);
  });

  it("is applied before selection and counted in the funnel", () => {
    const trace = createTrace();
    scoreAndRank(
      V1_PLAN_1,
      [cand({ company: "Remote Rush", pub: "2026-10-01" }), cand({ company: "Role, Inc.", pub: "2026-10-01" })],
      monthsAgoIso(3, NOW),
      NOW,
      trace,
    );
    expect(trace.funnel.rejections.non_company).toBe(2);
    expect(rankCompaniesForEnrichment(V1_PLAN_1, [cand({ company: "Remote Rush", pub: "2026-10-01" })], monthsAgoIso(3, NOW), NOW)).toEqual([]);
  });
});

describe("pre-screen ranking", () => {
  it("sends enterprise / pre_* = no to the back of the queue (not dropped), then by strength", () => {
    const queue = rankCompaniesForEnrichment(
      V1_PLAN_1,
      [
        cand({ company: "BigCo", pub: "2026-10-09", type: "new_facility", scale: "enterprise" }),
        cand({ company: "NotOperator", pub: "2026-10-09", type: "new_facility", prescreen: { is_third_party_logistics: "no" } }),
        cand({ company: "WeakSmall", pub: "2026-10-01", type: "ops_hire", scale: "small", prescreen: { is_third_party_logistics: "yes" } }),
        cand({ company: "StrongMid", pub: "2026-10-09", type: "new_facility", scale: "mid", prescreen: { is_third_party_logistics: "unclear" } }),
      ],
      monthsAgoIso(3, NOW),
      NOW,
    );
    expect(queue.slice(0, 2)).toEqual(["StrongMid", "WeakSmall"]);
    expect(queue.slice(2).sort()).toEqual(["BigCo", "NotOperator"]);
  });
});

describe("cost guard", () => {
  it("estimates conservatively", () => {
    // observed tiers: $0.007 search up to 25 results, $0.044 at 50; $0.001/summary; 25% margin
    expect(estimateExaCost({ numResults: 25, contents: { summary: {} } })).toBeCloseTo((0.007 + 0.025) * 1.25, 9);
    expect(estimateExaCost({ numResults: 50, contents: { summary: {} } })).toBeCloseTo((0.044 + 0.05) * 1.25, 9);
    expect(estimateExaCost({ numResults: 100 })).toBeCloseTo(0.088 * 1.25, 9);
    expect(estimateExaCost({ category: "company", numResults: 2, contents: { summary: {} } })).toBeCloseTo(0.009 * 1.25, 9);
    // every estimate must cover the actual costs we recorded
    expect(estimateExaCost({ numResults: 50, contents: { summary: {} } })).toBeGreaterThanOrEqual(0.094);
  });

  it("refuses a call when spent + in-flight + estimate would exceed the cap, without calling fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const body = { query: "q", numResults: 10, contents: { summary: {} } };
    const guard = new CostGuard(estimateExaCost(body) * 0.9);
    await expect(
      exaSearch({ query: "q", numResults: 10, contents: { summary: {} } }, { apiKey: "k" }, guard),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reserves in-flight estimates and settles actual cost", () => {
    const g = new CostGuard(0.1);
    g.reserve(0.06);
    expect(() => g.reserve(0.06)).toThrow(BudgetExceededError);
    g.settle(0.06, 0.02);
    expect(g.spent).toBeCloseTo(0.02, 9);
    expect(g.inflight).toBe(0);
    expect(() => g.reserve(0.06)).not.toThrow();
  });
});

// ---- pipeline-level budget + lenient replay (mocked fetch) ----
const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "t", months: 3,
  signalQueries: ["q one", "q two"],
  signalSummaryQuery: "the signal",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"], excludeDomains: [], excludeNames: [],
  signalTypes: ["new_facility", "ops_hire"],
  ...over,
});

const sigResult = (company: string, date = "2026-09-20") => ({
  url: `https://news.example.com/${company}`,
  title: `${company} news`,
  publishedDate: `${date}T00:00:00.000Z`,
  text: `${company} text`,
  summary: JSON.stringify({ company_name: company, signal_type: "new_facility", signal_summary: `${company} opened a facility`, signal_date: date }),
});

function stubExa(signals: unknown[]) {
  const calls: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, any>;
    calls.push(body);
    if (body.category === "company") {
      return new Response(JSON.stringify({
        results: [{ url: `https://${body.query.toLowerCase()}.com`, summary: JSON.stringify({ is_operator: true, employee_estimate: 200, hq: "Austin, TX", is_public_or_enterprise: false }) }],
        costDollars: { total: 0.009 },
      }), { status: 200 });
    }
    if (/RevOps/.test(body.query)) {
      return new Response(JSON.stringify({ results: [], costDollars: { total: 0.005 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: signals, costDollars: { total: 0.01 } }), { status: 200 });
  }));
  return calls;
}

describe("runProspecting budget", () => {
  afterEach(() => vi.unstubAllGlobals());
  const base = { type: "neural" as const, numResults: 1, now: NOW, credentials: { apiKey: "k" } };

  it("skips signal queries that would blow the cap and records budgetStoppedAt", async () => {
    const calls = stubExa([sigResult("A")]);
    // cap fits exactly one query's worst-case reservation in flight
    const perQuery = estimateExaCost({ numResults: 1, contents: { summary: {} } });
    const run = await runProspecting(plan(), { ...base, maxCostDollars: perQuery * 1.5 });
    expect(calls.filter((c) => !c.category)).toHaveLength(1);
    expect(run.funnel.budgetStoppedAt).toBe("signal_search:1");
    expect(run.totalCostDollars).toBeLessThanOrEqual(0.06);
    expect(run.funnel.spentDollars).toBeCloseTo(run.totalCostDollars, 6);
  });

  it("stops enrichment when the remaining budget cannot cover another company", async () => {
    stubExa([sigResult("A"), sigResult("B"), sigResult("C")]);
    const p = plan({
      signalQueries: ["q one"],
      followUp: { queryTemplate: "{company} hiring RevOps", summaryQuery: "hiring?" },
    });
    // signal search settles at its actual 0.01; each company then reserves a lookup
    // plus a 3-result follow-up search -> budget for exactly 2 companies
    const perCompany =
      estimateExaCost({ category: "company" }) + estimateExaCost({ numResults: 3, contents: { summary: {} } });
    const cap = Math.max(0.01 + 2.5 * perCompany, estimateExaCost({ numResults: 1, contents: { summary: {} } }));
    const run = await runProspecting(p, { ...base, maxCostDollars: cap });
    expect(run.enriched).toHaveLength(2);
    expect(run.funnel.selectedForEnrichment).toBe(2);
    expect(run.funnel.cutByEnrichmentLimit).toBe(1);
    expect(run.funnel.budgetStoppedAt).toBe("enrichment:2");
    expect(run.totalCostDollars).toBeLessThanOrEqual(cap);
  });

  it("caps enrichment at 60 companies", async () => {
    stubExa(Array.from({ length: 80 }, (_, i) => sigResult(`Co${i}`)));
    const run = await runProspecting(plan({ signalQueries: ["q"] }), { ...base, numResults: 80, maxCostDollars: 100 });
    expect(run.enriched).toHaveLength(60);
    expect(run.funnel.cutByEnrichmentLimit).toBe(20);
  });
});

describe("lenient replay", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "exa-lenient-")); });
  afterEach(() => {
    delete process.env.EXA_RECORD_DIR; delete process.env.EXA_REPLAY_DIR;
    vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
  });

  it("counts a missing company-lookup recording as replayMiss; signal misses and strict mode still throw", async () => {
    const opts = { type: "neural" as const, numResults: 2, now: NOW, credentials: { apiKey: "k" } };
    const p = plan({ signalQueries: ["q one"] });
    stubExa([sigResult("A"), sigResult("B")]);
    process.env.EXA_RECORD_DIR = dir;
    await runProspecting(p, opts);
    delete process.env.EXA_RECORD_DIR;
    for (const f of readdirSync(dir)) {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { request: { category?: string } };
      if (rec.request.category === "company") unlinkSync(join(dir, f));
    }

    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    process.env.EXA_REPLAY_DIR = dir;
    await expect(runProspecting(p, opts)).rejects.toThrow(/replay miss/);
    const run = await runProspecting(p, { ...opts, lenientReplay: true });
    expect(never).not.toHaveBeenCalled();
    expect(run.funnel.replayMiss).toBe(2);
    expect(run.rows).toEqual([]);
    expect(run.funnel.rejections.no_enrichment).toBe(2);

    // a signal-search miss throws even when lenient
    await expect(
      runProspecting(plan({ signalQueries: ["unrecorded query"] }), { ...opts, lenientReplay: true }),
    ).rejects.toThrow(/replay miss/);
  });
});
