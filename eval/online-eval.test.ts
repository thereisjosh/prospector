import { existsSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Online evaluation at run end (SPEC-observability §5, src/agent/online-eval.ts). All mocked:
 * spans go to a fake exporter, scores and queue items to hooks; no network.
 */
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "online-eval-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.DATA_DIR = root;
  return { root, runs: join(root, "runs"), workspaces: join(root, "workspaces") };
});

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { SearchPlan } from "../src/plan";
import { createRunState, saveState, type RunState } from "../src/agent/state";
import { decide, step, stopRun } from "../src/agent/loop";
import type { LeadChecker } from "../src/agent/gate-port";
import { __setTraceTestHooks, flush, observationIdFor, toolObservationKey, traceIdFor, LEAD_JUDGE_OBSERVATION } from "../src/agent/trace";
import {
  findAcceptedSubmit,
  inJudgeSample,
  judgeBudget,
  leadKey,
  onlineEvalIdle,
  readJudgeLedger,
  readOnlineEvalRecords,
  reserveJudgeSlot,
  resetOnlineJudgeWarning,
  settleJudgeSpend,
  thresholdVerdict,
  ONLINE_JUDGE_MIN_CONFIDENCE,
  runEnded,
  runEndScores,
  runScoreId,
} from "../src/agent/online-eval";
import { judgeContractFromPlan, judgeLeadFromState, judgePayload } from "../src/agent/judge-input";
import { gradeRun } from "./graders";
import { userPrompt } from "./harness/judge";
import type { BlindLead } from "./harness/blind";
import type { AgentEvent } from "../src/agent/events";
import { runWorker } from "./online/worker";
import { jevCostDollars, type JevLeadVerdict } from "../src/judges/jev";
import { POST as feedbackPOST } from "../app/api/workspaces/[id]/feedback/route";

const WS = "ws-online-eval-01";
const NOW = new Date("2026-10-12T09:00:00.000Z");

const plan = (): SearchPlan => ({
  label: "Online eval test",
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
});

