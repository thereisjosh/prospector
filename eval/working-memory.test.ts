import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "working-memory-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  return { root };
});
import type { SearchPlan } from "../src/plan";
import { createRunState, loadState, saveState, INTERRUPTED_TOOL_RESULT, type RunState } from "../src/agent/state";
import { step } from "../src/agent/loop";
import { readLastEvents } from "../src/agent/events";
import { assembleMessages, buildSummary, estimateTokens, measureRequestTokens, SUMMARY_MAX_TOKENS, turnStarts } from "../src/agent/context";
import { agentTools } from "../src/agent/tools";
import { contextBudgetTokens } from "../src/agent/config";
import type { LeadChecker } from "../src/agent/gate-port";

afterAll(() => rm(tmp.root, { recursive: true, force: true }));

const NOW = new Date("2026-10-12T00:00:00.000Z");
const plan: SearchPlan = {
  label: "Working memory",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};
const checker: LeadChecker = () => ({ ok: false, code: "size", reason: "x" });

const newState = (over: Partial<RunState> = {}) =>
  ({ ...createRunState({ id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), plan, createdAt: "2026-10-12T00:00:00.000Z" }), ...over }) as RunState;

const use = (id: string, name = "search_signals", input: Record<string, unknown> = { query: "q" }) => ({ type: "tool_use", id, name, input });
const assistant = (...uses: ReturnType<typeof use>[]) => ({ role: "assistant", content: uses }) as never;
const results = (ids: string[], body = "ok") =>
  ({ role: "user", content: [...ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: body })), { type: "text", text: "Spend: $0.10" }] }) as never;
const msg = (stop_reason: string, content: unknown[]) => ({
  id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

/** n finished turns, each ~`bytes` characters of tool output, ids t0..t(n-1). */
function withTurns(s: RunState, n: number, bytes = 4000) {
  for (let i = 0; i < n; i += 1) {
    s.messages.push(assistant(use(`t${i}`)), results([`t${i}`], `${"x".repeat(bytes)} PLANTED-MESSAGE-TEXT-${i}`));
  }
  return s;
}

const lastRole = (s: RunState) => s.messages[s.messages.length - 1]!.role;

describe("crash repair on load", () => {
  it("answers a single dangling tool_use with an error result and emits turn_repaired on the next step", async () => {
    const s = newState();
    s.messages.push(assistant(use("dangling")));
    await saveState(s);
    const loaded = await loadState(s.id);
    const last = loaded.messages[loaded.messages.length - 1] as unknown as { role: string; content: Array<Record<string, unknown>> };
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "tool_result", tool_use_id: "dangling", content: INTERRUPTED_TOOL_RESULT, is_error: true }]);
    expect(loaded.repairedToolUseIds).toEqual(["dangling"]);

    const create = vi.fn(async (_p: unknown) => msg("end_turn", [{ type: "text", text: "done" }]));
    await step(loaded, { client: { messages: { create } } as never, checkLead: checker, now: NOW });
    expect(JSON.stringify((create.mock.calls[0]![0] as { messages: unknown }).messages)).toContain("dangling");
    const repaired = (await readLastEvents(s.id)).filter((e) => e.kind === "turn_repaired");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.toolUseIds).toEqual(["dangling"]);
    expect(loaded.repairedToolUseIds).toBeUndefined();
  });

  it("answers every id when several calls dangle, in one user message", async () => {
    const s = newState();
    s.messages.push(assistant(use("a"), use("b"), use("c")));
    await saveState(s);
    const loaded = await loadState(s.id);
    const last = loaded.messages[loaded.messages.length - 1] as unknown as { content: Array<{ tool_use_id: string; is_error: boolean }> };
    expect(loaded.messages).toHaveLength(3);
    expect(last.content.map((b) => b.tool_use_id)).toEqual(["a", "b", "c"]);
    expect(last.content.every((b) => b.is_error)).toBe(true);
    expect(loaded.repairedToolUseIds).toEqual(["a", "b", "c"]);
  });

  it("leaves an approval-paused turn alone (the decision flow answers it)", async () => {
    const s = newState({
      status: "awaiting_approval",
      pendingApproval: { toolUseId: "p", tool: "propose_strategy", input: {}, otherToolResults: [], toolUseOrder: ["p"] },
    });
    s.messages.push(assistant(use("p", "propose_strategy")));
    await saveState(s);
    const loaded = await loadState(s.id);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.repairedToolUseIds).toBeUndefined();
  });

  it("leaves a clean state untouched", async () => {
    const s = withTurns(newState(), 2, 10);
    await saveState(s);
    const before = JSON.stringify(s.messages);
    const loaded = await loadState(s.id);
    expect(JSON.stringify(loaded.messages)).toBe(before);
    expect(loaded.repairedToolUseIds).toBeUndefined();
    const ended = newState();
    ended.messages.push({ role: "assistant", content: [{ type: "text", text: "all done" }] } as never);
    await saveState(ended);
    expect((await loadState(ended.id)).messages).toHaveLength(2);
  });
});

