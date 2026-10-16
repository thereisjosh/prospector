import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Temp RUNS_DIR / WORKSPACES_DIR; placeholder keys so nothing here can depend on real ones.
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "live-stream-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.EXA_API_KEY ??= "test-key";
  delete process.env.DEMO_MODE;
  return { root, runs: join(root, "runs") };
});
import type { MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import type { SearchPlan } from "../src/plan";
import { createRunState, loadState, saveState, type RunState } from "../src/agent/state";
import { step } from "../src/agent/loop";
import { appendEvents, makeEvent, readLastEvents, type AgentEvent } from "../src/agent/events";
import { subscribeLive, type LiveMessage } from "../src/agent/live-bus";
import { openEventStream } from "../src/agent/live";
import { claudeCostDollars } from "../src/agent/config";
import type { LeadChecker } from "../src/agent/gate-port";

afterAll(() => rm(tmp.root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-10-12T00:00:00.000Z");
const plan: SearchPlan = {
  label: "Live stream",
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
  ({ ...createRunState({ id: crypto.randomUUID(), workspaceId: `ws-${crypto.randomUUID().slice(0, 8)}`, plan, createdAt: "2026-10-12T00:00:00.000Z" }), strategyApproved: true, ...over }) as RunState;

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 };
const msg = (stop_reason: string, content: unknown[], id = "msg_1") => ({ id, type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { ...USAGE } });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileEvents = (runId: string): AgentEvent[] => {
  let raw = "";
  try {
    raw = readFileSync(join(tmp.runs, runId, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AgentEvent);
};
// A handback already present: an end_turn does not make the extra (non-streaming) handback call.
const HANDBACK = { shortfall: "0 of 10", top_reasons: [], suggestions: [] };

/** lookup_company fake: each name settles after its own delay. */
function delayedLookup(delays: Record<string, number>) {
  return vi.fn(async (name: string) => {
    await sleep(delays[name] ?? 0);
    return { result: { url: `https://${name.toLowerCase()}.example`, text: `${name} page` }, summary: { description: name, employee_estimate: 200, hq: "Austin, TX" } };
  });
}

describe("loop: events as they happen", () => {
  it("writes tool_started x3 before the tools run, then each tool_call the moment it settles (completion order), with increasing seq", async () => {
    const s = newState();
    const create = vi.fn(async () => msg("tool_use", [use("a", "lookup_company", { name: "A" }), use("b", "lookup_company", { name: "B" }), use("c", "lookup_company", { name: "C" })]));
    // What a tailer sees at each append: the file's kinds at that moment.
    const seen: string[][] = [];
    const off = subscribeLive(s.id, (m: LiveMessage) => {
      if (m.type === "appended") seen.push(fileEvents(s.id).map((e) => `${e.kind}${e.toolUseId ? `:${e.toolUseId}` : ""}`));
    });
    const result = await step(s, { client: { messages: { create } } as never, checkLead: checker, now: NOW, lookupCompany: delayedLookup({ A: 30, B: 10, C: 20 }) as never });
    off();

    const events = fileEvents(s.id);
    const tools = events.filter((e) => e.kind === "tool_started" || e.kind === "tool_call").map((e) => `${e.kind}:${e.toolUseId}`);
    expect(tools).toEqual(["tool_started:a", "tool_started:b", "tool_started:c", "tool_call:b", "tool_call:c", "tool_call:a"]);
    // seq is the line number, strictly increasing, and the step response carries the same events with the same seq.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(result.events.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    // model_call, policy and turn_end keep their place around the tool lines.
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("policy")).toBeLessThan(kinds.indexOf("model_call"));
    expect(kinds.indexOf("model_call")).toBeLessThan(kinds.indexOf("tool_started"));
    expect(kinds[kinds.length - 1]).toBe("turn_end");
    // Live, not batched: a reader saw B settled while A was still running, and the started lines before any result.
    expect(seen.some((k) => k.includes("tool_call:b") && !k.includes("tool_call:a"))).toBe(true);
    expect(seen.some((k) => k.includes("tool_started:c") && !k.some((x) => x.startsWith("tool_call")))).toBe(true);
    const started = events.find((e) => e.kind === "tool_started" && e.toolUseId === "a")!;
    expect(started).toMatchObject({ tool: "lookup_company", input: { name: "A" }, turn: 1 });
    expect(typeof started.ts).toBe("string");
  });

  it("after a crash mid-batch, the reloaded run still repairs the dangling calls and seq continues from the file", async () => {
    const s = newState();
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const lookup = vi.fn(async (name: string) => {
      if (name === "C") await hang;
      else await sleep(5);
      return { result: { url: `https://${name}.example`, text: name }, summary: { description: name } };
    });
    const create = vi.fn(async () => msg("tool_use", [use("a", "lookup_company", { name: "A" }), use("b", "lookup_company", { name: "B" }), use("c", "lookup_company", { name: "C" })]));
    const inflight = step(s, { client: { messages: { create } } as never, checkLead: checker, now: NOW, lookupCompany: lookup as never });
    for (let i = 0; i < 100 && fileEvents(s.id).filter((e) => e.kind === "tool_call").length < 2; i += 1) await sleep(5);
    const before = fileEvents(s.id);
    expect(before.filter((e) => e.kind === "tool_call").map((e) => e.toolUseId).sort()).toEqual(["a", "b"]);
    // The process dies here: what is on disk is the assistant turn with three tool_use blocks and no results.
    await saveState(s);

    // A fresh process: new module instances, no in-memory seq cache.
    vi.resetModules();
    const fresh = {
      state: await import("../src/agent/state"),
      loop: await import("../src/agent/loop"),
    };
    const loaded = await fresh.state.loadState(s.id);
    expect(loaded.repairedToolUseIds).toEqual(["a", "b", "c"]);
    const resumed = await fresh.loop.step(loaded, { client: { messages: { create: vi.fn(async () => msg("end_turn", [{ type: "text", text: "done" }])) } } as never, checkLead: checker, now: NOW });
    expect(resumed.events.find((e) => e.kind === "turn_repaired")?.toolUseIds).toEqual(["a", "b", "c"]);
    const lastBefore = before[before.length - 1]!.seq!;
    expect(resumed.events[0]!.seq).toBe(lastBefore + 1);
    const all = fileEvents(s.id);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));

    // The "dead" step finishing late in the same file still gets unique, continuing seqs (lock + re-read).
    release();
    await inflight;
    const end = fileEvents(s.id);
    expect(new Set(end.map((e) => e.seq)).size).toBe(end.length);
    expect(end.map((e) => e.seq)).toEqual(end.map((_, i) => i + 1));
  });
});

/* ---------- streaming model call ---------- */

function fakeStream(events: unknown[], final: unknown, options: { failAt?: number; error?: Error } = {}) {
  const listeners: Array<(e: MessageStreamEvent) => void> = [];
  return {
    on(name: string, cb: (e: MessageStreamEvent) => void) {
      if (name === "streamEvent") listeners.push(cb);
      return this;
    },
    async finalMessage() {
      for (let i = 0; i < events.length; i += 1) {
        if (options.failAt === i) throw options.error ?? new Error("stream dropped");
        await sleep(1);
        for (const l of listeners) l(events[i] as MessageStreamEvent);
      }
      if (options.failAt !== undefined && options.failAt >= events.length) throw options.error ?? new Error("stream dropped");
      return final;
    },
  };
}

const FINAL = msg("end_turn", [{ type: "thinking", thinking: "private", signature: "sig" }, { type: "text", text: "Hello there. Done." }], "msg_final");
const STREAM_EVENTS = [
  { type: "message_start", message: { ...FINAL, content: [], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "there. Done." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "x", name: "finish", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"summary":' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null } },
  { type: "message_stop" },
];

const comparable = (e: AgentEvent) => {
  const { ts, latencyMs, runId, seq, ...rest } = e;
  void ts, latencyMs, runId, seq;
  return rest;
};

describe("loop: streaming model call", () => {
  it("forwards visible text deltas as ephemeral messages (never thinking or tool input), and the model_call event equals the non-streaming one", async () => {
    const streamed = newState({ handback: HANDBACK });
    const deltas: LiveMessage[] = [];
    const off = subscribeLive(streamed.id, (m) => {
      if (m.type !== "appended") deltas.push(m);
    });
    const params: unknown[] = [];
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("create must not be called when streaming works");
        }),
        stream: vi.fn((p: unknown) => {
          params.push(p);
          return fakeStream(STREAM_EVENTS, structuredClone(FINAL));
        }),
      },
    };
    const a = await step(streamed, { client: client as never, checkLead: checker, now: NOW });
    off();
    expect(deltas).toEqual([
      { type: "assistant_text_delta", turn: 1, text: "Hello " },
      { type: "assistant_text_delta", turn: 1, text: "there. Done." },
    ]);
    expect(JSON.stringify(deltas)).not.toContain("private");
    expect(JSON.stringify(deltas)).not.toContain("summary");
    // Deltas are not persisted.
    expect(fileEvents(streamed.id).map((e) => e.kind)).not.toContain("assistant_text_delta");
    // Prompt caching and params unchanged: same request as the non-streaming call.
    expect(params[0]).toMatchObject({ cache_control: { type: "ephemeral" }, system: [{ cache_control: { type: "ephemeral" } }], output_config: { effort: "medium" } });

    const plain = newState({ handback: HANDBACK });
    const createOnly = { messages: { create: vi.fn(async () => structuredClone(FINAL)) } };
    const b = await step(plain, { client: createOnly as never, checkLead: checker, now: NOW });
    const callA = a.events.find((e) => e.kind === "model_call")!;
    const callB = b.events.find((e) => e.kind === "model_call")!;
    expect(comparable(callA)).toEqual(comparable(callB));
    expect(streamed.spend.claude).toBeCloseTo(plain.spend.claude, 12);
    expect(callA.claudeCost).toBe(claudeCostDollars(streamed.model, FINAL.usage));
  });

  it("a stream that fails mid-way is retried once without streaming, with a WARNING event that bills the partial tokens", async () => {
    const s = newState({ handback: HANDBACK });
    const create = vi.fn(async () => structuredClone(FINAL));
    const client = { messages: { create, stream: vi.fn(() => fakeStream(STREAM_EVENTS, FINAL, { failAt: 7 })) } };
    const result = await step(s, { client: client as never, checkLead: checker, now: NOW });
    expect(create).toHaveBeenCalledTimes(1);
    const fallback = result.events.find((e) => e.kind === "stream_fallback")!;
    expect(fallback).toMatchObject({ started: true, reason: "stream dropped", partialTokens: { input: 100, output: 1, cache_read: 20, cache_creation: 10 } });
    const partial = claudeCostDollars(s.model, { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 });
    expect(fallback.claudeCost).toBeCloseTo(partial, 12);
    const call = result.events.find((e) => e.kind === "model_call")!;
    expect(s.spend.claude).toBeCloseTo(partial + (call.claudeCost as number), 12);
    const kinds = result.events.map((e) => e.kind);
    expect(kinds.indexOf("stream_fallback")).toBeLessThan(kinds.indexOf("model_call"));
    expect(s.status).toBe("done");
  });

  it("an HTTP error before the stream starts is not retried here: the loop's existing error handling applies", async () => {
    const s = newState();
    const create = vi.fn(async () => structuredClone(FINAL));
    const refused = Object.assign(new Error("rate limited"), { status: 429, name: "RateLimitError" });
    const client = { messages: { create, stream: vi.fn(() => fakeStream(STREAM_EVENTS, FINAL, { failAt: 0, error: refused })) } };
    const result = await step(s, { client: client as never, checkLead: checker, now: NOW });
    expect(create).not.toHaveBeenCalled();
    expect(result.events.map((e) => e.kind)).toContain("error");
    expect(result.events.map((e) => e.kind)).not.toContain("stream_fallback");
    expect(s.status).toBe("running"); // retryable: the next step tries again
  });
});

