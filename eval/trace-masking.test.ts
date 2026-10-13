import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * SPEC-observability §3 masking test. A fake exporter captures every span and score the
 * trace layer would send. A fixture run plants known secrets and personal data in the
 * seller text, a page body, a tool input, error messages, an approval note, a 👎 reason
 * and a planner call; none may appear in the captured payloads, the HMAC'd workspace id
 * must, and state.json / events.jsonl must be byte-identical with tracing on and off.
 */
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "trace-masking-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.DATA_DIR = root;
  return { root, runs: join(root, "runs"), workspaces: join(root, "workspaces") };
});

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { createTraceId } from "@langfuse/tracing";
import type { SearchPlan } from "../src/plan";
import { createRunState, saveState, type RunState } from "../src/agent/state";
import { decide, step } from "../src/agent/loop";
import type { LeadChecker } from "../src/agent/gate-port";
import type { AgentEvent } from "../src/agent/events";
import {
  __setTraceTestHooks,
  enabled,
  flush,
  hashWorkspaceId,
  mask,
  maskString,
  rootObservationId,
  toObservations,
  traceIdFor,
  tracePlanner,
  traceStats,
} from "../src/agent/trace";
import { POST as feedbackPOST } from "../app/api/workspaces/[id]/feedback/route";
import { score } from "../src/agent/trace";
import { pagePrefixHash } from "../src/agent/tools";
import { __promptHashCacheStats } from "../src/agent/loop";
import { createHash } from "node:crypto";

const RUN_ID = "5b6fc222-f7c2-4ad1-be01-00000000c0de";
const WS = "ws-planted-7f3c9a1e2b";
const HMAC_SECRET = "trace-hmac-test-secret-0123456789";
const ANTH = "sk-ant-api03-PLANTEDsecretKEY0123456789abcdefABCDEF";
const EXA = process.env.EXA_API_KEY && process.env.EXA_API_KEY.length >= 8 ? process.env.EXA_API_KEY : "exa-planted-0123456789abcdef";
const ADMIN = "admin-PLANTED-token-0123456789";
const EMAIL = "jane.doe.planted@example.org";
const PHONE = "+1 415 555 0134";
const IP = "203.0.113.77";
const PLANTS = { ANTH, EXA, ADMIN, EMAIL, PHONE, IP, WS };

const NOW = new Date("2026-10-12T09:00:00.000Z");

const plan = (): SearchPlan => ({
  label: `Ops leads for ${EMAIL} (${WS})`,
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: `firmographics; seller contact ${PHONE}`,
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
});

function msg(id: string, stop_reason: string, content: unknown[]) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
  };
}

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