function msg(id: string, stop_reason: string, content: unknown[]) {
  return { id, type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
}
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** propose → (approve) → lookup → submit → end_turn (1 of 2 leads → handback). */
function scriptedClient() {
  const responses: unknown[] = [
    msg("m1", "tool_use", [tool("tu_strategy", "propose_strategy", { angles: ["expansion"], first_queries: ["warehouse"], est_cost_dollars: 0.1 })]),
    msg("m2", "tool_use", [tool("tu_search", "search_signals", { query: "3PL warehouse" })]),
    msg("m2b", "tool_use", [tool("tu_lookup", "lookup_company", { name: "Acme Logistics" })]),
    msg("m3", "tool_use", [tool("tu_submit", "submit_lead", { company: "Acme Logistics", signal_url: "https://news.example.com/acme", why_now: "Opened a warehouse." })]),
    msg("m4", "end_turn", [{ type: "text", text: "Done." }]),
    msg("m5", "end_turn", [{ type: "text", text: JSON.stringify({ shortfall: "1 of 2", top_reasons: [], suggestions: [{ field: "months", value: 6, why: "few recent events" }] }) }]),
  ];
  return { messages: { create: vi.fn(async () => responses.shift()) } };
}

const checker: LeadChecker = (_p, input) => ({
  ok: true,
  details: { key: input.company.toLowerCase(), event_date: "2026-10-01", date_source: "signal", employees: 200, size_basis: "quoted", required_gates_passed: ["is_operator"], optional_gates_passed: [], hq: "Austin, United States", multiplier: 1, fit_reason: "test fit" },
});

const searchResult = {
  results: [{
    url: "https://news.example.com/acme",
    title: "Acme Logistics expands",
    publishedDate: "2026-10-01T00:00:00.000Z",
    text: "Acme Logistics opened a warehouse.",
    summary: JSON.stringify({ company_name: "Acme Logistics", signal_type: "expansion", signal_summary: "Acme opened a warehouse.", signal_date: "2026-10-01" }),
  }],
  costDollars: { total: 0.01 },
};

const lookupResult = {
  result: { url: "https://acme.example" },
  summary: { description: "Acme Logistics", industry: "Logistics", employee_estimate: 200, employee_estimate_source: "200 employees", is_public_or_enterprise: false, hq: "Austin, TX", is_operator: true },
  costDollars: { total: 0.01 },
};

async function runScenario(runId: string): Promise<RunState> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
    const s: RunState = createRunState({ id: runId, workspaceId: WS, plan: plan(), createdAt: NOW.toISOString(), targetLeads: 2 } as never);
    s.contract.targetLeads = 2;
    await saveState(s);
    const deps = { client: scriptedClient() as never, checkLead: checker, now: NOW, exaSearch: vi.fn(async () => searchResult) as never, lookupCompany: vi.fn(async () => lookupResult) as never, readExaContents: vi.fn() as never };
    await step(s, deps);
    await saveState(s, s.version);
    await decide(s, { approve: true });
    await saveState(s, s.version);
    for (let i = 0; i < 5 && s.status === "running"; i += 1) {
      await step(s, deps);
      await saveState(s, s.version);
    }
    return s;
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

/** A fake Jev server: answers per question from `jevAnswers`, bills 2,500 input tokens per call. */
type JevPlan = { choice: string; probs?: Record<string, number>; confidence: number };
let jevPlans: Record<string, JevPlan>;
let jevCalls: Array<{ url: string; auth: string; body: { state: unknown; questions: Record<string, unknown> } }>;
let jevFail: { status: number } | undefined;
const yes: JevPlan = { choice: "yes", confidence: 0.95 };

function installFakeJev() {
  jevCalls = [];
  jevFail = undefined;
  jevPlans = { q1: yes, q2: yes, q3: yes };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as { state: unknown; questions: Record<string, unknown> };
      jevCalls.push({ url: String(url), auth: init.headers.Authorization!, body });
      if (jevFail) return new Response("boom", { status: jevFail.status });
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => {
          const plan = jevPlans[id]!;
          const probabilities = plan.probs ?? { yes: plan.choice === "yes" ? 0.9 : 0.05, no: plan.choice === "no" ? 0.9 : 0.05, cannot_verify: plan.choice === "cannot_verify" ? 0.9 : 0.05 };
          return [id, { type: "choice", choice: plan.choice, probabilities, confidence: plan.confidence }];
        }),
      );
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 2500, output_tokens: 0 } }), { status: 200 });
    }),
  );
}
const JEV_COST = jevCostDollars(2500);

let exporter: FakeExporter;
let scores: Array<Record<string, unknown>>;
let queued: Array<{ queue: string; objectId: string; objectType: string }>;

async function tracingOn(environment = "production") {
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-public";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
  process.env.LANGFUSE_TRACING_ENVIRONMENT = environment;
  exporter = new FakeExporter();
  scores = [];
  queued = [];
  await __setTraceTestHooks({ exporter, onScore: (b) => scores.push(b), onQueueItem: (q) => queued.push(q) });
}

async function settle() {
  await onlineEvalIdle();
  await flush();
}