/* ---------- SSE route ---------- */

async function reader(res: Response) {
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const pump = (async () => {
    for (;;) {
      const { value, done: d } = await r.read();
      if (d) {
        done = true;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  })();
  return {
    get text() {
      return buffer;
    },
    get done() {
      return done;
    },
    async until(pred: (text: string) => boolean, timeoutMs = 2000) {
      const start = Date.now();
      while (!pred(buffer)) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out; got:\n${buffer}`);
        await sleep(5);
      }
      return Date.now() - start;
    },
    cancel: () => r.cancel(),
    pump,
  };
}

const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((f) => f.includes("event: event"))
    .map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as AgentEvent);

async function liveRun() {
  const s = newState();
  await saveState(s);
  await appendEvents(s.id, [makeEvent(s, "policy", { n: 1 }), makeEvent(s, "policy", { n: 2 }), makeEvent(s, "policy", { n: 3 })]);
  return s;
}

const get = async (id: string, query: string, headers: Record<string, string> = {}, signal?: AbortSignal) => {
  const { GET } = await import("../app/api/runs/[id]/events/route");
  return GET(new Request(`http://x/api/runs/${id}/events${query}`, { headers: { "x-forwarded-for": crypto.randomUUID(), ...headers }, signal }), { params: { id } });
};

describe("GET /api/runs/:id/events (SSE)", () => {
  it("serves events after `after`, then streams a newly appended line within 300 ms", async () => {
    const s = await liveRun();
    const controller = new AbortController();
    const res = await get(s.id, "?after=1", { "x-workspace-id": s.workspaceId }, controller.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const body = await reader(res);
    await body.until((t) => frames(t).length >= 2);
    expect(frames(body.text).map((e) => [e.seq, e.n])).toEqual([[2, 2], [3, 3]]);
    expect(body.text).toContain("id: 2\nevent: event\n");

    const appendedAt = Date.now();
    await appendEvents(s.id, [makeEvent(s, "tool_started", { tool: "lookup_company", toolUseId: "z" })]);
    await body.until((t) => frames(t).length >= 3, 300);
    expect(Date.now() - appendedAt).toBeLessThan(300);
    expect(frames(body.text)[2]).toMatchObject({ seq: 4, kind: "tool_started", toolUseId: "z" });
    controller.abort();
    await body.cancel().catch(() => undefined);
  });

  it("also picks up a line another process appended (no in-process notification): the poll floor", async () => {
    const s = await liveRun();
    const res = await get(s.id, "?after=3", { "x-workspace-id": s.workspaceId });
    const body = await reader(res);
    await body.until((t) => t.includes(": connected"));
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(tmp.runs, s.id, "events.jsonl"), JSON.stringify({ ...makeEvent(s, "policy"), seq: 4 }) + "\n");
    const ms = await body.until((t) => frames(t).length >= 1, 300);
    expect(ms).toBeLessThan(300);
    await body.cancel().catch(() => undefined);
  });

  it("honours Last-Event-ID from a reconnecting EventSource", async () => {
    const s = await liveRun();
    const res = await get(s.id, "?after=0", { "x-workspace-id": s.workspaceId, "last-event-id": "2" });
    const body = await reader(res);
    await body.until((t) => frames(t).length >= 1);
    await sleep(30);
    expect(frames(body.text).map((e) => e.seq)).toEqual([3]);
    await body.cancel().catch(() => undefined);
  });

  it("forwards assistant text deltas, which are never in the file", async () => {
    const s = await liveRun();
    const res = await get(s.id, "?after=3", { "x-workspace-id": s.workspaceId });
    const body = await reader(res);
    await body.until((t) => t.includes(": connected"));
    const { publishLive } = await import("../src/agent/live-bus");
    publishLive(s.id, { type: "assistant_text_delta", turn: 2, text: "Looking at" });
    await body.until((t) => t.includes("event: delta"));
    expect(body.text).toContain('event: delta\ndata: {"turn":2,"text":"Looking at"}\n\n');
    expect(readFileSync(join(tmp.runs, s.id, "events.jsonl"), "utf8")).not.toContain("Looking at");
    await body.cancel().catch(() => undefined);
  });

  it("closes with an end frame once the run is done, after sending what is left", async () => {
    const s = await liveRun();
    const res = await get(s.id, "?after=3", { "x-workspace-id": s.workspaceId });
    const body = await reader(res);
    await body.until((t) => t.includes(": connected"));
    await appendEvents(s.id, [makeEvent(s, "stop", { reason: "target_leads", status: "done" })]);
    s.status = "done";
    await saveState(s);
    await body.until(() => body.done, 3000);
    expect(frames(body.text).map((e) => e.kind)).toEqual(["stop"]);
    expect(body.text.trimEnd().endsWith('event: end\ndata: {"status":"done"}')).toBe(true);
  });

  it("a finished run: sends everything after `after`, then ends at once", async () => {
    const s = await liveRun();
    s.status = "stopped";
    await saveState(s);
    const res = await get(s.id, "?after=0", { "x-workspace-id": s.workspaceId });
    const body = await reader(res);
    await body.until(() => body.done);
    expect(frames(body.text).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(body.text).toContain('event: end\ndata: {"status":"stopped"}');
  });

  it("rejects a wrong or missing workspace, accepts it in the query (EventSource cannot send headers)", async () => {
    const s = await liveRun();
    expect((await get(s.id, "?after=0", { "x-workspace-id": "someone-else" })).status).toBe(403);
    expect((await get(s.id, "?after=0")).status).toBe(400);
    expect((await get(crypto.randomUUID(), "?after=0", { "x-workspace-id": s.workspaceId })).status).toBe(404);
    expect((await get("../etc", "?after=0", { "x-workspace-id": s.workspaceId })).status).toBe(400);
    const ok = await get(s.id, `?after=3&workspaceId=${s.workspaceId}`);
    expect(ok.status).toBe(200);
    await ok.body!.cancel();
  });

  it("heartbeats as an SSE comment frame", async () => {
    const s = await liveRun();
    const stream = openEventStream({ runId: s.id, after: 3, readStatus: async () => "running", heartbeatMs: 20 });
    const body = await reader(new Response(stream));
    await body.until((t) => t.includes(": heartbeat\n\n"), 500);
    expect(body.text.startsWith("retry: 3000\n\n: connected\n\n")).toBe(true);
    await body.cancel();
  });

  it("stops its timers and watchers when the client goes away", async () => {
    const s = await liveRun();
    const controller = new AbortController();
    const stream = openEventStream({ runId: s.id, after: 3, readStatus: async () => "running", heartbeatMs: 10, signal: controller.signal });
    const body = await reader(new Response(stream));
    await body.until((t) => t.includes(": heartbeat"));
    controller.abort();
    await body.until(() => body.done);
    const length = body.text.length;
    await sleep(40);
    expect(body.text.length).toBe(length);
  });
});

describe("demo run: the replay writes its events as it paces them", () => {
  it("streams the demo's lines one by one: tool_started for the batch, then each tool_call on its own", async () => {
    const { createDemoRun, demoStep } = await import("../src/demo/replay");
    const workspace = `ws-${crypto.randomUUID().slice(0, 8)}`;
    const { id } = await createDemoRun(workspace);
    const out = await demoStep(id); // turn 1: policy, memory, model_call, approval
    expect(out.status).toBe("awaiting_approval");
    const { demoDecide } = await import("../src/demo/replay");
    await demoDecide(id, { approve: true });
    const res = await get(id, `?after=0&workspaceId=${workspace}`);
    expect(res.status).toBe(200);
    const body = await reader(res);
    const arrivals: Array<{ at: number; kind: string }> = [];
    const t0 = Date.now();
    const watch = (async () => {
      let n = 0;
      while (!body.done && Date.now() - t0 < 8000) {
        const f = frames(body.text);
        for (; n < f.length; n += 1) arrivals.push({ at: Date.now() - t0, kind: `${f[n]!.kind}${f[n]!.tool ? `:${f[n]!.tool}` : ""}` });
        await sleep(5);
      }
    })();
    const stepped = await demoStep(id); // turn 2 of the recording: three searches
    await sleep(400);
    await body.cancel().catch(() => undefined);
    await watch;
    const toolCalls = arrivals.filter((a) => a.kind.startsWith("tool_call"));
    const starts = arrivals.filter((a) => a.kind.startsWith("tool_started"));
    expect(starts.length).toBe(toolCalls.length);
    expect(toolCalls.length).toBeGreaterThanOrEqual(3);
    // Every start lands before the first result, and results arrive spread out, not in one burst.
    expect(Math.max(...starts.map((s) => s.at))).toBeLessThanOrEqual(toolCalls[0]!.at);
    const gaps = toolCalls.slice(1).map((c, i) => c.at - toolCalls[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(200);
    // The step response carries the same events with the same seq (the page dedupes on it).
    const fileSeqs = (await readLastEvents(id, 1000)).map((e) => e.seq);
    for (const e of stepped.events) expect(fileSeqs).toContain(e.seq);
    expect(new Set(fileSeqs).size).toBe(fileSeqs.length);
  }, 15_000);
});

describe("seq on appends", () => {
  it("is assigned under the lock: concurrent appenders never share a seq", async () => {
    const s = newState();
    await saveState(s);
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvents(s.id, [makeEvent(s, "policy", { i }), makeEvent(s, "policy", { i, second: true })])));
    const events = fileEvents(s.id);
    expect(events).toHaveLength(40);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("reads lines written before seq existed as their line number", async () => {
    const s = newState();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(tmp.runs, s.id), { recursive: true });
    const legacy = [makeEvent(s, "policy"), makeEvent(s, "policy")].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(tmp.runs, s.id, "events.jsonl"), legacy);
    await appendEvents(s.id, [makeEvent(s, "turn_end")]);
    expect((await readLastEvents(s.id)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await loadState(s.id).catch(() => null)) === null).toBe(true); // no state.json needed for events
  });
});

describe("Langfuse mapping of the new events", () => {
  it("stream_fallback is a WARNING event carrying the partial cost; tool_started adds no observation", async () => {
    const { toObservations } = await import("../src/agent/trace");
    const ts = "2026-10-16T00:00:01.000Z";
    const e = (over: Partial<AgentEvent>): AgentEvent => ({ ts, runId: crypto.randomUUID(), turn: 2, kind: "policy", promptVersion: "p", ...over }) as AgentEvent;
    const runId = crypto.randomUUID();
    const [trace] = toObservations([
      e({ runId, kind: "stream_fallback", reason: "stream dropped", started: true, claudeCost: 0.002 }),
      e({ runId, kind: "tool_started", tool: "lookup_company", toolUseId: "a" }),
      e({ runId, kind: "tool_call", tool: "lookup_company", toolUseId: "a", latencyMs: 40, exaCost: 0.01 }),
    ]);
    const names = trace!.observations.map((o) => o.name);
    expect(names).toEqual(["stream-fallback", "tool:lookup_company"]);
    expect(trace!.observations[0]).toMatchObject({ type: "event", level: "WARNING", costDetails: { total: 0.002 } });
  });
});
