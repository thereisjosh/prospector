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
  summary: { description: "GoodCo", industry: "Logistics", employee_estimate: 200, employee_estimate_source: "200 employees", is_public_or_enterprise: false, hq: "Austin, TX", is_operator: true },
};

function toolResults(s: RunState) {
  return (s.messages.at(-1)!.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean; text?: string }>).filter((r) => r.type === "tool_result");
}

function lastText(s: RunState) {
  return (s.messages.at(-1)!.content as Array<{ type: string; text?: string }>).filter((r) => r.type === "text").at(-1)?.text;
}

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
    expect(toolResults(capped)[0]).toMatchObject({ tool_use_id: "s", is_error: true });
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
});
