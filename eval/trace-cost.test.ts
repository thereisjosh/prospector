import { describe, expect, it, afterEach, vi } from "vitest";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AgentEvent } from "../src/agent/events";
import { __setTraceTestHooks, emit, flush, listExisting, toObservations } from "../src/agent/trace";

const RUN = "7c1d2a9e-0000-4000-8000-00000000c057";
const ev = (over: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "turn" | "ts">): AgentEvent => ({ runId: RUN, promptVersion: "p1", ...over }) as AgentEvent;
const T = (s: number) => `2026-10-15T09:00:${String(s).padStart(2, "0")}.000Z`;

const turn = [
  ev({ kind: "policy", turn: 1, ts: T(0), scope: "loop", check: "limits", outcome: "pass" }),
  ev({ kind: "memory_recalled", turn: 1, ts: T(0), seen: 3, preferences: { considered: 2, included: 1 }, notes: { considered: 1, included: 1 }, includedIds: ["m1", "m2"] }),
  ev({ kind: "turn_repaired", turn: 1, ts: T(0), toolUseIds: ["toolu_dangling"] }),
  ev({ kind: "token_count_estimated", turn: 1, ts: T(0), tokens: 1200, reason: "count_tokens unavailable", basis: "4 chars per token" }),
  ev({ kind: "context_trimmed", turn: 1, ts: T(1), droppedTurns: 2, droppedTokens: 900, keptTokens: 4000, summaryTokens: 150 }),
  ev({ kind: "model_call", turn: 1, ts: T(3), latencyMs: 2000, tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 }, claudeCost: 0.01, model: "claude-opus-5-5", responseId: "msg_a" }),
  ev({ kind: "tool_call", turn: 1, ts: T(5), tool: "lookup_company", input: { name: "Acme" }, toolUseId: "toolu_acme", latencyMs: 2000, is_error: false, exaCost: 0.018, resultSummary: "ok" }),
  ev({ kind: "lookup_retry", turn: 1, ts: T(5), toolUseId: "toolu_acme", company: "Acme", reason: "quote_not_in_page", key: "has_fleet", before: "weak", after: "strong", outcome: "kept_retry", retryExaCost: 0.009 }),
  ev({ kind: "lookup_retry", turn: 1, ts: T(6), toolUseId: "toolu_unknown", company: "Orphan", reason: "network", before: "error", after: "error", outcome: "retry_failed", retryExaCost: 0, error: "boom" }),
  ev({ kind: "tool_call", turn: 1, ts: T(7), tool: "update_todo", input: {}, toolUseId: "toolu_todo", latencyMs: 1, is_error: false, exaCost: 0, resultSummary: "ok" }),
  ev({ kind: "turn_end", turn: 1, ts: T(8), durationMs: 8000, status: "running", spend: { total: 0.028 }, leads: 0, before: { status: "running", turn: 0 } }),
];

describe("tool observation cost", () => {
  const [trace] = toObservations(turn);
  const obs = trace!.observations;
  const byName = (n: string) => obs.filter((o) => o.name === n);

  it("sets costDetails.total from exaCost on tool observations with spend, none without", () => {
    expect(byName("tool:lookup_company")[0]).toMatchObject({ type: "tool", costDetails: { total: 0.018 }, metadata: { exaCost: 0.018 } });
    expect(byName("tool:update_todo")[0]!.costDetails).toBeUndefined();
  });

  it("trace cost is Claude + Exa, and the retry's Exa cost is not counted twice", () => {
    const total = obs.reduce((n, o) => n + (o.costDetails?.total ?? 0), 0);
    expect(total).toBeCloseTo(0.01 + 0.018, 9);
    // retryExaCost (0.009) is already inside the lookup's 0.018, so the retry event carries it as metadata only.
    for (const retry of byName("lookup-retry")) expect(retry.costDetails).toBeUndefined();
    expect(byName("lookup-retry")[0]!.metadata).toMatchObject({ retryExaCost: 0.009 });
  });
});

