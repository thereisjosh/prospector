import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every test that writes state uses a temp RUNS_DIR / WORKSPACES_DIR, never the real ./runs.
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "agent-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  return { root, runs: join(root, "runs"), workspaces: join(root, "workspaces") };
});
import type { SearchPlan } from "../src/plan";
import { createRunState, loadState, saveState, screenedByCode, StaleStateError, type RunState } from "../src/agent/state";
import { codeHandback, decide, rejectionCounts, step, stopRun } from "../src/agent/loop";
import { agentTools, validHandback } from "../src/agent/tools";
import { InvalidIdError } from "../src/agent/ids";
import { eventInput, readLastEvents, appendEvents } from "../src/agent/events";
import { clearMemory, saveMemory as saveMem } from "../src/agent/memory";
import { resolveDataDirs } from "../src/agent/config";
import type { LeadChecker } from "../src/agent/gate-port";
import { appendRunToMemory, loadMemory, saveMemory, squashName } from "../src/agent/memory";
import { CostGuard, estimateExaCost, ReplayMissError } from "../src/exa";
import { readExaContents } from "../src/agent/exa-contents";

const NOW = new Date("2026-10-12T00:00:00.000Z");

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "Agent test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
  ...over,
});

function msg(stop_reason: string, content: unknown[], usage = {}) {
  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, ...usage },
  };
}

function text(value: string) {
  return { type: "text", text: value };
}

function tool(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

function client(...responses: unknown[]) {
  return { messages: { create: vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }) } };
}

const checker: LeadChecker = (_p, input) => {
  if (input.company.includes("Bad")) return { ok: false, code: "required_gate:is_operator", reason: "not an operator" };
  return {
    ok: true,
    details: {
      key: squashName(input.company),
      event_date: "2026-10-01",
      date_source: "signal",
      employees: 200,
      size_basis: "quoted",
      required_gates_passed: ["is_operator"],
      optional_gates_passed: [],
      hq: "Austin, United States",
      multiplier: 1,
      fit_reason: "test fit",
    },
  };
};

function state(over: Partial<RunState> = {}) {
  return {
    ...createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan: plan(), createdAt: "2026-10-12T00:00:00.000Z" }),
    ...over,
  } as RunState;
}

const signalResult = {
  results: [{
    url: "https://news.example/good",
    title: "GoodCo expands",
    publishedDate: "2026-10-01T00:00:00.000Z",
    text: "GoodCo expands.",
    summary: JSON.stringify({
      company_name: "GoodCo",
      signal_type: "expansion",
      signal_summary: "GoodCo opened a warehouse.",
      signal_date: "2026-10-01",
    }),
  }],
  costDollars: { total: 0.01 },
};

const lookupResult = {
  result: { url: "https://good.example" },
  summary: { description: "GoodCo", industry: "Logistics", employee_estimate: 200, employee_estimate_source: "200 employees", is_public_or_enterprise: false, hq: "Austin, TX", is_operator: true },
};

function toolResults(s: RunState) {
  return (s.messages.at(-1)!.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean; text?: string }>).filter((r) => r.type === "tool_result");
}

function lastText(s: RunState) {
  return (s.messages.at(-1)!.content as Array<{ type: string; text?: string }>).filter((r) => r.type === "text").at(-1)?.text;
}

afterAll(() => rm(tmp.root, { recursive: true, force: true }));

beforeEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp.runs, { recursive: true, force: true });
  await rm(tmp.workspaces, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp.runs, { recursive: true, force: true });
  await rm(tmp.workspaces, { recursive: true, force: true });
});