const readEvents = (runId: string): AgentEvent[] =>
  readFileSync(join(tmp.runs, runId, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AgentEvent);

/** The run's background work may see the faked run date or the real one; count both. */
async function judgedOnRunDays() {
  const a = await readJudgeLedger(NOW, tmp.root);
  if (new Date().toISOString().slice(0, 10) === NOW.toISOString().slice(0, 10)) return a;
  const b = await readJudgeLedger(new Date(), tmp.root);
  return { judged: a.judged + b.judged, samples: a.samples + b.samples, dollars: a.dollars + b.dollars };
}

async function clearLedgers() {
  for (const d of [NOW, new Date()]) await rm(join(tmp.root, `online-judge-${d.toISOString().slice(0, 10)}.json`), { force: true });
}

beforeEach(async () => {
  await clearLedgers();
  delete process.env.ONLINE_JUDGE_DAILY_CAP_DOLLARS;
  delete process.env.ONLINE_JUDGE_COST_PER_LEAD_DOLLARS;
  process.env.JEV_API_KEY = "jev-test-key";
  resetOnlineJudgeWarning();
  installFakeJev();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.JEV_API_KEY;
  process.env.LANGFUSE_PUBLIC_KEY = "";
  process.env.LANGFUSE_SECRET_KEY = "";
  process.env.LANGFUSE_TRACING_ENVIRONMENT = "ci";
  await __setTraceTestHooks(undefined);
});

afterAll(() => rm(tmp.root, { recursive: true, force: true }));

describe("run-end scores (code graders + outcomes)", () => {
  it("posts every applicable grader and the outcome scores once per run, on the run's last trace", async () => {
    await tracingOn();
    const runId = "0e0e0e0e-0000-4000-8000-000000000001";
    const s = await runScenario(runId);
    expect(s.status).toBe("done");
    expect(s.handback?.suggestions[0]?.field).toBe("months");
    await settle();

    const events = readEvents(runId);
    const report = gradeRun(s, events);
    const expected = runEndScores(s, events, report, "production");
    const runScores = scores.filter((b) => expected.some((e) => e.id === b.id));
    expect(runScores).toHaveLength(expected.length);
    const byName = Object.fromEntries(runScores.map((b) => [b.name, b]));
    for (const r of report.results.filter((x) => x.applicable)) expect(byName[r.name]).toMatchObject({ value: r.pass ? 1 : 0, dataType: "BOOLEAN" });
    expect(byName.must_pass).toMatchObject({ value: report.pass ? 1 : 0, dataType: "BOOLEAN" });
    expect(byName.accepted_leads).toMatchObject({ value: 1, dataType: "NUMERIC" });
    expect(byName.stop_reason).toMatchObject({ value: "end_turn", dataType: "CATEGORICAL" });
    expect(byName.handback).toMatchObject({ value: 1, dataType: "BOOLEAN" });
    expect(byName.run_cost_dollars).toMatchObject({ dataType: "NUMERIC" });
    expect(byName.cost_per_accepted_lead).toMatchObject({ value: Math.round(s.spend.total * 10_000) / 10_000, dataType: "NUMERIC" });
    const lastTrace = traceIdFor(runId, Math.max(...events.map((e) => e.turn)), "production");
    expect(new Set(runScores.map((b) => b.traceId))).toEqual(new Set([lastTrace]));
    expect(byName.must_pass!.id).toBe(runScoreId("production", runId, "must_pass"));

    // Once per run: a second end signal, a stop on the finished run, a second process — nothing new.
    const before = scores.length;
    runEnded(s);
    await stopRun(s);
    await settle();
    await __setTraceTestHooks({ exporter, onScore: (b) => scores.push(b), onQueueItem: (q) => queued.push(q) });
    runEnded(s);
    await settle();
    expect(scores.length).toBe(before);
    expect((await readOnlineEvalRecords(runId)).filter((r) => r.kind === "run_end")).toHaveLength(1);
  });

  it("judges every lead of a handback run (priority), as a lead-judge child of its submit span, and queues the run for review", async () => {
    await tracingOn();
    const runId = "0e0e0e0e-0000-4000-8000-000000000002";
    const s = await runScenario(runId);
    await settle();
    const events = readEvents(runId);
    const lead = s.leads[0]!;
    const toolUseId = findAcceptedSubmit(events, lead)!;
    expect(toolUseId).toBe("tu_submit");
    const leadTrace = traceIdFor(runId, lead.turn, "production");

    const judgeSpans = exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION);
    expect(judgeSpans).toHaveLength(1);
    const span = judgeSpans[0]!;
    expect(span.spanContext().traceId).toBe(leadTrace);
    expect(span.parentSpanContext?.spanId).toBe(observationIdFor(leadTrace, toolObservationKey(toolUseId)));
    const input = JSON.parse(String(span.attributes["langfuse.observation.input"]));
    expect(input).toEqual(judgePayload({ ...judgeLeadFromState(lead), contract: judgeContractFromPlan(s.contract, new Date(s.createdAt)) }));
    expect(span.attributes["langfuse.observation.metadata.eval_priority"]).toBe("high");
    expect(span.attributes["langfuse.observation.metadata.eval_reason"]).toBe("handback");
    expect(span.attributes["langfuse.environment"]).toBe("production");

    expect(span.attributes["langfuse.observation.metadata.judge"]).toBe("jev");
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.auth).toBe("Bearer jev-test-key");
    expect(jevCalls[0]!.body.state).toEqual(input);
    expect(Object.keys(jevCalls[0]!.body.questions)).toEqual(["q1", "q2", "q3"]);
    expect(await judgedOnRunDays()).toMatchObject({ judged: 1, samples: 0 });
    const lastTrace = traceIdFor(runId, Math.max(...events.map((e) => e.turn)), "production");
    expect(queued).toEqual([{ queue: "review-queue", objectId: lastTrace, objectType: "TRACE" }]);

    // 👎 on the same lead: no second judge request (already judged), but its trace is queued.
    const response = await feedbackPOST(
      new Request(`http://x/api/workspaces/${WS}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: lead.company, verdict: "down", reason: "wrong company", runId, signal_url: lead.signal_url }),
      }),
      { params: { id: WS } },
    );
    expect(response.status).toBe(200);
    await settle();
    expect(exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION)).toHaveLength(1);
    expect(queued.map((q) => q.objectId)).toEqual(lastTrace === leadTrace ? [lastTrace] : [lastTrace, leadTrace]);
    const fb = scores.find((b) => b.name === "user_feedback");
    expect(fb).toMatchObject({ value: -1, comment: "wrong company", traceId: leadTrace, observationId: observationIdFor(leadTrace, toolObservationKey(toolUseId)) });
  });

  it("a 👎 selects an unjudged lead (thumbs_down, priority); a 👍 does nothing", async () => {
    await tracingOn();
    process.env.ONLINE_JUDGE_DAILY_CAP_DOLLARS = "0.5";
    process.env.ONLINE_JUDGE_COST_PER_LEAD_DOLLARS = "0.34"; // one lead per day
    const runId = "0e0e0e0e-0000-4000-8000-000000000003";
    // Use up today's only slot first, so the run-end selection is skipped (daily_cap)… (the
    // background work may see the faked run date or the real one: fill both days).
    expect(await reserveJudgeSlot("high", { date: NOW, dataDir: tmp.root })).toBe(true);
    if (new Date().toISOString().slice(0, 10) !== NOW.toISOString().slice(0, 10)) expect(await reserveJudgeSlot("high", { date: new Date(), dataDir: tmp.root })).toBe(true);
    const s = await runScenario(runId);
    await settle();
    expect(exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION)).toHaveLength(0);
    expect((await readOnlineEvalRecords(runId)).find((r) => r.kind === "judge_skipped")).toMatchObject({ why: "daily_cap", reason: "handback" });
    // …then a new day: the 👎 gets judged.
    await clearLedgers();
    delete process.env.ONLINE_JUDGE_COST_PER_LEAD_DOLLARS;
    const lead = s.leads[0]!;
    const post = (verdict: "up" | "down") =>
      feedbackPOST(
        new Request(`http://x/api/workspaces/${WS}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: lead.company, verdict, runId, signal_url: lead.signal_url }) }),
        { params: { id: WS } },
      );
    await post("up");
    await settle();
    expect(exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION)).toHaveLength(0);
    await post("down");
    await settle();
    const spans = exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["langfuse.observation.metadata.eval_reason"]).toBe("thumbs_down");
  });
});