describe("assembleMessages", () => {
  it("returns the messages untouched when under budget", () => {
    const s = withTurns(newState(), 3, 40);
    const out = assembleMessages(s, { budgetTokens: 100_000 });
    expect(out.messages).toBe(s.messages);
    expect(out.dropped).toBe(0);
    expect(out.summary).toBeUndefined();
  });

  it("drops the oldest turns by token size, keeps the contract, and writes the summary from state", () => {
    const s = withTurns(newState(), 8, 4000);
    s.leads.push({ company: "Acme Freight", signal_url: "https://www.news.example/acme", why_now: "w", summary: { company_name: "Acme Freight", signal_type: "expansion", signal_summary: "s", signal_date: "2026-09-30" }, details: { event_date: "2026-10-01" }, turn: 2 });
    s.rejected.push({ company: "BigCo", code: "size", reason: "r", turn: 1 }, { company: "Other", code: "size", reason: "r", turn: 2 }, { company: "Far", code: "hq", reason: "r", turn: 3 });
    s.caches.searchQueries.push("warehouse expansion Texas");
    s.spend = { exa: 0.2, claude: 0.2, total: 0.4 };
    const full = s.messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m.content)), 0);
    const out = assembleMessages(s, { budgetTokens: Math.floor(full * 0.5) });

    expect(out.dropped).toBeGreaterThan(0);
    expect(out.dropped).toBeLessThan(8);
    expect(out.keptTokens).toBeLessThanOrEqual(Math.floor(full * 0.5));
    expect(s.messages).toHaveLength(17); // state.messages is never mutated
    const first = out.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.content).toContain("Contract approved by the user");
    expect(first.content).toContain(`${out.dropped} older turns trimmed`);
    expect(out.summary).toContain("Acme Freight (news.example, 2026-10-01)");
    expect(out.summary).toContain("size 2, hq 1");
    expect(out.summary).toContain('"warehouse expansion Texas"');
    expect(out.summary).toContain("$0.40 of $1.00");
    expect(out.summary).not.toContain("PLANTED-MESSAGE-TEXT");
    expect(out.messages[1]!.role).toBe("assistant");
    // the newest turn survives, and the dropped turns are the oldest ones
    expect(JSON.stringify(out.messages)).toContain("PLANTED-MESSAGE-TEXT-7");
    expect(JSON.stringify(out.messages)).not.toContain("PLANTED-MESSAGE-TEXT-0");
  });

  it("never splits a tool_use from its tool_result, at any budget", () => {
    const s = newState();
    for (let i = 0; i < 6; i += 1) {
      s.messages.push(assistant(use(`a${i}`), use(`b${i}`)), results([`a${i}`, `b${i}`], "y".repeat(500 + i * 300)));
    }
    for (let budget = 1; budget < 3000; budget += 97) {
      const out = assembleMessages(s, { budgetTokens: budget });
      const seen = new Set<string>();
      expect(out.messages[0]!.role).toBe("user");
      expect(typeof out.messages[0]!.content).toBe("string");
      expect(out.messages[out.messages.length - 1]!.role).toBe("user");
      for (const m of out.messages.slice(1)) {
        for (const b of Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, string>>) : []) {
          if (b.type === "tool_use") seen.add(b.id!);
          if (b.type === "tool_result") expect(seen.has(b.tool_use_id!)).toBe(true);
        }
      }
      // every kept tool_use is answered by the next message
      for (let i = 1; i < out.messages.length - 1; i += 1) {
        if (out.messages[i]!.role === "assistant") expect(out.messages[i + 1]!.role).toBe("user");
      }
      expect(turnStarts(out.messages).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the summary at or under 1,500 tokens even with a huge run", () => {
    const s = newState();
    for (let i = 0; i < 200; i += 1) {
      s.leads.push({ company: `Company number ${i}`, signal_url: `https://host${i}.example/p`, why_now: "w", summary: { company_name: "x", signal_type: "t", signal_summary: "s", signal_date: "2026-10-01" }, details: {}, turn: 1 });
      s.caches.searchQueries.push(`a long search query about warehouses and logistics expansion number ${i} `.repeat(3));
      s.rejected.push({ company: `Rej ${i}`, code: `required_gate:g${i % 40}`, reason: "r", turn: 1 });
    }
    expect(estimateTokens(buildSummary(s, 12))).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS);
  });
});

