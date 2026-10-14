import { afterEach, describe, expect, it, vi } from "vitest";
import { runProspecting } from "../src/pipeline";
import type { SearchPlan } from "../src/plan";

const NOW = new Date("2026-10-11T03:00:00.000Z");

const plan: SearchPlan = {
  label: "Budget test",
  months: 3,
  signalQueries: ["q"],
  signalSummaryQuery: "the signal",
  followUp: { queryTemplate: "{company} hiring ops", summaryQuery: "hiring?" },
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion", "ops_hire"],
};

const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];

const signal = (company: string) => ({
  url: `https://news.example/${company}`,
  title: `${company} expands`,
  publishedDate: "2026-10-01T00:00:00.000Z",
  text: `${company} expanded in Ohio.`,
  summary: JSON.stringify({ company_name: company, signal_type: "expansion", signal_summary: `${company} expanded`, signal_date: "2026-10-01", signal_quote: `${company} expands`, signal_date_quote: "" }),
});

afterEach(() => vi.unstubAllGlobals());

/** A fetch mock that serves signals, lookups and follow-ups, with a per-kind failure hook. */
function stub(opts: { lookupCost?: number; followUpCost?: number; failLookupWith?: number } = {}) {
  let followUps = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, any>;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    if (body.category === "company") {
      calls.push(`lookup:${body.query}`);
      if (opts.failLookupWith) return new Response("{}", { status: opts.failLookupWith });
      return new Response(JSON.stringify({
        results: [{ url: `https://${String(body.query).toLowerCase()}.com`, text: `${body.query} is an operator. 200 employees. Austin, TX.`, summary: JSON.stringify({ is_operator: true, is_operator_quote: `${body.query} is an operator`, employee_estimate: 200, employee_estimate_source: "200 employees", hq: "Austin, TX", hq_quote: "Austin, TX", is_public_or_enterprise: false }) }],
        costDollars: { total: opts.lookupCost ?? 0.009 },
      }), { status: 200 });
    }
    if (/hiring ops/.test(body.query)) {
      calls.push(`followup:${body.query}`);
      followUps += 1;
      return new Response(JSON.stringify({ results: [], costDollars: { total: opts.followUpCost ?? 0.005 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: names.map(signal), costDollars: { total: 0.05 } }), { status: 200 });
  }));
  return { calls, get followUps() { return followUps; }, get maxInFlight() { return maxInFlight; } };
}

const opts = (maxCostDollars: number) => ({ type: "neural" as const, numResults: 6, now: NOW, credentials: { apiKey: "k" }, maxCostDollars });

describe("workflow never throws on budget", () => {
  it("a guard that refuses mid-way (tight cap) skips lookups/follow-ups, records them, and still scores", async () => {
    // Real costs run above the pre-flight estimates, so the guard refuses mid-way even though
    // enrichment was planned to fit.
    const s = stub({ lookupCost: 0.03, followUpCost: 0.045 });
    const run = await runProspecting(plan, opts(0.36));
    expect(run.funnel.skippedLookups + run.funnel.skippedFollowUps).toBeGreaterThan(0);
    expect(run.funnel.budgetStoppedAt).toBeTruthy();
    expect(run.rows.length).toBeGreaterThan(0); // completed with what it had
    expect(run.funnel.skippedFollowUps).toBeGreaterThan(0);
    expect(s.followUps).toBeLessThan(names.length);
    expect(s.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("follow-ups are reserved in ranked order: the best candidates get them first", async () => {
    const s = stub({ lookupCost: 0.03, followUpCost: 0.045 });
    const run = await runProspecting(plan, opts(0.36));
    const followed = s.calls.filter((c) => c.startsWith("followup:")).map((c) => c.split(" ")[0]!.replace("followup:", ""));
    // whoever got a follow-up is a prefix of the enriched (ranked) order
    expect(run.enriched.slice(0, followed.length).sort()).toEqual([...followed].sort());
  });

  it("plenty of budget: nothing skipped", async () => {
    stub();
    const run = await runProspecting(plan, opts(5));
    expect(run.funnel).toMatchObject({ skippedLookups: 0, skippedFollowUps: 0, budgetStoppedAt: null });
    expect(run.rows).toHaveLength(names.length);
  });

  it("a non-budget failure carries the spend so far on the error", async () => {
    stub({ failLookupWith: 401 });
    const err = await runProspecting(plan, opts(5)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.spendDollars).toBeCloseTo(0.05, 6); // the signal search had settled; lookups failed
  });
});