function scriptedClient() {
  const responses: unknown[] = [
    msg("msg_01", "tool_use", [tool("tu_strategy", "propose_strategy", { angles: ["expansion"], first_queries: ["warehouse"], est_cost_dollars: 0.1 })]),
    msg("msg_02", "tool_use", [
      { type: "thinking", thinking: "PRIVATE-REASONING-MARKER weigh the seller notes", signature: "sig" },
      { type: "text", text: `Searching. Notes from the seller site: ${ANTH} ${EMAIL}` },
      tool("tu_search", "search_signals", { query: `3PL warehouse ${EMAIL} ${PHONE} ${IP} ${WS} ${ADMIN}` }),
    ]),
    msg("msg_03", "tool_use", [tool("tu_lookup", "lookup_company", { name: "Acme Logistics" })]),
    msg("msg_04", "tool_use", [
      tool("tu_read", "read_page", { url: "https://news.example.com/acme" }),
      tool("tu_bad", "read_page", { url: "https://bad.example.com/page" }),
      tool("tu_submit", "submit_lead", { company: "Acme Logistics", signal_url: "https://news.example.com/acme", why_now: "Opened a warehouse." }),
    ]),
    new Error(`upstream rejected ${ANTH} for ${EMAIL} from ${IP}`),
  ];
  return {
    messages: {
      create: vi.fn(async () => {
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    },
  };
}

const checker: LeadChecker = (_p, input) => ({
  ok: true,
  details: {
    key: input.company.toLowerCase(),
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
});

const searchResult = {
  results: [{
    url: "https://news.example.com/acme",
    title: "Acme Logistics expands",
    publishedDate: "2026-10-01T00:00:00.000Z",
    text: `Acme Logistics opened a warehouse. Contact ${EMAIL}.`,
    summary: JSON.stringify({ company_name: "Acme Logistics", signal_type: "expansion", signal_summary: "Acme opened a warehouse.", signal_date: "2026-10-01" }),
  }],
  costDollars: { total: 0.01 },
};

const lookupResult = {
  result: { url: "https://acme.example" },
  summary: { description: "Acme Logistics", industry: "Logistics", employee_estimate: 200, employee_estimate_source: "200 employees", is_public_or_enterprise: false, hq: "Austin, TX", is_operator: true },
  costDollars: { total: 0.01 },
};

async function readExaContents(url: string) {
  if (url.includes("bad.example")) throw new Error(`fetch failed key=${EXA} admin=${ADMIN} from ${IP}`);
  return {
    title: `Acme page ${ANTH}`,
    publishedDate: "2026-10-01",
    text: `Full page text with ${EMAIL}, ${PHONE}, ${IP}, ${ANTH}, ${ADMIN}, ${EXA} and ${WS}.`,
    costDollars: { total: 0.001 },
  };
}

async function scenario(): Promise<{ state: string; events: string }> {
  await rm(tmp.runs, { recursive: true, force: true });
  await rm(tmp.workspaces, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
    const s: RunState = createRunState({ id: RUN_ID, workspaceId: WS, plan: plan(), createdAt: NOW.toISOString() });
    await saveState(s);
    const c = scriptedClient();
    const deps = {
      client: c as never,
      checkLead: checker,
      now: NOW,
      exaSearch: vi.fn(async () => searchResult) as never,
      lookupCompany: vi.fn(async () => lookupResult) as never,
      readExaContents: vi.fn(readExaContents) as never,
    };
    const save = async () => saveState(s, s.version);
    await step(s, deps);
    await save();
    await decide(s, { approve: true, note: `ok, ping ${EMAIL} or ${PHONE}` });
    await save();
    for (let i = 0; i < 4; i += 1) {
      await step(s, deps);
      await save();
    }
    expect(s.leads.map((l) => l.company)).toEqual(["Acme Logistics"]);
    expect(s.status).toBe("error");
    const response = await feedbackPOST(
      new Request(`http://x/api/workspaces/${WS}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          company: "Acme Logistics",
          verdict: "down",
          reason: `Wrong company, contact ${EMAIL} or ${PHONE}; key ${ANTH}; ws ${WS}`,
          runId: RUN_ID,
          signal_url: "https://news.example.com/acme",
        }),
      }),
      { params: { id: WS } },
    );
    expect(response.status).toBe(200);
    const dir = join(tmp.runs, RUN_ID);
    return { state: await readFile(join(dir, "state.json"), "utf8"), events: await readFile(join(dir, "events.jsonl"), "utf8") };
  } finally {
    vi.useRealTimers();
  }
}

class FakeExporter implements SpanExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function spanPayload(span: ReadableSpan) {
  return {
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    resource: span.resource.attributes,
  };
}

function setTracingEnv(on: boolean) {
  process.env.LANGFUSE_PUBLIC_KEY = on ? "pk-lf-test-public" : "";
  process.env.LANGFUSE_SECRET_KEY = on ? "sk-lf-test-secret" : "";
  process.env.TRACE_HMAC_SECRET = HMAC_SECRET;
  process.env.EXA_API_KEY = EXA;
  process.env.ADMIN_TOKEN = ADMIN;
}

afterEach(async () => {
  setTracingEnv(false);
  await __setTraceTestHooks(undefined);
});

afterAll(() => rm(tmp.root, { recursive: true, force: true }));

describe("trace masking (SPEC-observability §3)", () => {
  it("never exports planted secrets or PII, keeps the HMAC'd workspace id, and leaves state/events byte-identical", async () => {
    setTracingEnv(false);
    expect(enabled()).toBe(false);
    const off = await scenario();
    expect(traceStats().emitted).toBe(0);

    const exporter = new FakeExporter();
    const scores: Array<Record<string, unknown>> = [];
    await __setTraceTestHooks({ exporter, onScore: (body) => scores.push(body) });
    setTracingEnv(true);
    expect(enabled()).toBe(true);
    const on = await scenario();
    await tracePlanner(
      "profile",
      WS,
      { kind: "url", input: `https://seller.example/?contact=${EMAIL}&key=${ANTH}` },
      async () => ({ profile: { offering: `We sell to ${PHONE} at ${IP}; admin ${ADMIN}` }, cost: 0 }),
      (r) => r,
    );
    await flush();

    // Byte-identical run files with tracing on and off.
    expect(on.state).toBe(off.state);
    expect(on.events).toBe(off.events);

    // The planted strings really are in the run files (so the test is not vacuous)...
    for (const value of [ANTH, EMAIL, PHONE, IP, WS, ADMIN]) expect(on.events + on.state).toContain(value);
    // ...and none of them reaches an exported payload.
    const payload = JSON.stringify({ spans: exporter.spans.map(spanPayload), scores });
    for (const [name, value] of Object.entries(PLANTS)) {
      expect(payload.includes(value), `${name} leaked`).toBe(false);
    }
    // Thinking text is never recorded or exported (§3), not even its field.
    expect(on.events).not.toContain("PRIVATE-REASONING-MARKER");
    expect(on.events).not.toContain('"thinking"');
    expect(payload).not.toContain("PRIVATE-REASONING-MARKER");
    expect(payload).not.toContain("thinking");
    const hashed = hashWorkspaceId(WS, HMAC_SECRET)!;
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(payload).toContain(hashed);

    // Everything in the file was exported once: one span per observation, unique ids.
    const events = on.events.trim().split("\n").map((line) => JSON.parse(line) as AgentEvent);
    const traces = toObservations(events, { model: "claude-opus-5-5" });
    const expected = traces.flatMap((t) => t.observations);
    const agentSpans = exporter.spans.filter((s) => !s.name.startsWith("planner-"));
    expect(agentSpans.map((s) => s.spanContext().spanId).sort()).toEqual(expected.map((o) => o.id).sort());
    expect(new Set(agentSpans.map((s) => s.spanContext().spanId)).size).toBe(agentSpans.length);
    expect(traceStats().exportFailures).toBe(0);

    // Session = run, user = HMAC(workspace), trace ids = SDK createTraceId(runId:turn).
    for (const span of agentSpans) {
      expect(span.attributes["session.id"]).toBe(RUN_ID);
      expect(span.attributes["user.id"]).toBe(hashed);
      expect(span.attributes["langfuse.environment"]).toBeDefined();
    }
    expect(traceIdFor(RUN_ID, 2)).toBe(await createTraceId(`${process.env.LANGFUSE_TRACING_ENVIRONMENT}:${RUN_ID}:2`));

    // Scores: a gate verdict on the submit span and the 👎 on the same span.
    const submit = expected.find((o) => o.name === "tool:submit_lead")!;
    expect(scores.find((s) => s.name === "gate_verdict")).toMatchObject({ value: "accepted", observationId: submit.id, traceId: submit.traceId });
    expect(scores.find((s) => s.name === "user_feedback")).toMatchObject({ value: -1, observationId: submit.id, traceId: submit.traceId, dataType: "NUMERIC" });

    // The planner call is its own trace, keyed to the HMAC'd workspace.
    const planner = exporter.spans.find((s) => s.name === "planner-profile")!;
    expect(planner.attributes["session.id"]).toBe(hashed);
  });
});

describe("toObservations", () => {
  const ev = (over: Partial<AgentEvent> & Pick<AgentEvent, "kind" | "turn" | "ts">): AgentEvent => ({ runId: RUN_ID, promptVersion: "p1", ...over }) as AgentEvent;

  it("is deterministic and maps one turn to one trace rooted at turn_end", () => {
    const events = [
      ev({ kind: "policy", turn: 1, ts: "2026-10-12T09:00:00.000Z", scope: "loop", check: "limits", outcome: "pass" }),
      ev({ kind: "model_call", turn: 1, ts: "2026-10-12T09:00:02.000Z", latencyMs: 2000, tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 }, claudeCost: 0.01, model: "claude-opus-5-5", responseId: "msg_a", stop_reason: "tool_use", response: { text: "hi", tool_uses: [{ id: "t1", name: "update_todo", input: "{}" }] } }),
      ev({ kind: "tool_call", turn: 1, ts: "2026-10-12T09:00:03.000Z", tool: "update_todo", input: {}, toolUseId: "t1", latencyMs: 5, is_error: false, exaCost: 0, resultSummary: "ok" }),
      ev({ kind: "turn_end", turn: 1, ts: "2026-10-12T09:00:03.000Z", durationMs: 3000, status: "running", spend: { total: 0.01 }, leads: 0, before: { status: "running", turn: 0 } }),
    ];
    const a = toObservations(events);
    expect(a).toEqual(toObservations(events));
    expect(a).toHaveLength(1);
    const [root, ...children] = a[0]!.observations;
    expect(root).toMatchObject({ id: rootObservationId(RUN_ID, 1), type: "agent", name: "agent-turn", startTime: "2026-10-12T09:00:00.000Z" });
    expect(root!.parentId).toBeUndefined();
    expect(children.map((o) => [o.type, o.name])).toEqual([["guardrail", "policy"], ["generation", "model"], ["tool", "tool:update_todo"]]);
    expect(children.every((o) => o.parentId === root!.id)).toBe(true);
    expect(children[1]).toMatchObject({ startTime: "2026-10-12T09:00:00.000Z", usageDetails: { input: 1, output: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });
  });

  it("gives events from separate appends of the same turn distinct ids (decision after the step)", () => {
    const step = [ev({ kind: "approval_request", turn: 1, ts: "2026-10-12T09:00:01.000Z", tool: "propose_strategy", input: {} })];
    const later = [ev({ kind: "decision", turn: 1, ts: "2026-10-12T09:05:00.000Z", approve: true, tool: "propose_strategy", requestTs: "2026-10-12T09:00:01.000Z" })];
    const ids = [...toObservations(step), ...toObservations(later)].flatMap((t) => t.observations.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
    const approval = toObservations(later)[0]!.observations[0]!;
    expect(approval).toMatchObject({ name: "approval", startTime: "2026-10-12T09:00:01.000Z", endTime: "2026-10-12T09:05:00.000Z", metadata: { waitMs: 299000 } });
    // The whole file maps to the same ids as the two live batches.
    expect(toObservations([...step, ...later]).flatMap((t) => t.observations.map((o) => o.id))).toEqual(ids);
  });
});

describe("mask", () => {
  it("redacts key formats, bearer tokens, emails, phones and IPs but keeps ordinary text", () => {
    const out = maskString(`Authorization: Bearer abcdefghijklmnop123 key sk-ant-api03-xyzxyzxyzxyz mail a.b@c.io call (415) 555-0134 ip 10.0.0.1 and 2001:db8::1`);
    expect(out).not.toMatch(/abcdefghijklmnop123|sk-ant-api03|a\.b@c\.io|555-0134|10\.0\.0\.1|2001:db8::1/);
    expect(maskString("Acme opened a 120,000 sq ft warehouse on 2026-10-01 with 1,100-1,800 staff at 09:30")).toBe(
      "Acme opened a 120,000 sq ft warehouse on 2026-10-01 with 1,100-1,800 staff at 09:30",
    );
  });

  it("masks nested values and keys without mutating the input, and clips long strings", () => {
    const input = { [`k ${EMAIL}`]: [{ note: `x ${EMAIL}` }], long: "a".repeat(5000) };
    const out = mask(input) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    expect(JSON.stringify(input)).toContain(EMAIL);
    expect(String(out.long).length).toBeLessThan(2100);
  });
});

describe("O1 review fixes", () => {
  it("a rejecting score transport never throws and is counted as an export failure", async () => {
    const create = vi.fn(() => Promise.reject(new Error("langfuse unreachable")));
    await __setTraceTestHooks({ exporter: new FakeExporter(), client: { score: { create: create as never }, flush: async () => undefined } });
    setTracingEnv(true);
    expect(() => score({ traceId: "a".repeat(32) }, "probe", 1)).not.toThrow();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).toHaveBeenCalledTimes(1);
    expect(traceStats().exportFailures).toBe(1);
  });

  it("qualifies trace ids by environment, so eval backfills and production traces never share ids", async () => {
    expect(traceIdFor(RUN_ID, 3, "eval")).not.toBe(traceIdFor(RUN_ID, 3, "production"));
    expect(traceIdFor(RUN_ID, 3, "eval")).toBe(await createTraceId(`eval:${RUN_ID}:3`));
    const events = [{ ts: "2026-10-12T09:00:00.000Z", runId: RUN_ID, turn: 3, kind: "turn_end", promptVersion: "p", durationMs: 1 }] as AgentEvent[];
    const evalIds = toObservations(events, { environment: "eval" })[0]!;
    const prodIds = toObservations(events, { environment: "production" })[0]!;
    expect(evalIds.traceId).toBe(traceIdFor(RUN_ID, 3, "eval"));
    expect(evalIds.observations[0]!.id).not.toBe(prodIds.observations[0]!.id);
  });

  it("read_page summaries carry a prefix hash of the first 4,096 chars plus the full length", () => {
    const text = "a".repeat(4096) + "TAIL".repeat(10_000);
    expect(pagePrefixHash(text)).toBe(createHash("sha256").update("a".repeat(4096)).digest("hex").slice(0, 16));
    expect(pagePrefixHash(text)).toBe(pagePrefixHash("a".repeat(4096) + "different tail"));
  });

  it("hashes the system prompt and tool list once and reuses the hash on later model calls", async () => {
    const before = __promptHashCacheStats();
    setTracingEnv(false);
    await scenario();
    const after = __promptHashCacheStats();
    // 4 successful model calls x (system + tools); at most the first pair misses.
    expect(after.misses - before.misses).toBeLessThanOrEqual(2);
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(6);
  });
});
