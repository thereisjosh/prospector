import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchPlan } from "../src/plan";
import { createRunState, loadState, saveState, type RunState } from "../src/agent/state";
import { decide, step } from "../src/agent/loop";
import type { LeadChecker } from "../src/agent/gate-port";
import { appendRunToMemory, loadMemory, saveMemory, squashName } from "../src/agent/memory";

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
  summary: { description: "GoodCo", industry: "Logistics", employee_estimate: 200, hq: "Austin, TX", is_operator: true },
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  await rm("./runs", { recursive: true, force: true });
  await rm("./workspaces", { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm("./runs", { recursive: true, force: true });
  await rm("./workspaces", { recursive: true, force: true });
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
    const content = last.content as Array<{ type: string; tool_use_id: string }>;
    expect(content.map((r) => r.type)).toEqual(["tool_result", "tool_result"]);
    expect(content.map((r) => r.tool_use_id).sort()).toEqual(["a", "b"]);
  });

  it("tool executor errors become is_error tool_results and the run continues", async () => {
    const s = state();
    const c = client(msg("tool_use", [tool("x", "read_page", { url: "https://x.example" })]));
    await step(s, {
      client: c as never,
      checkLead: checker,
      now: NOW,
      readExaContents: vi.fn(async () => { throw new Error("contents failed"); }) as never,
    });
    expect(s.status).toBe("running");
    const result = (s.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
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
    const content = s.messages.at(-1)!.content as Array<{ tool_use_id: string; content: string }>;
    expect(content.map((r) => r.tool_use_id)).toEqual(["todo", "approval"]);
    expect(content.at(-1)?.content).toBe("approved");
  });

  it("approved request_scope_change rejects invalid code-updated values", async () => {
    const s = state({
      status: "awaiting_approval",
      pendingApproval: {
        toolUseId: "approval",
        tool: "request_scope_change",
        input: { change: { field: "months", value: 99 }, reason: "x", evidence: "y" },
        otherToolResults: [],
      },
    });
    await expect(decide(s, { approve: true })).rejects.toThrow("invalid months");
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
});