describe("never on demo runs, never without Langfuse, never outside production for the judge", () => {
  it("demo run ids are ignored", async () => {
    await tracingOn();
    const s = createRunState({ id: "demo-0e0e0e0e-0000-4000-8000-000000000004", workspaceId: WS, plan: plan(), createdAt: NOW.toISOString() } as never);
    s.status = "done";
    s.stopReason = "end_turn";
    runEnded(s);
    await settle();
    expect(scores).toHaveLength(0);
    expect(existsSync(join(tmp.runs, s.id, "online-evals.jsonl"))).toBe(false);
  });

  it("with LANGFUSE_* unset a finished run posts nothing, writes nothing extra, and nothing throws", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "";
    process.env.LANGFUSE_SECRET_KEY = "";
    process.env.LANGFUSE_TRACING_ENVIRONMENT = "production";
    const sink: unknown[] = [];
    await __setTraceTestHooks({ exporter: new FakeExporter(), onScore: (b) => sink.push(b), onQueueItem: (q) => sink.push(q) });
    const runId = "0e0e0e0e-0000-4000-8000-000000000005";
    const s = await runScenario(runId);
    expect(s.status).toBe("done");
    expect(() => runEnded(s)).not.toThrow();
    await settle();
    expect(sink).toHaveLength(0);
    expect(existsSync(join(tmp.runs, runId, "online-evals.jsonl"))).toBe(false);
    expect(await judgedOnRunDays()).toEqual({ judged: 0, samples: 0, dollars: 0 });
    expect(jevCalls).toHaveLength(0);
  });

  it("outside the production environment the graders still score, but no lead is selected for the judge", async () => {
    await tracingOn("eval");
    const runId = "0e0e0e0e-0000-4000-8000-000000000006";
    await runScenario(runId);
    await settle();
    expect(scores.some((b) => b.name === "must_pass")).toBe(true);
    expect(exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION)).toHaveLength(0);
    expect(jevCalls).toHaveLength(0);
  });
});