describe("agent loop", () => {
  it("runs search -> lookup -> submit -> finish end to end", async () => {
    const s = state();
    const c = client(
      msg("tool_use", [tool("p", "propose_strategy", { angles: ["expansion"], first_queries: ["warehouse"], est_cost_dollars: 0.1 })]),
      msg("tool_use", [tool("s", "search_signals", { query: "warehouse expansion", num_results: 10 })]),
      msg("tool_use", [tool("l", "lookup_company", { name: "GoodCo" })]),
      msg("tool_use", [tool("sub", "submit_lead", { company: "GoodCo", signal_url: "https://news.example/good", why_now: "opened warehouse" })]),
      msg("tool_use", [tool("f", "finish", { summary: "done" })]),
    );
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("awaiting_approval");
    expect(s.messages.at(-1)?.role).toBe("assistant");
    await decide(s, { approve: true });
    await step(s, { client: c as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async () => signalResult) as never });
    await step(s, { client: c as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => lookupResult) as never });
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("done");
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0]?.company).toBe("GoodCo");
  });

  it("parallel tool_use blocks produce one user message with matching tool_result ids", async () => {
    const s = state();
    const c = client(msg("tool_use", [
      tool("a", "update_todo", { markdown: "- one" }),
      tool("b", "update_todo", { markdown: "- two" }),
    ]));
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    const last = s.messages.at(-1)!;
    expect(last.role).toBe("user");
    const content = toolResults(s);
    expect(content.map((r) => r.type)).toEqual(["tool_result", "tool_result"]);
    expect(content.map((r) => r.tool_use_id).sort()).toEqual(["a", "b"]);
  });

  it("tool executor errors become is_error tool_results and the run continues", async () => {
    const s = state({ strategyApproved: true });
    const c = client(msg("tool_use", [tool("x", "read_page", { url: "https://x.example" })]));
    await step(s, {
      client: c as never,
      checkLead: checker,
      now: NOW,
      readExaContents: vi.fn(async () => { throw new Error("contents failed"); }) as never,
    });
    expect(s.status).toBe("running");
    const result = toolResults(s)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("contents failed");
  });

  it("approval pauses without appending a user message, then decide appends one combined message", async () => {
    const s = state();
    const c = client(msg("tool_use", [
      tool("todo", "update_todo", { markdown: "- search" }),
      tool("approval", "request_scope_change", { change: { field: "months", value: 6 }, reason: "stale", evidence: "many stale" }),
    ]));
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("awaiting_approval");
    expect(s.messages.at(-1)?.role).toBe("assistant");
    await decide(s, { approve: true });
    expect(s.status).toBe("running");
    expect(s.contract.months).toBe(6);
    const content = toolResults(s);
    expect(content.map((r) => r.tool_use_id)).toEqual(["todo", "approval"]);
    expect(content.at(-1)?.content).toBe("approved");
  });

  it("approved request_scope_change records invalid code-updated values as a declined result", async () => {
    const s = state({
      status: "awaiting_approval",
      pendingApproval: {
        toolUseId: "approval",
        tool: "request_scope_change",
        input: { change: { field: "months", value: 99 }, reason: "x", evidence: "y" },
        otherToolResults: [],
      },
    });
    await decide(s, { approve: true });
    expect(s.status).toBe("running");
    expect(toolResults(s)[0]?.content).toContain("declined: invalid value — invalid months");
  });

  it("save/load round-trips messages byte-identically", async () => {
    const s = state();
    s.messages.push({ role: "assistant", content: [text("hello"), { type: "thinking", thinking: "keep me", signature: "sig" }] } as never);
    const before = JSON.stringify(s.messages);
    await saveState(s);
    const loaded = await loadState(s.id);
    expect(JSON.stringify(loaded.messages)).toBe(before);
  });

  it("budget limit computes code handback when the reserved model call fails", async () => {
    const s = state({ spend: { exa: 0.96, claude: 0, total: 0.96 }, rejected: [{ company: "X", code: "size", reason: "too large", turn: 1 }] });
    const c = client(new Error("model unavailable"));
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("stopped");
    expect(s.stopReason).toBe("budget");
    expect(s.handback?.top_reasons).toEqual([{ code: "size", count: 1 }]);
  });

  it("stops on no-progress limit", async () => {
    const s = state({ counters: { turns: 2, activeMs: 0, noProgressTurns: 4, toolCalls: 0 } });
    await step(s, { client: client(new Error("should not call")) as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("stopped");
    expect(s.stopReason).toBe("no_progress");
  });

  it("submit_lead rejection reason is returned and recorded", async () => {
    const s = state();
    s.caches.signalsByUrl["https://news.example/bad"] = {
      url: "https://news.example/bad",
      title: "BadCo expands",
      summary: { company_name: "BadCo", signal_type: "expansion", signal_summary: "BadCo expands.", signal_date: "2026-10-01" },
    };
    s.caches.enrichmentByName.badco = { summary: { description: "BadCo" } };
    await step(s, { client: client(msg("tool_use", [tool("sub", "submit_lead", { company: "BadCo", signal_url: "https://news.example/bad", why_now: "x" })])) as never, checkLead: checker, now: NOW });
    expect(s.rejected[0]).toMatchObject({ company: "BadCo", code: "required_gate:is_operator" });
    expect(JSON.stringify(s.messages.at(-1))).toContain("rejected: required_gate:is_operator");
  });

  it("state.leads only contains checker-accepted leads even if final text claims more", async () => {
    const s = state();
    await step(s, { client: client(msg("end_turn", [text("I found 10 leads: FakeCo")])) as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("done");
    expect(s.leads).toEqual([]);
  });

  it("accounts Claude cost from usage including cache tokens", async () => {
    const s = state();
    await step(s, { client: client(msg("end_turn", [text("done")], { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })) as never, checkLead: checker, now: NOW });
    expect(s.spend.claude).toBeCloseTo(29.2, 6);
  });

  it("memory feeds seen names, appends run outcomes, and preference notes enter the first message", async () => {
    await saveMemory("w", {
      seen: [{ name: "OldCo LLC", squashed: squashName("OldCo LLC"), verdict: "rejected", reason: "bad", runId: "old", at: NOW.toISOString() }],
      preferenceNotes: ["avoid captive shippers"],
    });
    const mem = await loadMemory("w");
    const s = createRunState({ id: "memory-run", workspaceId: "w", plan: plan(), preferenceNotes: mem.preferenceNotes, seenKeys: mem.seen.map((m) => m.squashed) });
    expect(JSON.stringify(s.messages[0])).toContain("avoid captive shippers");
    expect(s.caches.seenKeys).toContain(squashName("OldCo LLC"));
    s.leads.push({
      company: "GoodCo",
      signal_url: "https://news.example/good",
      why_now: "x",
      summary: { company_name: "GoodCo", signal_type: "expansion", signal_summary: "x", signal_date: "2026-10-01" },
      details: {},
      turn: 1,
    });
    s.rejected.push({ company: "BadCo", code: "size", reason: "too large", turn: 1 });
    await appendRunToMemory(s);
    const after = await loadMemory("w");
    expect(after.seen.map((m) => m.name)).toEqual(["OldCo LLC", "GoodCo", "BadCo"]);
  });

  it("A2b #1 shares one Exa CostGuard across parallel tools and refuses over-cap reservations", async () => {
    const s = state({ strategyApproved: true });
    const mkResult = (company: string, url: string) => ({
      results: [{ ...signalResult.results[0], url, summary: JSON.stringify({ company_name: company, signal_type: "expansion", signal_summary: `${company} expands.`, signal_date: "2026-10-01" }) }],
      costDollars: { total: 0.01 },
    });
    const search = vi.fn(async (body: Record<string, unknown>, _credentials: unknown, guard: { reserve: (n: number) => void; settle: (e: number, a?: number) => void }) => {
      guard.reserve(0.005);
      await Promise.resolve();
      guard.settle(0.005, 0.01);
      return mkResult(String(body.query), `https://news.example/${String(body.query)}`);
    });
    await step(s, { client: client(msg("tool_use", [
      tool("s1", "search_signals", { query: "a" }),
      tool("s2", "search_signals", { query: "b" }),
      tool("s3", "search_signals", { query: "c" }),
    ])) as never, checkLead: checker, now: NOW, exaSearch: search as never });
    expect(s.spend.exa).toBeCloseTo(0.03, 6);

    const capped = state({ strategyApproved: true, contract: { ...state().contract, maxCostDollars: 0.06 } });
    let fetched = 0;
    const overCap = vi.fn(async (_body: unknown, _credentials: unknown, guard: { reserve: (n: number) => void; settle: (e: number, a?: number) => void }) => {
      guard.reserve(0.07);
      fetched += 1;
      guard.settle(0.07, 0.01);
      return signalResult;
    });
    await step(capped, { client: client(msg("tool_use", [tool("s", "search_signals", { query: "x" })])) as never, checkLead: checker, now: NOW, exaSearch: overCap as never });
    expect(fetched).toBe(0);
    expect(capped.status).toBe("stopped");
    expect(capped.stopReason).toBe("budget");
  });

  it("A2b #2 runs lookup before submit in the same turn while preserving original result order", async () => {
    const s = state({ strategyApproved: true });
    s.caches.signalsByUrl["https://news.example/good"] = signalResult.results[0] as never;
    await step(s, { client: client(msg("tool_use", [
      tool("lookup", "lookup_company", { name: "GoodCo" }),
      tool("submit", "submit_lead", { company: "GoodCo", signal_url: "https://news.example/good", why_now: "opened warehouse" }),
    ])) as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => lookupResult) as never });
    expect(s.leads.map((lead) => lead.company)).toEqual(["GoodCo"]);
    expect(toolResults(s).map((r) => r.tool_use_id)).toEqual(["lookup", "submit"]);
  });

  it("A2b #3 keys enrichment cache by squashName for lookup and submit variants", async () => {
    const s = state({ strategyApproved: true });
    s.caches.signalsByUrl["https://news.example/acme"] = {
      url: "https://news.example/acme",
      title: "Acme Logistics opens",
      text: "Acme Logistics opens a warehouse.",
      publishedDate: "2026-10-01T00:00:00.000Z",
      summary: { company_name: "Acme Logistics", signal_type: "expansion", signal_summary: "Acme Logistics opens a warehouse.", signal_date: "2026-10-01" },
    };
    const acmeLookup = { result: { url: "https://acme.example" }, summary: { ...lookupResult.summary, description: "Acme", hq: "Austin, United States" } };
    await step(s, { client: client(msg("tool_use", [
      tool("lookup", "lookup_company", { name: "Acme Logistics Inc" }),
      tool("submit", "submit_lead", { company: "Acme Logistics", signal_url: "https://news.example/acme", why_now: "opened warehouse" }),
    ])) as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => acmeLookup) as never });
    expect(Object.keys(s.caches.enrichmentByName)).toEqual([squashName("Acme Logistics Inc")]);
    expect(s.leads).toHaveLength(1);
  });

  it("A2b #4 lookup_company returns size quote, enterprise flag, HQ, and marked gate verdicts", async () => {
    const s = state({
      strategyApproved: true,
      contract: { ...state().contract, gateFields: [
        { key: "is_operator", question: "Is it an operator?", required: true },
        { key: "has_wms", question: "Has WMS?", required: false },
        { key: "unknown_gate", question: "Unknown?", required: false },
      ] },
    });
    const rich = { result: { url: "https://good.example" }, summary: { ...lookupResult.summary, hq: "Austin, United States", has_wms: false } };
    await step(s, { client: client(msg("tool_use", [tool("lookup", "lookup_company", { name: "GoodCo" })])) as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => rich) as never });
    const content = toolResults(s)[0]?.content ?? "";
    expect(content).toContain("employees=200");
    expect(content).toContain("employee_source_quote=200 employees");
    expect(content).toContain("is_public_or_enterprise=no");
    expect(content).toContain("hq=Austin, United States");
    expect(content).toContain("is_operator=yes (required)");
    expect(content).toContain("has_wms=no (optional)");
    expect(content).toContain("unknown_gate=unknown (optional)");
  });

  it("A2b #5 finish stores valid handback without a second model call and invalid handback uses fallback", async () => {
    const valid = state();
    const validClient = client(msg("tool_use", [tool("finish", "finish", {
      summary: "done",
      handback: { shortfall: "0 of 10", top_reasons: [], suggestions: [{ field: "months", value: 6, why: "more signals" }] },
    })]));
    await step(valid, { client: validClient as never, checkLead: checker, now: NOW });
    expect(valid.status).toBe("done");
    expect(valid.summary).toBe("done");
    expect(valid.handback?.suggestions).toHaveLength(1);
    expect(validClient.messages.create).toHaveBeenCalledTimes(1);

    const invalid = state({ rejected: [{ company: "X", code: "size", reason: "too large", turn: 1 }] });
    const invalidClient = client(
      msg("tool_use", [tool("finish", "finish", { summary: "done", handback: { shortfall: "x", top_reasons: [], suggestions: [{}, {}, {}] } })]),
      msg("end_turn", [text("not json")]),
    );
    await step(invalid, { client: invalidClient as never, checkLead: checker, now: NOW });
    expect(invalid.handback?.top_reasons).toEqual([{ code: "size", count: 1 }]);
    expect(invalidClient.messages.create).toHaveBeenCalledTimes(2);
  });

  it("A2b #6 enforces strategy approval before spend but allows todo and finish", async () => {
    const blocked = state();
    const search = vi.fn(async () => signalResult);
    await step(blocked, { client: client(msg("tool_use", [
      tool("s", "search_signals", { query: "warehouse" }),
      tool("todo", "update_todo", { markdown: "- waiting" }),
    ])) as never, checkLead: checker, now: NOW, exaSearch: search as never });
    expect(search).not.toHaveBeenCalled();
    expect(toolResults(blocked).find((r) => r.tool_use_id === "s")?.content).toContain("Call propose_strategy");
    expect(toolResults(blocked).find((r) => r.tool_use_id === "todo")?.content).toBe("ok");

    const approved = state();
    await step(approved, { client: client(msg("tool_use", [tool("p", "propose_strategy", { angles: [], first_queries: [], est_cost_dollars: 0 })])) as never, checkLead: checker, now: NOW });
    await decide(approved, { approve: true, note: "looks good" });
    expect(approved.strategyApproved).toBe(true);
    await step(approved, { client: client(msg("tool_use", [tool("s", "search_signals", { query: "warehouse" })])) as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async () => signalResult) as never });
    expect(toolResults(approved)[0]?.is_error).not.toBe(true);

    const declined = state();
    await step(declined, { client: client(msg("tool_use", [tool("p", "propose_strategy", { angles: [], first_queries: [], est_cost_dollars: 0 })])) as never, checkLead: checker, now: NOW });
    await decide(declined, { approve: false, note: "try another angle" });
    expect(declined.strategyApproved).toBe(false);
    expect(JSON.stringify(declined.messages.at(-1))).toContain("declined: try another angle");
  });

  it("A2b #7 allows one approval request per turn and answers every tool_use after decide", async () => {
    const s = state();
    await step(s, { client: client(msg("tool_use", [
      tool("p1", "propose_strategy", { angles: ["a"], first_queries: ["q"], est_cost_dollars: 0.1 }),
      tool("p2", "propose_strategy", { angles: ["b"], first_queries: ["r"], est_cost_dollars: 0.1 }),
    ])) as never, checkLead: checker, now: NOW });
    expect(s.status).toBe("awaiting_approval");
    expect(s.pendingApproval?.toolUseId).toBe("p1");
    expect(s.pendingApproval?.otherToolResults[0]).toMatchObject({ tool_use_id: "p2", is_error: true, content: "one approval request per turn" });
    await decide(s, { approve: true });
    expect(toolResults(s).map((r) => r.tool_use_id)).toEqual(["p1", "p2"]);
  });

  it("A2b #8 decide always includes approval notes when present", async () => {
    const cases = [
      [{ approve: true }, "approved"],
      [{ approve: true, note: "ship it" }, "approved: ship it"],
      [{ approve: true, note: "use this", revisedValue: 6 }, "revised: use this"],
      [{ approve: false }, "declined"],
      [{ approve: false, note: "too broad" }, "declined: too broad"],
    ] as const;
    for (const [decision, expected] of cases) {
      const s = state({ status: "awaiting_approval", pendingApproval: { toolUseId: "p", tool: "propose_strategy", input: {}, otherToolResults: [] } });
      await decide(s, decision);
      expect(toolResults(s)[0]?.content).toBe(expected);
    }
  });

  it("A2b #9 invalid scope-change approval is declined in history and emits a decision error", async () => {
    const s = state({
      status: "awaiting_approval",
      pendingApproval: { toolUseId: "approval", tool: "request_scope_change", input: { change: { field: "months", value: 99 }, reason: "x", evidence: "y" }, otherToolResults: [] },
    });
    const result = await decide(s, { approve: true });
    expect(s.contract.months).toBe(3);
    expect(s.pendingApproval).toBeUndefined();
    expect(s.status).toBe("running");
    expect(toolResults(s)[0]?.content).toBe("declined: invalid value — invalid months");
    expect(result.events[0]).toMatchObject({ kind: "decision", error: "invalid months" });
  });

  it("A2b #10 treats new enrichments as progress so lookup-only turns do not stop the run", async () => {
    const s = state({ strategyApproved: true });
    const lookup = vi.fn(async (name: string) => ({ result: { url: `https://${name}.example` }, summary: { ...lookupResult.summary, description: name } }));
    for (const name of ["A", "B", "C", "D"]) {
      await step(s, { client: client(msg("tool_use", [tool(`l-${name}`, "lookup_company", { name })])) as never, checkLead: checker, now: NOW, lookupCompany: lookup as never });
      expect(s.status).toBe("running");
    }
    expect(s.counters.noProgressTurns).toBe(0);
    expect(Object.keys(s.caches.enrichmentByName)).toHaveLength(4);
  });

  it("A2b #11 sends top-level ephemeral cache_control on step and handback model calls", async () => {
    const s = state();
    const c = { messages: { create: vi.fn(async (params: { cache_control?: unknown }) => {
      expect(params.cache_control).toEqual({ type: "ephemeral" });
      return msg("tool_use", [tool("todo", "update_todo", { markdown: "- one" })]);
    }) } };
    await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(c.messages.create).toHaveBeenCalledTimes(1);

    const budget = state({ spend: { exa: 0.96, claude: 0, total: 0.96 } });
    const h = { messages: { create: vi.fn(async (params: { cache_control?: unknown }) => {
      expect(params.cache_control).toEqual({ type: "ephemeral" });
      return msg("end_turn", [text(JSON.stringify({ shortfall: "0 of 10", top_reasons: [], suggestions: [] }))]);
    }) } };
    await step(budget, { client: h as never, checkLead: checker, now: NOW });
    expect(h.messages.create).toHaveBeenCalledTimes(1);
  });

  it("A2b #12 appends spend recitation as the last block after tool results and decisions", async () => {
    const s = state();
    await step(s, { client: client(msg("tool_use", [tool("todo", "update_todo", { markdown: "- one" })])) as never, checkLead: checker, now: NOW });
    expect(lastText(s)).toBe("Spend: $0.00 of $1.00 · Leads: 0/10 · Turn 1/30");

    const approval = state();
    await step(approval, { client: client(msg("tool_use", [tool("p", "propose_strategy", { angles: [], first_queries: [], est_cost_dollars: 0 })])) as never, checkLead: checker, now: NOW });
    await decide(approval, { approve: true });
    expect(lastText(approval)).toBe("Spend: $0.00 of $1.00 · Leads: 0/10 · Turn 1/30");
  });

  it("A2b #13 read_page rejects non-http URLs before fetch and submit_lead passes companyUrl", async () => {
    const s = state({ strategyApproved: true });
    const read = vi.fn(async () => ({ url: "file:///etc/passwd", text: "nope" }));
    await step(s, { client: client(msg("tool_use", [tool("r", "read_page", { url: "file:///etc/passwd" })])) as never, checkLead: checker, now: NOW, readExaContents: read as never });
    expect(read).not.toHaveBeenCalled();
    expect(toolResults(s)[0]).toMatchObject({ is_error: true });

    const submit = state();
    submit.caches.signalsByUrl["https://news.example/good"] = signalResult.results[0] as never;
    submit.caches.enrichmentByName[squashName("GoodCo")] = { summary: lookupResult.summary, url: "https://good.example" };
    const seenUrls: unknown[] = [];
    const check: LeadChecker = (_p, input) => {
      seenUrls.push(input.companyUrl);
      return checker(_p, input);
    };
    await step(submit, { client: client(msg("tool_use", [tool("sub", "submit_lead", { company: "GoodCo", signal_url: "https://news.example/good", why_now: "opened warehouse" })])) as never, checkLead: check, now: NOW });
    expect(seenUrls).toEqual(["https://good.example"]);
  });

  it("A2b #14 createRunState includes the created date in the first user message", async () => {
    const s = createRunState({ id: "dated", workspaceId: "w", plan: plan(), createdAt: "2026-10-12T23:59:00.000Z" });
    expect(String(s.messages[0]?.content)).toContain("Today is 2026-10-12.");
  });

  it("rejects path-traversal ids in every storage function", async () => {
    for (const bad of ["../x", "..", "a/b", "", "x".repeat(40)]) {
      await expect(loadState(bad)).rejects.toBeInstanceOf(InvalidIdError);
      await expect(saveState({ ...state(), id: bad })).rejects.toBeInstanceOf(InvalidIdError);
      await expect(readLastEvents(bad)).rejects.toBeInstanceOf(InvalidIdError);
      await expect(appendEvents(bad, [{ ts: "", runId: bad, turn: 0, kind: "stop", promptVersion: "x" }])).rejects.toBeInstanceOf(InvalidIdError);
    }
    for (const bad of ["../x", "a/b", "", "x".repeat(65), "..\\x"]) {
      await expect(loadMemory(bad)).rejects.toBeInstanceOf(InvalidIdError);
      await expect(saveMem(bad, { seen: [], preferenceNotes: [] })).rejects.toBeInstanceOf(InvalidIdError);
      await expect(clearMemory(bad)).rejects.toBeInstanceOf(InvalidIdError);
    }
    // valid shapes still work
    await expect(loadMemory("ok_ws-1")).resolves.toEqual({ seen: [], preferenceNotes: [] });
    const demoId = `demo-${crypto.randomUUID()}`;
    await expect(readLastEvents(demoId)).resolves.toEqual([]);
  });

  it("stopRun stops server-side with a code handback and no model call; step() then returns immediately", async () => {
    const s = state();
    s.rejected.push({ company: "X", code: "size", reason: "too big", turn: 1 });
    s.status = "awaiting_approval";
    s.pendingApproval = { toolUseId: "a", tool: "propose_strategy", input: {}, otherToolResults: [] };
    const result = await stopRun(s);
    expect(s.status).toBe("stopped");
    expect(s.stopReason).toBe("user");
    expect(s.pendingApproval).toBeUndefined();
    expect(s.handback?.top_reasons).toEqual([{ code: "size", count: 1 }]);
    expect(result.events.map((e) => e.kind)).toEqual(["stop"]);
    expect(result.events[0]).toMatchObject({ reason: "user", status: "stopped" });
    expect((await readLastEvents(s.id)).at(-1)).toMatchObject({ kind: "stop", reason: "user" });
    const c = client(new Error("must not be called"));
    const stepped = await step(s, { client: c as never, checkLead: checker, now: NOW });
    expect(stepped.events).toEqual([]);
    expect(c.messages.create).not.toHaveBeenCalled();
    // idempotent
    expect((await stopRun(s)).events).toEqual([]);
  });

  it("tool_call events carry a trimmed input (query/name/url/change, skipped_companies), never page text", async () => {
    const long = "q".repeat(500);
    expect(eventInput("search_signals", { query: long, months: 3 })).toEqual({ query: "q".repeat(200) });
    expect(eventInput("read_page", { url: "https://x.example/a", text: "PAGE TEXT" })).toEqual({ url: "https://x.example/a" });
    expect(eventInput("lookup_company", { name: "GoodCo", skipped_companies: ["Amazon", 5, "Nike"] })).toEqual({ name: "GoodCo", skipped_companies: ["Amazon", "Nike"] });
    expect(eventInput("request_scope_change", { change: { field: "months", value: 6 }, reason: "r" })).toEqual({ change: { field: "months", value: 6 } });
    const s = state({ strategyApproved: true });
    const c = client(msg("tool_use", [
      tool("s", "search_signals", { query: "warehouse expansion", num_results: 10 }),
      tool("l", "lookup_company", { name: "GoodCo", skipped_companies: ["Nike"] }),
    ]));
    const result = await step(s, { client: c as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async () => signalResult) as never, lookupCompany: vi.fn(async () => lookupResult) as never });
    const calls = result.events.filter((e) => e.kind === "tool_call");
    expect(calls.find((e) => e.tool === "search_signals")?.input).toEqual({ query: "warehouse expansion" });
    expect(calls.find((e) => e.tool === "lookup_company")?.input).toEqual({ name: "GoodCo", skipped_companies: ["Nike"] });
  });

  it("decision events record `before` for scope changes, and createRunState keeps a deep initialContract", async () => {
    const s = state();
    expect(s.initialContract).toEqual(s.contract);
    expect(s.initialContract).not.toBe(s.contract);
    s.status = "awaiting_approval";
    s.pendingApproval = {
      toolUseId: "a",
      tool: "request_scope_change",
      input: { change: { field: "employeeRange", value: { min: 10, max: 900 } }, reason: "r", evidence: "e" },
      otherToolResults: [],
    };
    const { events } = await decide(s, { approve: true });
    expect(events[0]).toMatchObject({ kind: "decision", approve: true, before: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" } });
    expect(s.contract.employeeRange.max).toBe(900);
    expect(s.initialContract?.employeeRange.max).toBe(500); // unaffected by the change
  });

  it("GET /api/runs/:id returns summary and strategyApproved; bad ids get 400", async () => {
    const { GET } = await import("../app/api/runs/[id]/route");
    const s = state({ summary: "Found two leads.", strategyApproved: true });
    await saveState(s);
    const res = await GET(new Request("http://x"), { params: { id: s.id } });
    const body = await res.json();
    expect(body).toMatchObject({ summary: "Found two leads.", strategyApproved: true, id: s.id });
    const bad = await GET(new Request("http://x"), { params: { id: "../etc" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Invalid request." });
  });

  it("POST /api/runs/:id/stop stops and persists", async () => {
    const { POST } = await import("../app/api/runs/[id]/stop/route");
    const s = state();
    await saveState(s);
    const res = await POST(new Request("http://x", { method: "POST" }), { params: { id: s.id } });
    expect(await res.json()).toMatchObject({ status: "stopped", stopReason: "user" });
    expect((await loadState(s.id)).status).toBe("stopped");
    expect((await POST(new Request("http://x"), { params: { id: "a/b" } })).status).toBe(400);
  });

  it("resolveDataDirs: ./runs by default, /tmp/prospector on Vercel, explicit env wins", () => {
    expect(resolveDataDirs({})).toEqual({ data: ".", runs: "./runs", workspaces: "./workspaces" });
    expect(resolveDataDirs({ VERCEL: "1" })).toEqual({ data: "/tmp/prospector", runs: "/tmp/prospector/runs", workspaces: "/tmp/prospector/workspaces" });
    expect(resolveDataDirs({ DATA_DIR: "/data" })).toEqual({ data: "/data", runs: "/data/runs", workspaces: "/data/workspaces" });
    expect(resolveDataDirs({ VERCEL: "1", RUNS_DIR: "/data/r" })).toEqual({ data: "/tmp/prospector", runs: "/data/r", workspaces: "/tmp/prospector/workspaces" });
  });

  describe("A2c structured handback, lookup screening, data-driven suggestions", () => {
    const structured = {
      shortfall: "6 of 10",
      top_reasons: [{ reason: "Too small", count: 10 }, { reason: "Too big", count: 20 }],
      suggestions: [
        { field: "employeeRange", value: '{"min":25,"max":500}', why: "many small" },
        { field: "none", value: "n/a", why: "nothing else helps" },
      ],
    };

    it("finish schema's handback is a strict-compatible object", () => {
      const finish = agentTools().find((t) => t.name === "finish")!;
      const handback = (finish.input_schema as { properties: { handback: Record<string, any> } }).properties.handback;
      expect(handback.type).toBe("object");
      expect(handback.additionalProperties).toBe(false);
      expect(handback.required).toEqual(["shortfall", "top_reasons", "suggestions"]);
      const sug = handback.properties.suggestions.items;
      expect(sug.additionalProperties).toBe(false);
      expect(sug.required).toEqual(["field", "value", "why"]);
      expect(sug.properties.field.enum).toEqual(["employeeRange", "months", "hqCountries", "industry", "maxCostDollars", "none"]);
      expect(sug.properties.value.type).toBe("string");
      expect(JSON.stringify(handback)).not.toMatch(/maxItems|minItems/);
    });

    it("stores a structured handback (value JSON decoded) without a second model call", async () => {
      const s = state();
      const c = client(msg("tool_use", [tool("f", "finish", { summary: "done", handback: structured })]));
      await step(s, { client: c as never, checkLead: checker, now: NOW });
      expect(s.status).toBe("done");
      expect(s.handback).toEqual({
        shortfall: "6 of 10",
        top_reasons: [{ code: "Too small", count: 10 }, { code: "Too big", count: 20 }],
        suggestions: [
          { field: "employeeRange", value: { min: 25, max: 500 }, why: "many small" },
          { field: "none", value: "n/a", why: "nothing else helps" },
        ],
      });
      expect(c.messages.create).toHaveBeenCalledTimes(1);
    });

    it("malformed handbacks (markdown string, bad field, non-JSON value, too many) are rejected -> fallback", async () => {
      expect(validHandback("Found 6 of 10. Why: too small (10)")).toBeUndefined();
      expect(validHandback({ ...structured, suggestions: [{ field: "scope", value: "1", why: "x" }] })).toBeUndefined();
      expect(validHandback({ ...structured, suggestions: [{ field: "months", value: "six", why: "x" }] })).toBeUndefined();
      expect(validHandback({ ...structured, top_reasons: Array.from({ length: 5 }, () => ({ reason: "r", count: 1 })) })).toBeUndefined();
      expect(validHandback({ ...structured, suggestions: [structured.suggestions[0], structured.suggestions[0], structured.suggestions[0]] })).toBeUndefined();
      expect(validHandback({ ...structured, top_reasons: [{ reason: "r" }] })).toBeUndefined();

      const s = state({ rejected: [{ company: "X", code: "size", reason: "too big", turn: 1 }] });
      const c = client(
        msg("tool_use", [tool("f", "finish", { summary: "done", handback: "Found 6 of 10. Too small (10)" })]),
        msg("end_turn", [text("not json")]),
      );
      await step(s, { client: c as never, checkLead: checker, now: NOW });
      expect(s.handback?.top_reasons).toEqual([{ code: "size", count: 1 }]);
    });

    const withSignal = (company: string, url: string) => ({
      url,
      title: `${company} news`,
      summary: { company_name: company, signal_type: "expansion", signal_summary: `${company} expands`, signal_date: "2026-10-01" },
    });

    it("lookup_company screens known signals with checkLead, reports it in the result, records once", async () => {
      const s = state({ strategyApproved: true });
      s.caches.signalsByUrl["https://n.example/bad"] = withSignal("BadCo Inc", "https://n.example/bad");
      s.caches.signalsByUrl["https://n.example/good"] = withSignal("GoodCo", "https://n.example/good");
      const deps = { checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => lookupResult) as never };
      const first = await step(s, { ...deps, client: client(msg("tool_use", [
        tool("a", "lookup_company", { name: "BadCo" }),
        tool("b", "lookup_company", { name: "GoodCo" }),
        tool("c", "lookup_company", { name: "NoSignalCo" }),
      ])) as never });
      expect(first.events.filter((e) => e.kind === "tool_call")).toHaveLength(3);
      const results = (s.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string }>);
      const byId = Object.fromEntries(results.filter((r) => r.tool_use_id).map((r) => [r.tool_use_id, r.content]));
      expect(byId.a).toContain("Would be rejected: required_gate:is_operator — not an operator");
      expect(byId.b).not.toContain("Would be rejected");
      expect(byId.c).not.toContain("Would be rejected");
      expect(s.screened).toEqual([{ company: "BadCo", code: "required_gate:is_operator", reason: "not an operator", turn: 1, stage: "lookup" }]);
      expect(s.rejected).toEqual([]);
      // repeat lookup: still flagged in the text, not duplicated in state
      await step(s, { ...deps, client: client(msg("tool_use", [tool("d", "lookup_company", { name: "BadCo" })])) as never });
      expect(s.screened).toHaveLength(1);
      expect(screenedByCode(s)).toEqual([{ code: "required_gate:is_operator", count: 1, companies: ["BadCo"] }]);
    });

    it("rejectionCounts merges rejected + screened, one count per company and code", () => {
      const s = state({
        rejected: [{ company: "BadCo", code: "size", reason: "r", turn: 2 }, { company: "Other", code: "hq", reason: "r", turn: 2 }],
        screened: [
          { company: "Badco Inc", code: "size", reason: "r", turn: 1, stage: "lookup" },
          { company: "Big1", code: "enterprise", reason: "r", turn: 1, stage: "lookup" },
          { company: "Big2", code: "enterprise", reason: "r", turn: 1, stage: "lookup" },
        ],
      });
      expect(rejectionCounts(s)).toEqual([
        { code: "enterprise", count: 2 },
        { code: "size", count: 1 },
        { code: "hq", count: 1 },
      ]);
    });

    describe("codeHandback suggestions are data-driven", () => {
      const withCompanies = (code: string, items: Array<{ name: string; employees?: number; hq?: string }>, over: Partial<RunState> = {}) => {
        const s = state(over);
        for (const it of items) {
          s.screened = [...(s.screened ?? []), { company: it.name, code, reason: "r", turn: 1, stage: "lookup" }];
          s.caches.enrichmentByName[squashName(it.name)] = { summary: { employee_estimate: it.employees, hq: it.hq } };
        }
        return s;
      };
      const first = (s: RunState) => codeHandback(s).suggestions[0]!;

      it("size: mostly below min -> min halves", () => {
        const s = withCompanies("size", [{ name: "A", employees: 10 }, { name: "B", employees: 20 }, { name: "C", employees: 900 }]);
        expect(first(s)).toMatchObject({ field: "employeeRange", value: { min: 25, max: 500 } });
      });
      it("size: mostly above max -> max x1.5", () => {
        const s = withCompanies("size", [{ name: "A", employees: 3000 }, { name: "B", employees: 2000 }, { name: "C", employees: 20 }]);
        expect(first(s)).toMatchObject({ field: "employeeRange", value: { min: 50, max: 750 } });
      });
      it("size: mixed or no data -> none", () => {
        expect(first(withCompanies("size", [{ name: "A", employees: 10 }, { name: "B", employees: 3000 }])).field).toBe("none");
        expect(first(withCompanies("size", [{ name: "A" }])).field).toBe("none");
      });
      it("stale_date: months + 3, capped at 12", () => {
        expect(first(withCompanies("stale_date", [{ name: "A" }]))).toMatchObject({ field: "months", value: 6 });
        const s = withCompanies("stale_date", [{ name: "A" }]);
        s.contract.months = 11;
        expect(first(s)).toMatchObject({ field: "months", value: 12 });
        s.contract.months = 12;
        expect(first(s).field).toBe("none");
      });
      it("hq: >=3 distinct countries -> any; fewer -> add the top country", () => {
        const many = withCompanies("hq", [{ name: "A", hq: "Berlin, Germany" }, { name: "B", hq: "Toronto, Canada" }, { name: "C", hq: "Mumbai, India" }]);
        expect(first(many)).toMatchObject({ field: "hqCountries", value: "any" });
        const few = withCompanies("hq", [{ name: "A", hq: "Toronto, Canada" }, { name: "B", hq: "Vancouver, Canada" }, { name: "C", hq: "London, UK" }]);
        expect(first(few)).toMatchObject({ field: "hqCountries", value: ["US", "CA"] });
      });
      it("required_gate: field none, explains the gate", () => {
        const s = withCompanies("required_gate:is_operator", [{ name: "A" }, { name: "B" }]);
        const sug = first(s);
        expect(sug.field).toBe("none");
        expect(sug.why).toContain("Is it an operator?");
      });
      it("enterprise: field none, contract working as intended", () => {
        expect(first(withCompanies("enterprise", [{ name: "A" }]))).toMatchObject({ field: "none", why: "These are large companies; the contract is working as intended." });
      });
      it("never emits field 'scope'", () => {
        const s = withCompanies("exclude_name", [{ name: "A" }]);
        expect(codeHandback(s).suggestions.every((x) => x.field !== "scope")).toBe(true);
        expect(first(s).field).toBe("none");
      });
    });

    it("GET /api/runs/:id includes screened grouped by code", async () => {
      const { GET } = await import("../app/api/runs/[id]/route");
      const s = state({ screened: [{ company: "A", code: "size", reason: "r", turn: 1, stage: "lookup" }, { company: "B", code: "size", reason: "r", turn: 1, stage: "lookup" }] });
      await saveState(s);
      const body = await (await GET(new Request("http://x"), { params: { id: s.id } })).json();
      expect(body.screened).toEqual([{ code: "size", count: 2, companies: ["A", "B"] }]);
    });
  });

  describe("F1 regressions", () => {
    it("F1.1 rejects stale state saves and honours stopRequested before a model call", async () => {
      const s = state();
      await saveState(s);
      const a = await loadState(s.id);
      const b = await loadState(s.id);
      a.todo = "first";
      b.todo = "second";
      await saveState(a, a.version);
      await expect(saveState(b, b.version)).rejects.toBeInstanceOf(StaleStateError);

      const stopState = state({ stopRequested: true });
      const c = client(new Error("must not call"));
      await step(stopState, { client: c as never, checkLead: checker, now: NOW });
      expect(stopState.status).toBe("stopped");
      expect(stopState.stopReason).toBe("user");
      expect(c.messages.create).not.toHaveBeenCalled();
    });

    it("F1.2 reserves Claude spend and stops on budget before a model call", async () => {
      const s = state({ contract: { ...state().contract, maxCostDollars: 0.06 } });
      const c = client(msg("end_turn", [text("should not run")]));
      await step(s, { client: c as never, checkLead: checker, now: NOW });
      expect(c.messages.create).not.toHaveBeenCalled();
      expect(s.status).toBe("stopped");
      expect(s.stopReason).toBe("budget");
    });

    it("F1.3 stops with code handback when CostGuard is breached after settle", async () => {
      const guard = new CostGuard(0.01);
      guard.reserve(0.005);
      guard.settle(0.005, 0.02);
      expect(guard.breached).toBe(true);

      const s = state({ strategyApproved: true });
      const exaSearchMock = vi.fn(async (_body: unknown, _credentials: unknown, g: CostGuard) => {
        g.reserve(0.001);
        g.settle(0.001, 2);
        return signalResult;
      });
      await step(s, { client: client(msg("tool_use", [tool("s", "search_signals", { query: "x" })])) as never, checkLead: checker, now: NOW, exaSearch: exaSearchMock as never });
      expect(s.status).toBe("stopped");
      expect(s.stopReason).toBe("budget");
    });

    it("F1.4 reports per-call Exa costs and records handback model calls", async () => {
      const s = state({ strategyApproved: true });
      const exaSearchMock = vi.fn(async (body: Record<string, unknown>, _credentials: unknown, guard: CostGuard) => {
        guard.reserve(0.001);
        const actual = String(body.query) === "a" ? 0.011 : 0.022;
        guard.settle(0.001, actual);
        return { ...signalResult, costDollars: { total: actual } };
      });
      const result = await step(s, { client: client(msg("tool_use", [tool("a", "search_signals", { query: "a" }), tool("b", "search_signals", { query: "b" })])) as never, checkLead: checker, now: NOW, exaSearch: exaSearchMock as never });
      expect(result.events.filter((e) => e.kind === "tool_call").reduce((sum, e) => sum + Number(e.exaCost ?? 0), 0)).toBeCloseTo(s.spend.exa, 6);

      const h = state({ spend: { exa: 0.96, claude: 0, total: 0.96 } });
      await step(h, { client: client(msg("end_turn", [text(JSON.stringify({ shortfall: "0 of 10", top_reasons: [], suggestions: [] }))])) as never, checkLead: checker, now: NOW });
      expect((await readLastEvents(h.id)).some((e) => e.kind === "model_call" && e.handback === true)).toBe(true);
    });

    it("F1.5 requires decisions to target the pending tool_use id", async () => {
      const s = state({ status: "awaiting_approval", pendingApproval: { toolUseId: "right", tool: "propose_strategy", input: {}, otherToolResults: [] } });
      await expect(decide(s, { approve: true, toolUseId: "wrong" })).rejects.toThrow("stale approval decision");
    });

    it("F1.6 keeps retryable model errors running until the third consecutive error", async () => {
      const retryable = Object.assign(new Error("busy"), { status: 529 });
      const s = state();
      await step(s, { client: client(retryable) as never, checkLead: checker, now: NOW });
      expect(s.status).toBe("running");
      expect(s.counters.consecutiveErrors).toBe(1);
      await step(s, { client: client(Object.assign(new Error("busy"), { status: 500 })) as never, checkLead: checker, now: NOW });
      await step(s, { client: client(Object.assign(new Error("busy"), { name: "RateLimitError" })) as never, checkLead: checker, now: NOW });
      expect(s.status).toBe("error");
    });

    it("F1.7 read_page uses Exa record/replay for contents", async () => {
      const oldReplay = process.env.EXA_REPLAY_DIR;
      const oldRecord = process.env.EXA_RECORD_DIR;
      process.env.EXA_REPLAY_DIR = tmp.runs;
      await expect(readExaContents("https://x.example", { apiKey: "test" })).rejects.toBeInstanceOf(ReplayMissError);
      delete process.env.EXA_REPLAY_DIR;
      process.env.EXA_RECORD_DIR = tmp.runs;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ url: "https://x.example", text: "page" }], costDollars: { total: 0.002 } }), { status: 200 })));
      await expect(readExaContents("https://x.example", { apiKey: "test" })).resolves.toMatchObject({ text: "page" });
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(tmp.runs)).some((f) => f.endsWith(".json"))).toBe(true);
      process.env.EXA_REPLAY_DIR = oldReplay;
      process.env.EXA_RECORD_DIR = oldRecord;
    });

    it("F1.8 lookup_company rejects mismatched entities and accepts clear matches", async () => {
      const reject = state({ strategyApproved: true });
      await step(reject, { client: client(msg("tool_use", [tool("l", "lookup_company", { name: "AUKLogis" })])) as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => ({ result: { url: "https://auklogistics.com", title: "AUK Logistics" }, summary: { description: "AUK Logistics" }, costDollars: { total: 0.01 } })) as never });
      expect(toolResults(reject)[0]?.content).toContain("No reliable company page found for AUKLogis");
      expect(Object.keys(reject.caches.enrichmentByName)).toEqual([]);

      const accept = state({ strategyApproved: true });
      await step(accept, { client: client(msg("tool_use", [tool("l", "lookup_company", { name: "Allegro" })])) as never, checkLead: checker, now: NOW, lookupCompany: vi.fn(async () => ({ result: { url: "https://allegro.eu", title: "Allegro" }, summary: { description: "Allegro" }, costDollars: { total: 0.01 } })) as never });
      expect(Object.keys(accept.caches.enrichmentByName)).toEqual([squashName("Allegro")]);
    });

    it("F1.9 search_signals requests text and estimates text cost", async () => {
      const bodySeen: Record<string, unknown>[] = [];
      const s = state({ strategyApproved: true });
      await step(s, { client: client(msg("tool_use", [tool("s", "search_signals", { query: "warehouse", num_results: 10 })])) as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async (body: Record<string, unknown>) => { bodySeen.push(body); return signalResult; }) as never });
      expect(bodySeen[0]?.contents).toMatchObject({ text: { maxCharacters: 1200 } });
      expect(s.caches.signalsByUrl["https://news.example/good"]?.text).toBe("GoodCo expands.");
      expect(estimateExaCost({ query: "x", numResults: 10, contents: { summary: {}, text: { maxCharacters: 1200 } } })).toBeGreaterThan(estimateExaCost({ query: "x", numResults: 10, contents: { summary: {} } }));
    });

    it("F1.10 event trimmer preserves replay-critical tool input fields", () => {
      expect(eventInput("update_todo", { markdown: "x".repeat(700) }).markdown).toHaveLength(600);
      expect(eventInput("submit_lead", { company: "GoodCo", signal_url: "https://news.example/good", why_now: "x" })).toEqual({ company: "GoodCo", signal_url: "https://news.example/good" });
    });

    it("F1.11 run routes clamp targetLeads, rate-limit by first forwarded IP, and pause live when the cap is zero", async () => {
      const { POST } = await import("../app/api/runs/route");
      const res = await POST(new Request("http://x/api/runs", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.10, 10.0.0.1" },
        body: JSON.stringify({ plan: plan(), targetLeads: 99, workspaceId: "route_ws" }),
      }));
      expect(res.status).toBe(200);
      const created = await res.json();
      expect((await loadState(created.id)).contract.targetLeads).toBe(50);

      for (let i = 0; i < 30; i += 1) {
        await POST(new Request("http://x/api/runs", { method: "POST", headers: { "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ plan: plan(), workspaceId: `rl_${i}` }) }));
      }
      const limited = await POST(new Request("http://x/api/runs", { method: "POST", headers: { "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ plan: plan(), workspaceId: "rl_x" }) }));
      expect(limited.status).toBe(429);

      const oldCap = process.env.DAILY_SPEND_CAP_DOLLARS;
      process.env.DAILY_SPEND_CAP_DOLLARS = "0";
      const capped = await POST(new Request("http://x/api/runs", { method: "POST", headers: { "x-forwarded-for": "192.0.2.55" }, body: JSON.stringify({ plan: plan(), workspaceId: "cap_ws" }) }));
      expect(capped.status).toBe(200);
      expect(await capped.json()).toMatchObject({ id: expect.stringMatching(/^demo-/) });
      process.env.DAILY_SPEND_CAP_DOLLARS = oldCap;
    });
  });

  describe("query-rewrite counter", () => {
    const base = () => {
      const s = state({ strategyApproved: true });
      s.caches.searchQueries.push("first query");
      return s;
    };
    const search = (query: string) => tool("s", "search_signals", { query, num_results: 5 });
    const run = (s: RunState, c: ReturnType<typeof client>) =>
      step(s, { client: c as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async () => signalResult) as never, lookupCompany: vi.fn(async () => lookupResult) as never });

    it("a lookup-stage screening in turn N then a new query in turn N+1 counts one rewrite", async () => {
      const s = base();
      s.caches.signalsByUrl["https://n.example/bad"] = { url: "https://n.example/bad", title: "BadCo", summary: { company_name: "BadCo", signal_type: "expansion", signal_summary: "BadCo expands", signal_date: "2026-10-01" } };
      await run(s, client(msg("tool_use", [tool("l", "lookup_company", { name: "BadCo" })])));
      expect(s.screened).toHaveLength(1);
      await run(s, client(msg("tool_use", [search("a different approach")])));
      expect(s.adaptive.queryRewrites).toBe(1);
    });

    it("a lookup with no reliable company page also counts", async () => {
      const s = base();
      const noPage = vi.fn(async () => ({ result: undefined, summary: {} }));
      await step(s, { client: client(msg("tool_use", [tool("l", "lookup_company", { name: "GhostCo" })])) as never, checkLead: checker, now: NOW, lookupCompany: noPage as never });
      expect(s.lookupMisses).toEqual([1]);
      await run(s, client(msg("tool_use", [search("new angle")])));
      expect(s.adaptive.queryRewrites).toBe(1);
    });

    it("no trouble, a repeated query, or trouble two turns earlier does not count", async () => {
      const s = base();
      await run(s, client(msg("tool_use", [search("brand new but nothing went wrong")])));
      expect(s.adaptive.queryRewrites).toBe(0);
      s.rejected.push({ company: "X", code: "size", reason: "r", turn: s.counters.turns });
      await run(s, client(msg("tool_use", [search("first query")]))); // repeat -> no
      expect(s.adaptive.queryRewrites).toBe(0);
      await run(s, client(msg("tool_use", [tool("t", "update_todo", { markdown: "- x" })])));
      await run(s, client(msg("tool_use", [search("late new query")]))); // trouble was 2 turns back
      expect(s.adaptive.queryRewrites).toBe(0);
    });

    it("a submit-stage rejection in the previous turn still counts", async () => {
      const s = base();
      s.rejected.push({ company: "X", code: "size", reason: "r", turn: s.counters.turns });
      await run(s, client(msg("tool_use", [search("rewritten")])));
      expect(s.adaptive.queryRewrites).toBe(1);
    });
  });
});
