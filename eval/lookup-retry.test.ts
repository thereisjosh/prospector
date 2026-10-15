import { rm } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "lookup-retry-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.EXA_API_KEY ??= "test-key";
  return { root };
});
import type { SearchPlan } from "../src/plan";
import { createRunState, type RunState } from "../src/agent/state";
import { step } from "../src/agent/loop";
import { executeTool, type ToolDeps } from "../src/agent/tools";
import { BudgetExceededError, CostGuard, ExaNetworkError, QUOTE_RETRY_SUFFIX, lookupCompany, requestHash } from "../src/exa";
import { quoteInText, squashName } from "../src/gates";
import type { LeadChecker } from "../src/agent/gate-port";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const plan: SearchPlan = {
  label: "Retry test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_3pl", question: "Is it a 3PL?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};

const PAGE = "# SpartanCo SpartanCo is a Transportation, Logistics, Supply Chain and Storage company that provides 3PL, warehousing, and transportation services. SpartanCo employs 281 people.";
const GOOD_QUOTE = "SpartanCo is a Transportation, Logistics, Supply Chain and Storage company that provides 3PL, warehousing, and transportation services";
const BAD_QUOTE = "SpartanCo is a logistics company; it provides contract warehousing and fulfillment on a nationwide basis";

const looked = (quote: string, over: Record<string, unknown> = {}, text = PAGE) => ({
  result: { url: "https://spartanco.example/", title: "SpartanCo", text },
  summary: { description: "SpartanCo", employee_estimate: 281, employee_estimate_source: "SpartanCo employs 281 people", hq: "Columbus, United States", hq_quote: "Columbus", is_3pl: true, is_3pl_quote: quote, ...over },
  costDollars: { total: 0.01 },
});

// Fake gate: verifies the lookup quote the same way checkLead does and reports the failing key.
const checker: LeadChecker = (_plan, input) => {
  const q = input.enrichment?.is_3pl_quote;
  if (typeof q === "string" && input.lookupText && !quoteInText(q, input.lookupText)) {
    return { ok: false, code: "quote_not_in_page", reason: "quote for required gate \"is_3pl\" was not found in the lookup page text", details: { key: "is_3pl" } };
  }
  return { ok: true, details: { key: squashName(input.company), event_date: "2026-10-01", date_source: "signal", employees: 281, size_basis: "quoted", required_gates_passed: ["is_3pl"], optional_gates_passed: [], hq: "Columbus", multiplier: 1, fit_reason: "t" } };
};

function mkState(over: Partial<RunState> = {}): RunState {
  return { ...createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan, createdAt: "2026-10-12T00:00:00.000Z" }), strategyApproved: true, ...over } as RunState;
}
const call = (s: RunState, deps: Partial<ToolDeps>, name = "SpartanCo", guard = new CostGuard(1)) =>
  executeTool(s, { id: crypto.randomUUID(), name: "lookup_company", input: { name } }, { checkLead: checker, now: NOW, ...deps } as ToolDeps, { guard });

afterAll(() => rm(tmp.root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("lookup_company quote retry", () => {
  it("fails first, passes second: retries once with the strict option, keeps the retry, emits the event data", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(looked(BAD_QUOTE)).mockResolvedValueOnce(looked(GOOD_QUOTE));
    const s = mkState();
    const r = await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]).toHaveLength(5);
    expect(lookup.mock.calls[1]![5]).toEqual({ quoteRetry: true });
    expect(s.caches.enrichmentByName[squashName("SpartanCo")]!.summary.is_3pl_quote).toBe(GOOD_QUOTE);
    expect(s.lookupRetries).toEqual([squashName("SpartanCo")]);
    expect(r.exaCost).toBeCloseTo(0.02);
    expect(r.lookupRetry).toMatchObject({ company: "SpartanCo", reason: "quote_not_in_page", key: "is_3pl", before: "rejected", after: "accepted", outcome: "kept_retry", retryExaCost: 0.01 });
    expect(r.result.is_error).toBeUndefined();
  });

  it("with a known signal the better-of-two uses the gate verdict (rejected -> accepted)", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(looked(BAD_QUOTE)).mockResolvedValueOnce(looked(GOOD_QUOTE));
    const s = mkState();
    s.caches.signalsByUrl["https://n.example/a"] = { url: "https://n.example/a", title: "SpartanCo news", summary: { company_name: "SpartanCo", signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" } } as never;
    const r = await call(s, { lookupCompany: lookup as never });
    expect(r.lookupRetry).toMatchObject({ before: "rejected", after: "accepted", outcome: "kept_retry" });
    expect(s.screened ?? []).toEqual([]);
  });

  it("fails both: keeps the first, one retry only, no third lookup on a repeat call", async () => {
    const lookup = vi.fn().mockResolvedValue(looked(BAD_QUOTE));
    const s = mkState();
    const r = await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.lookupRetry).toMatchObject({ before: "rejected", after: "rejected", outcome: "kept_first" });
    expect(s.caches.enrichmentByName[squashName("SpartanCo")]!.summary.is_3pl_quote).toBe(BAD_QUOTE);
    await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the quote is fine, the gate is false, the page is truncated, or the key is not a required gate", async () => {
    for (const first of [
      looked(GOOD_QUOTE),
      looked(BAD_QUOTE, { is_3pl: false }),
      looked(BAD_QUOTE, { lookup_text_truncated: true }),
      looked(GOOD_QUOTE, { employee_estimate_source: "281 employees" }),
      looked(GOOD_QUOTE, { hq_quote: "Atlantis" }),
    ]) {
      const lookup = vi.fn().mockResolvedValue(first);
      const r = await call(mkState(), { lookupCompany: lookup as never });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(r.lookupRetry).toBeUndefined();
    }
  });

  it("a retry that cannot run (budget) keeps the first result and says so", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(looked(BAD_QUOTE)).mockRejectedValueOnce(new BudgetExceededError("cap"));
    const r = await call(mkState(), { lookupCompany: lookup as never });
    expect(r.lookupRetry).toMatchObject({ outcome: "skipped_budget", after: "error", error: "cap" });
    expect(r.result.is_error).toBeUndefined();
  });

  it("a retry that returns a worse lookup does not replace the first (candidate beats rejected is by verdict, ties keep the first)", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(looked(BAD_QUOTE)).mockResolvedValueOnce(looked("not on the page at all, really"));
    const s = mkState();
    await call(s, { lookupCompany: lookup as never });
    expect(s.caches.enrichmentByName[squashName("SpartanCo")]!.summary.is_3pl_quote).toBe(BAD_QUOTE);
  });

  it("real lookupCompany path: both calls go through the CostGuard, the second request carries the suffix and a different hash", async () => {
    const bodies: Array<Record<string, any>> = [];
    const replies = [looked(BAD_QUOTE), looked(GOOD_QUOTE)].map((l) => ({
      results: [{ url: l.result.url, title: "SpartanCo", text: l.result.text, summary: JSON.stringify(l.summary) }],
      costDollars: { total: 0.009 },
    }));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
    }));
    const guard = new CostGuard(1);
    const s = mkState();
    const r = await call(s, { credentials: { apiKey: "k" } }, "SpartanCo", guard);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.contents.summary.query).not.toContain(QUOTE_RETRY_SUFFIX);
    expect(bodies[1]!.contents.summary.query).toContain(QUOTE_RETRY_SUFFIX);
    expect(bodies[1]!.contents.summary.query).toContain("[quote retry 1]");
    expect(requestHash(bodies[0]!)).not.toBe(requestHash(bodies[1]!));
    expect(guard.spent).toBeCloseTo(0.018);
    expect(r.exaCost).toBeCloseTo(0.018);
    expect(r.lookupRetry?.outcome).toBe("kept_retry");
  });
});