describe("daily judge cap", () => {
  it("is ONLINE_JUDGE_DAILY_CAP_DOLLARS in Jev dollars; the per-lead reservation sets the samples' share", () => {
    expect(judgeBudget({})).toEqual({ capDollars: 3, costPerLeadDollars: 0.001, maxPerDay: 3000, maxSamplesPerDay: 1500 });
    expect(judgeBudget({ ONLINE_JUDGE_DAILY_CAP_DOLLARS: "0" }).maxPerDay).toBe(0);
    expect(judgeBudget({ ONLINE_JUDGE_DAILY_CAP_DOLLARS: "1", ONLINE_JUDGE_COST_PER_LEAD_DOLLARS: "0.25" })).toMatchObject({ maxPerDay: 4, maxSamplesPerDay: 2 });
  });

  it("never reserves more than the cap; samples stop at their share, priority leads use the rest", async () => {
    const env = { ONLINE_JUDGE_DAILY_CAP_DOLLARS: "1", ONLINE_JUDGE_COST_PER_LEAD_DOLLARS: "0.25" };
    const date = new Date("2026-11-01T12:00:00Z");
    const opts = { date, dataDir: tmp.root, env };
    const got = [];
    for (let i = 0; i < 3; i += 1) got.push(await reserveJudgeSlot("sample", opts));
    expect(got).toEqual([true, true, false]);
    const high = [];
    for (let i = 0; i < 3; i += 1) high.push(await reserveJudgeSlot("high", opts));
    expect(high).toEqual([true, true, false]);
    expect(await readJudgeLedger(date, tmp.root)).toEqual({ judged: 4, samples: 2, dollars: 1 });
    // Concurrent reservations never overshoot (file lock).
    const date2 = new Date("2026-11-02T12:00:00Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveJudgeSlot("high", { ...opts, date: date2 })));
    expect(results.filter(Boolean)).toHaveLength(4);
  });

  it("samples ~20% of leads deterministically", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => leadKey(`Company ${i}`, `https://e.com/${i}`));
    const share = keys.filter((k) => inJudgeSample("run-x", k)).length / keys.length;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
    expect(keys.map((k) => inJudgeSample("run-x", k))).toEqual(keys.map((k) => inJudgeSample("run-x", k)));
  });
});