describe("event kinds added since the exporter was written", () => {
  const obs = toObservations(turn)[0]!.observations;
  const root = obs.find((o) => o.type === "agent")!;
  const one = (name: string) => obs.find((o) => o.name === name)!;

  it("maps memory_recalled, context_trimmed, turn_repaired and token_count_estimated under the turn", () => {
    expect(one("memory-recalled")).toMatchObject({ type: "event", parentId: root.id, metadata: { seen: 3, preferences: { considered: 2, included: 1 }, notes: { considered: 1, included: 1 }, includedIds: ["m1", "m2"] } });
    expect(one("context-trimmed")).toMatchObject({ type: "event", parentId: root.id, metadata: { droppedTurns: 2, droppedTokens: 900, keptTokens: 4000, summaryTokens: 150 } });
    expect(one("turn-repaired")).toMatchObject({ type: "event", parentId: root.id, level: "WARNING", metadata: { toolUseIds: ["toolu_dangling"] } });
    expect(one("token-count-estimated")).toMatchObject({ type: "event", parentId: root.id, level: "WARNING", metadata: { tokens: 1200, basis: "4 chars per token" } });
  });

  it("nests lookup_retry under its lookup tool observation, else under the turn", () => {
    const lookup = obs.find((o) => o.name === "tool:lookup_company")!;
    const [nested, orphan] = obs.filter((o) => o.name === "lookup-retry");
    expect(nested).toMatchObject({ parentId: lookup.id, input: { reason: "quote_not_in_page" }, output: { before: "weak", after: "strong", outcome: "kept_retry" } });
    expect(nested!.level).toBeUndefined();
    expect(orphan).toMatchObject({ parentId: root.id, level: "WARNING" });
  });

  it("is deterministic with unique ids", () => {
    const again = toObservations(turn)[0]!.observations;
    expect(again).toEqual(obs);
    expect(new Set(obs.map((o) => o.id)).size).toBe(obs.length);
  });
});

describe("export", () => {
  class Fake implements SpanExporter {
    spans: ReadableSpan[] = [];
    export(spans: ReadableSpan[], done: (r: { code: number }) => void) {
      this.spans.push(...spans);
      done({ code: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  }
  afterEach(async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "";
    process.env.LANGFUSE_SECRET_KEY = "";
    await __setTraceTestHooks(undefined);
  });

  it("sends tool cost as langfuse cost details and still masks the new events", async () => {
    const exporter = new Fake();
    await __setTraceTestHooks({ exporter, onScore: () => undefined });
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    const leaky = turn.map((e) => (e.kind === "lookup_retry" && e.error ? { ...e, error: "failed for jane.doe@example.com with sk-ant-api03-abcdefghijklmnopqrstuvwx" } : e));
    emit(leaky);
    await flush();
    const tool = exporter.spans.find((s) => s.name === "tool:lookup_company")!;
    expect(JSON.parse(String(tool.attributes["langfuse.observation.cost_details"]))).toEqual({ total: 0.018 });
    const names = exporter.spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["memory-recalled", "lookup-retry", "context-trimmed", "turn-repaired", "token-count-estimated"]));
    const payload = JSON.stringify(exporter.spans.map((s) => s.attributes));
    expect(payload).not.toContain("jane.doe@example.com");
    expect(payload).not.toContain("sk-ant-api03");
  });
});

describe("hook swap isolation", () => {
  it("work left in flight (no flush) never reaches the next hooks' client", async () => {
    await __setTraceTestHooks({ exporter: new (class implements SpanExporter {
      export(_s: ReadableSpan[], done: (r: { code: number }) => void) { done({ code: 0 }); }
      async shutdown() {}
      async forceFlush() {}
    })(), onScore: () => undefined });
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
    emit(turn);
    const create = vi.fn(() => Promise.reject(new Error("unreachable")));
    await __setTraceTestHooks({ client: { score: { create: create as never }, flush: async () => undefined } });
    await flush();
    expect(create).not.toHaveBeenCalled();
    process.env.LANGFUSE_PUBLIC_KEY = "";
    process.env.LANGFUSE_SECRET_KEY = "";
    await __setTraceTestHooks(undefined);
  });
});

describe("listExisting uncosted", () => {
  it("reports existing observations with no cost so a cost refresh can target them", async () => {
    const client = {
      api: {
        observations: { getMany: async () => ({ data: [{ id: "a", totalCost: 0.02 }, { id: "b", totalCost: null }, { id: "c" }], meta: {} }) },
        scoresV3: { getManyV3: async () => ({ data: [], meta: {} }) },
      },
    };
    const out = await listExisting(client, ["t"], "eval");
    expect([...out.uncosted].sort()).toEqual(["b", "c"]);
  });
});