describe("lookup_company network errors", () => {
  const netErr = () => new ExaNetworkError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "api.exa.ai");

  it("ExaNetworkError names the underlying cause and the host", () => {
    expect(netErr().message).toContain("ECONNRESET");
    expect(netErr().message).toContain("api.exa.ai");
    expect(netErr().message).not.toMatch(/^fetch failed$/);
  });

  it("the real fetch path wraps a rejected fetch (cause surfaced) instead of a bare 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); }));
    const err = await lookupCompany("SpartanCo", "q", {}, { apiKey: "k" }, new CostGuard(1)).catch((e) => e);
    expect(err).toBeInstanceOf(ExaNetworkError);
    expect(err.message).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("first attempt fails on the network, the one retry succeeds: the company is not lost", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(netErr()).mockResolvedValueOnce(looked(GOOD_QUOTE));
    const s = mkState();
    const r = await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.result.is_error).toBeUndefined();
    expect(r.lookupRetry).toMatchObject({ reason: "network", key: "ECONNRESET", outcome: "recovered", retryExaCost: 0.01 });
    expect(s.caches.enrichmentByName[squashName("SpartanCo")]).toBeDefined();
  });

  it("fails twice: an error that names the cause and the retry; not cached; later calls get a fresh single attempt", async () => {
    const lookup = vi.fn().mockRejectedValue(netErr());
    const s = mkState();
    const r = await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.result.is_error).toBe(true);
    expect(String(r.result.content)).toContain("ECONNRESET");
    expect(String(r.result.content)).toContain("retried once");
    expect(r.lookupRetry).toMatchObject({ outcome: "retry_failed" });
    expect(s.caches.enrichmentByName[squashName("SpartanCo")]).toBeUndefined();
    const again = await call(s, { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(3); // the cap is spent: no automatic retry
    expect(again.result.is_error).toBe(true);
  });

  it("the cap is one per company per run across both kinds", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(netErr()).mockResolvedValueOnce(looked(BAD_QUOTE));
    const r = await call(mkState(), { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.lookupRetry?.reason).toBe("network");
  });

  it("an HTTP error is not retried by this path", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("Exa search failed HTTP 400: bad"));
    const r = await call(mkState(), { lookupCompany: lookup as never });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(r.lookupRetry).toBeUndefined();
  });
});

describe("loop emits lookup_retry", () => {
  it("writes a lookup_retry event next to the tool_call", async () => {
    const lookup = vi.fn().mockResolvedValueOnce(looked(BAD_QUOTE)).mockResolvedValueOnce(looked(GOOD_QUOTE));
    const s = mkState();
    const c = { messages: { create: vi.fn(async () => ({
      id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "l1", name: "lookup_company", input: { name: "SpartanCo" } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })) } };
    const out = await step(s, { client: c as never, checkLead: checker, now: NOW, lookupCompany: lookup as never });
    const kinds = out.events.map((e) => e.kind);
    expect(kinds.indexOf("lookup_retry")).toBe(kinds.indexOf("tool_call") + 1);
    expect(out.events.find((e) => e.kind === "lookup_retry")).toMatchObject({ company: "SpartanCo", reason: "quote_not_in_page", key: "is_3pl", outcome: "kept_retry", toolUseId: "l1" });
  });
});