describe("token measurement", () => {
  const request = { system: "sys", tools: agentTools() };

  it("uses count_tokens once and reuses the cached count on the same request", async () => {
    const s = withTurns(newState(), 1, 10);
    const countTokens = vi.fn(async () => ({ input_tokens: 4321 }));
    const a = await measureRequestTokens(s, { messages: { countTokens } }, request);
    const b = await measureRequestTokens(s, { messages: { countTokens } }, request);
    expect(a).toEqual({ tokens: 4321, source: "counted" });
    expect(b).toEqual({ tokens: 4321, source: "cached" });
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(s.tokenCount?.tokens).toBe(4321);
  });

  it("falls back to the 4-chars estimate and says why when count_tokens fails", async () => {
    const s = withTurns(newState(), 1, 10);
    const out = await measureRequestTokens(s, { messages: { countTokens: async () => { throw new Error("boom"); } } }, request);
    expect(out.source).toBe("estimated");
    expect(out.error).toBe("boom");
    expect(out.tokens).toBeGreaterThan(0);
    expect(s.tokenCount).toBeUndefined();
  });
});

describe("the loop under a token budget", () => {
  it("sends the trimmed window, keeps state.messages whole, and emits context_trimmed", async () => {
    const s = withTurns(newState(), 8, 4000);
    const fullCount = s.messages.length;
    const create = vi.fn(async (_p: unknown) => msg("end_turn", [{ type: "text", text: "done" }]));
    const countTokens = vi.fn(async () => ({ input_tokens: 30_000 }));
    const result = await step(s, { client: { messages: { create, countTokens } } as never, checkLead: checker, now: NOW, contextBudgetTokens: 12_000 });
    const sent = (create.mock.calls[0]![0] as { messages: Array<{ content: unknown }> }).messages;
    expect(sent.length).toBeLessThan(fullCount);
    expect(String(sent[0]!.content)).toContain("older turns trimmed");
    expect(s.messages.length).toBe(fullCount + 1); // full record plus the new assistant message
    const trimmed = result.events.find((e) => e.kind === "context_trimmed")!;
    expect(trimmed.droppedTurns).toBeGreaterThan(0);
    expect(trimmed).toMatchObject({ droppedTokens: expect.any(Number), keptTokens: expect.any(Number), summaryTokens: expect.any(Number) });
    expect(result.events.some((e) => e.kind === "token_count_estimated")).toBe(false);
    expect(result.events.find((e) => e.kind === "model_call")!.messages).toBe(sent.length);
  });

  it("sends everything and emits no context_trimmed when under budget", async () => {
    const s = withTurns(newState(), 2, 40);
    let sentCount = -1; // under budget the array is state.messages itself, so read its length at call time
    const create = vi.fn(async (p: unknown) => {
      if (sentCount < 0) sentCount = (p as { messages: unknown[] }).messages.length; // the 2nd call is the handback
      return msg("end_turn", [{ type: "text", text: "done" }]);
    });
    const countTokens = vi.fn(async () => ({ input_tokens: 2_000 }));
    const result = await step(s, { client: { messages: { create, countTokens } } as never, checkLead: checker, now: NOW });
    expect(sentCount).toBe(5);
    expect(result.events.some((e) => e.kind === "context_trimmed")).toBe(false);
  });

  it("emits token_count_estimated when count_tokens is unavailable, and still trims on the estimate", async () => {
    const s = withTurns(newState(), 8, 4000);
    const create = vi.fn(async (_p: unknown) => msg("end_turn", [{ type: "text", text: "done" }]));
    const countTokens = vi.fn(async () => { throw new Error("count_tokens down"); });
    const result = await step(s, { client: { messages: { create, countTokens } } as never, checkLead: checker, now: NOW, contextBudgetTokens: 12_000 });
    const est = result.events.find((e) => e.kind === "token_count_estimated")!;
    expect(est.reason).toBe("count_tokens down");
    expect(est.basis).toBe("4 chars per token");
    expect(result.events.some((e) => e.kind === "context_trimmed")).toBe(true);
    expect(lastRole(s)).toBe("assistant");
  });

  it("budget default is 60% of the context window", () => {
    expect(contextBudgetTokens("claude-opus-5-5")).toBe(120_000);
  });
});