describe("online judge on Jev (in-process)", () => {
  const judgeSpans = () => exporter.spans.filter((sp) => sp.name === LEAD_JUDGE_OBSERVATION);
  const judgeScores = () => scores.filter((b) => String(b.name).startsWith("judge_q"));

  it("writes judge_q1..q3 on the lead-judge observation with the raw verdict in metadata, logs cost, and applies the 0.4 confidence threshold", async () => {
    await tracingOn();
    jevPlans = { q1: yes, q2: { choice: "no", confidence: 0.7 }, q3: { choice: "yes", confidence: 0.31 } };
    const runId = "0e0e0e0e-0000-4000-8000-000000000011";
    const s = await runScenario(runId);
    await settle();
    const lead = s.leads[0]!;
    const leadTrace = traceIdFor(runId, lead.turn, "production");
    const obs = judgeSpans()[0]!;
    const obsId = obs.spanContext().spanId;

    const byName = Object.fromEntries(judgeScores().map((b) => [b.name, b]));
    expect(Object.keys(byName).sort()).toEqual(["judge_q1", "judge_q2", "judge_q3"]);
    for (const b of Object.values(byName)) expect(b).toMatchObject({ dataType: "CATEGORICAL", traceId: leadTrace, observationId: obsId });
    expect(byName.judge_q1).toMatchObject({ value: "yes" });
    expect(byName.judge_q2).toMatchObject({ value: "no" });
    // 0.31 < 0.4: a "yes" the judge was not sure of is cannot_verify; the raw answer is kept.
    expect(byName.judge_q3).toMatchObject({ value: "cannot_verify" });
    expect(byName.judge_q3!.metadata).toMatchObject({ judge: "jev", model: "jev-1.13.0", question: "q3", raw_answer: "yes", confidence: 0.31, threshold: 0.4, thresholded: true });
    expect((byName.judge_q3!.metadata as { probabilities: Record<string, number> }).probabilities.yes).toBe(0.9);
    expect(String(byName.judge_q3!.comment)).toContain("raw yes");
    expect(byName.judge_q2!.metadata).toMatchObject({ raw_answer: "no", thresholded: false });

    // Cost is on the observation (a generation with model, usage and costDetails).
    expect(obs.attributes["langfuse.observation.type"]).toBe("generation");
    expect(obs.attributes["langfuse.observation.model.name"]).toBe("jev-1.13.0");
    expect(JSON.parse(String(obs.attributes["langfuse.observation.cost_details"]))).toEqual({ total: JEV_COST });
    expect(JSON.parse(String(obs.attributes["langfuse.observation.usage_details"]))).toEqual({ input: 2500, output: 0 });
    const out = JSON.parse(String(obs.attributes["langfuse.observation.output"]));
    expect(out.judge_q3).toMatchObject({ answer: "cannot_verify", raw: "yes" });

    // The ledger holds the real cost, not the reservation.
    const ledger = await judgedOnRunDays();
    expect(ledger.judged).toBe(1);
    expect(ledger.dollars).toBeCloseTo(JEV_COST, 10);
  });

  it("thresholdVerdict: below 0.4 is cannot_verify, at 0.4 the raw answer stands", () => {
    const verdict: JevLeadVerdict = {
      q1: "yes", q2: "no", q3: "cannot_verify",
      probabilities: { q1: { yes: 0.5 }, q2: { no: 0.4 }, q3: { cannot_verify: 0.9 } },
      confidence: { q1: 0.399, q2: 0.4, q3: 0.1 },
      costDollars: 0, inputTokens: 0, model: "m",
    };
    expect(ONLINE_JUDGE_MIN_CONFIDENCE).toBe(0.4);
    expect(thresholdVerdict(verdict).map((a) => [a.answer, a.raw, a.thresholded])).toEqual([["cannot_verify", "yes", true], ["no", "no", false], ["cannot_verify", "cannot_verify", true]]);
  });

  it("the hourly worker picks these scores up (source EVAL,API), derives judge_good and queues the trace of a no", async () => {
    await tracingOn();
    jevPlans = { q1: yes, q2: { choice: "no", confidence: 0.8 }, q3: yes };
    const runId = "0e0e0e0e-0000-4000-8000-000000000012";
    const s = await runScenario(runId);
    await settle();
    const leadTrace = traceIdFor(runId, s.leads[0]!.turn, "production");
    const obsId = judgeSpans()[0]!.spanContext().spanId;
    const stored = judgeScores();
    expect(stored).toHaveLength(3);

    const posted: Array<Record<string, unknown>> = [];
    const queueCreates: Array<Record<string, unknown>> = [];
    const requests: Array<Record<string, unknown>> = [];
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    const summary = await runWorker({
      fetch: (async (url: string | URL) => (String(url).includes("/runs/export") ? json({ runs: [] }) : json([]))) as never,
      env: { APP_URL: "https://app.example.com", ADMIN_TOKEN: "t".repeat(32), GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" },
      now: () => NOW,
      log: { log: () => undefined, warn: () => undefined, error: () => undefined },
      langfuse: {
        score: { create: (b: Record<string, unknown>) => posted.push(b), flush: async () => undefined },
        api: {
          projects: { get: async () => ({ id: "p" }) },
          scoresV3: {
            getManyV3: async (req?: Record<string, unknown>) => {
              requests.push(req ?? {});
              if (req?.cursor) return { data: [], meta: {} };
              // What Langfuse returns for API-source scores: value as string, subject = the observation.
              return { data: stored.filter((b) => b.name === req?.name).map((b) => ({ name: b.name, value: b.value, source: "API", subject: { kind: "observation", id: b.observationId, traceId: b.traceId } })), meta: {} };
            },
          },
          annotationQueues: {
            listQueues: async () => ({ data: [{ id: "q", name: "review-queue" }], meta: { totalPages: 1 } }),
            listQueueItems: async () => ({ data: [], meta: { totalPages: 1 } }),
            createQueueItem: async (_q: string, b: Record<string, unknown>) => (queueCreates.push(b), {}),
          },
        },
      },
    });
    expect(requests.every((r) => r.source === "EVAL,API")).toBe(true);
    expect(summary).toMatchObject({ judgeGoodPosted: 1, queued: 1 });
    expect(posted.find((b) => b.name === "judge_good")).toMatchObject({ value: 0, observationId: obsId, traceId: leadTrace });
    expect(queueCreates).toEqual([{ objectId: leadTrace, objectType: "TRACE", status: "PENDING" }]);
  });

  it("the cap is enforced in Jev dollars: reservations count until the real cost replaces them", async () => {
    const env = { ONLINE_JUDGE_DAILY_CAP_DOLLARS: "0.001", ONLINE_JUDGE_COST_PER_LEAD_DOLLARS: "0.0004" };
    const date = new Date("2026-11-05T12:00:00Z");
    const opts = { date, dataDir: tmp.root, env };
    expect(await reserveJudgeSlot("high", opts)).toBe(true);
    expect(await reserveJudgeSlot("high", opts)).toBe(true);
    expect(await reserveJudgeSlot("high", opts)).toBe(false); // 0.0012 > 0.001
    // Both calls came back cheaper than the reservation: room for another.
    await settleJudgeSpend(0.0001, opts);
    await settleJudgeSpend(0.0001, opts);
    expect((await readJudgeLedger(date, tmp.root)).dollars).toBeCloseTo(0.0002, 10);
    expect(await reserveJudgeSlot("high", opts)).toBe(true);
    expect(await reserveJudgeSlot("high", opts)).toBe(true);
    expect(await reserveJudgeSlot("high", opts)).toBe(false);
  });

  it("with the daily cap spent no Jev call is made and the lead is logged as skipped", async () => {
    await tracingOn();
    process.env.ONLINE_JUDGE_DAILY_CAP_DOLLARS = "0.001";
    process.env.ONLINE_JUDGE_COST_PER_LEAD_DOLLARS = "0.001";
    for (const d of [NOW, new Date()]) expect(await reserveJudgeSlot("high", { date: d, dataDir: tmp.root })).toBe(true);
    const runId = "0e0e0e0e-0000-4000-8000-000000000013";
    await runScenario(runId);
    await settle();
    expect(jevCalls).toHaveLength(0);
    expect(judgeScores()).toHaveLength(0);
    expect((await readOnlineEvalRecords(runId)).find((r) => r.kind === "judge_skipped")).toMatchObject({ why: "daily_cap" });
  });

  it("without JEV_API_KEY nothing is judged, nothing falls back, and the warning prints once per process", async () => {
    await tracingOn();
    delete process.env.JEV_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runScenario("0e0e0e0e-0000-4000-8000-000000000014");
      await settle();
      await runScenario("0e0e0e0e-0000-4000-8000-000000000015");
      await settle();
      expect(jevCalls).toHaveLength(0);
      expect(judgeSpans()).toHaveLength(0);
      expect(judgeScores()).toHaveLength(0);
      expect(scores.some((b) => b.name === "must_pass")).toBe(true); // the code graders still ran
      expect(await judgedOnRunDays()).toEqual({ judged: 0, samples: 0, dollars: 0 });
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("JEV_API_KEY is not set"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a Jev error never fails the run: it is logged, no scores are written, the reservation is released", async () => {
    await tracingOn();
    jevFail = { status: 500 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const runId = "0e0e0e0e-0000-4000-8000-000000000016";
      const s = await runScenario(runId);
      expect(s.status).toBe("done");
      await settle();
      expect(jevCalls.length).toBeGreaterThan(0);
      expect(judgeScores()).toHaveLength(0);
      expect((await readOnlineEvalRecords(runId)).find((r) => r.kind === "judge_skipped")).toMatchObject({ why: "jev_error" });
      expect((await judgedOnRunDays()).dollars).toBeCloseTo(0, 10);
      expect(scores.some((b) => b.name === "must_pass")).toBe(true);
      expect(queued.length).toBe(1); // the handback still queues the run
      expect(warn.mock.calls.some((c) => String(c[0]).includes("Jev judge failed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("offline and online judges read the same lead JSON", () => {
  it("the online payload built from a pilot run's state equals what the offline judge was given for that run", () => {
    const dir = "eval/results/pilot-2026-10-12/S1/B_agent_opus/1";
    const state = JSON.parse(readFileSync(`${dir}/state.json`, "utf8")) as RunState;
    const record = JSON.parse(readFileSync(`${dir}/run.json`, "utf8")) as { now: string; leads: Array<Omit<BlindLead, "id" | "contract">> };
    const blind = JSON.parse(readFileSync("eval/results/pilot-2026-10-12/S1/blind.json", "utf8")) as BlindLead[];
    const contract = judgeContractFromPlan(state.contract, new Date(state.createdAt));
    expect(contract).toEqual(blind[0]!.contract);
    expect(state.leads.length).toBe(record.leads.length);
    state.leads.forEach((lead, i) => {
      const online = judgePayload({ ...judgeLeadFromState(lead), contract });
      // The pilot's run.json predates evidence (2026-10-14); a new cell records judgeLeadFromState(lead) itself (run-cell stateLeadToLead).
      const offline: BlindLead = { id: "L000", ...record.leads[i]!, evidence: judgeLeadFromState(lead).evidence, contract };
      expect(online).toEqual(judgePayload(offline));
      // The offline user prompt is exactly this JSON, pretty-printed, before the tool instruction.
      expect(userPrompt(offline).startsWith(`${JSON.stringify(online, null, 2)}\n\n`)).toBe(true);
      // Old persisted state (no AcceptedLead.evidence) still judges: empty signal fields, lookup + gate result from enrichment/details.
      expect(online.evidence).toMatchObject({ signal_title: "", signal_published_date: "", signal_excerpt: "" });
      expect(online.evidence.company_lookup?.description).toBeTruthy();
      expect(online.evidence.gate_result?.checks_passed).toContain("entity_mismatch");
      const { evidence: _e, ...withoutEvidence } = online;
      expect(withoutEvidence).toEqual((({ evidence: _x, ...rest }) => rest)(judgePayload({ id: "L000", ...record.leads[i]!, contract } as BlindLead)));
    });
  });
});
