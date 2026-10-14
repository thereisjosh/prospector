import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/events";
import { runEndScores } from "../src/agent/online-eval";
import { createRunState, type RunState } from "../src/agent/state";
import { traceIdFor } from "../src/agent/trace";
import { getV1Plan } from "./fixtures/v1-plans";
import { gradeRun } from "./graders";
import { runWorker, type WorkerDeps } from "./online/worker";

const CLEAN_ID = "00000000-0000-4000-8000-000000000011";
const BAD_ID = "00000000-0000-4000-8000-000000000012";
const TOKEN = "t".repeat(32);
const NOW = new Date("2026-10-14T12:00:00.000Z");

let tick = 0;
function ev(runId: string, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}): AgentEvent {
  tick += 1;
  return { ts: new Date(Date.UTC(2026, 9, 14, 10, 0, tick)).toISOString(), runId, turn: 1, kind, promptVersion: "test", ...payload };
}

function lead(company: string): RunState["leads"][number] {
  return { company, signal_url: `https://news.example.com/${company.toLowerCase().replace(/\W+/g, "-")}`, why_now: "opened a warehouse", summary: {} as never, details: {}, turn: 1 };
}

function run(id: string, company: string, spend: number): { state: RunState; events: AgentEvent[] } {
  const l = lead(company);
  const events = [
    ev(id, "model_call", { claudeCost: spend / 2 }),
    ev(id, "approval_request", { tool: "propose_strategy", input: { angles: ["3PL expansions"] } }),
    ev(id, "decision", { approve: true, tool: "propose_strategy" }),
    ev(id, "tool_call", { tool: "search_signals", input: { query: "3pl opens warehouse" }, exaCost: spend / 4 }),
    ev(id, "tool_call", { tool: "lookup_company", input: { name: company }, exaCost: spend / 4 }),
    ev(id, "tool_call", { tool: "submit_lead", input: { company, signal_url: l.signal_url } }),
    ev(id, "submit_verdict", { company, code: "accepted", ok: true }),
    ev(id, "stop", { status: "done", reason: "target_leads" }),
  ];
  const state = createRunState({ id, workspaceId: `ws-${id.slice(-2)}`, plan: getV1Plan(1), targetLeads: 1, maxCostDollars: 1 });
  state.status = "done";
  state.stopReason = "target_leads";
  state.strategyApproved = true;
  state.leads = [l];
  state.spend = { claude: spend / 2, exa: spend / 2, total: spend };
  state.counters = { turns: 3, activeMs: 60_000, noProgressTurns: 0, toolCalls: 3 };
  return { state, events };
}

function exportRun(item: { state: RunState; events: AgentEvent[] }): Record<string, unknown> {
  const { messages: _messages, caches: _caches, workspaceId: _workspaceId, pendingApproval: _pendingApproval, prompt: _prompt, ...state } = item.state;
  return { id: item.state.id, updatedAt: NOW.toISOString(), state, events: item.events };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function makeDeps(options: {
  runs?: Array<Record<string, unknown>>;
  issues?: Record<string, Array<Record<string, unknown>>>;
  scores?: Record<string, unknown[]>;
  queueItems?: Array<Record<string, unknown>>;
  cap?: string;
} = {}) {
  const postedScores: Record<string, unknown>[] = [];
  const createdIssues: Record<string, unknown>[] = [];
  const pauses: Record<string, unknown>[] = [];
  const queueCreates: Record<string, unknown>[] = [];
  const issues = options.issues ?? {};
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/admin/runs/export")) return json({ runs: options.runs ?? [] });
    if (url.includes("/api/admin/pause")) {
      pauses.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return json({ paused: true });
    }
    if (url.includes("api.github.com") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      createdIssues.push({ ...body, number: createdIssues.length + 1 });
      return json({ number: createdIssues.length });
    }
    if (url.includes("api.github.com")) {
      const label = new URL(url).searchParams.get("labels") ?? "";
      return json(issues[label] ?? []);
    }
    return json({ error: "not_found" }, 404);
  });

  const langfuse = {
    score: {
      create: vi.fn((body: Record<string, unknown>) => postedScores.push(body)),
      flush: vi.fn(async () => undefined),
    },
    api: {
      projects: { get: vi.fn(async () => ({ id: "project-1" })) },
      scoresV3: {
        getManyV3: vi.fn(async (req?: Record<string, unknown>) => {
          const name = String(req?.name ?? "");
          const cursor = req?.cursor ? String(req.cursor) : undefined;
          const pages = options.scores?.[name] ?? [];
          if (cursor) return jsonPage([]);
          return jsonPage(pages);
        }),
      },
      annotationQueues: {
        listQueues: vi.fn(async () => ({ data: [{ id: "queue-1", name: "review-queue" }], meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 } })),
        listQueueItems: vi.fn(async () => ({ data: options.queueItems ?? [], meta: { page: 1, limit: 100, totalItems: options.queueItems?.length ?? 0, totalPages: 1 } })),
        createQueueItem: vi.fn(async (_queueId: string, body: Record<string, unknown>) => {
          queueCreates.push(body);
          return { id: `item-${queueCreates.length}`, ...body };
        }),
      },
    },
  };
  const env = {
    APP_URL: "https://app.example.com",
    ADMIN_TOKEN: TOKEN,
    GITHUB_TOKEN: "github-token",
    GITHUB_REPOSITORY: "owner/repo",
    LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
    DAILY_SPEND_CAP_DOLLARS: options.cap ?? "10",
  };
  const deps: WorkerDeps = { fetch, langfuse, env, now: () => NOW, log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { deps, postedScores, createdIssues, pauses, queueCreates, langfuse };
}

function jsonPage(data: unknown[]) {
  return { data, meta: { limit: 100 } };
}

describe("online evals worker", () => {
  it("posts deterministic run-end scores and opens one must-pass issue for the planted violation", async () => {
    const clean = run(CLEAN_ID, "Palmer Logistics", 0.04);
    const bad = run(BAD_ID, "Overcap Logistics", 1.2);
    const { deps, postedScores, createdIssues } = makeDeps({ runs: [exportRun(clean), exportRun(bad)] });
    const summary = await runWorker(deps);
    expect(summary).toMatchObject({ runs: 2, graded: 2, mustPassFailures: 1, issuesOpened: 1 });
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]?.title).toContain(BAD_ID);
    expect(createdIssues[0]?.title).not.toContain(CLEAN_ID);
    const expected = [
      ...runEndScores({ ...clean.state, id: CLEAN_ID }, clean.events, gradeRun(clean.state, clean.events), "production"),
      ...runEndScores({ ...bad.state, id: BAD_ID }, bad.events, gradeRun(bad.state, bad.events), "production"),
    ].map((score) => score.id);
    expect(postedScores.map((score) => score.id)).toEqual(expected);
  });

  it("does not open a second must-pass issue when an open issue already mentions the run id", async () => {
    const bad = run(BAD_ID, "Overcap Logistics", 1.2);
    const { deps, createdIssues } = makeDeps({ runs: [exportRun(bad)], issues: { "must-pass": [{ title: `must-pass failed: caps_respected on run ${BAD_ID}` }] } });
    const summary = await runWorker(deps);
    expect(summary.mustPassFailures).toBe(1);
    expect(summary.issuesOpened).toBe(0);
    expect(createdIssues).toHaveLength(0);
  });

  it("re-grades only runs updated in the last 3 h (each run's scores are re-posted a bounded number of times), but counts today's cost from all of them", async () => {
    const old = run(BAD_ID, "Earlier Logistics", 1.2);
    const item = { ...exportRun(old), updatedAt: new Date(NOW.getTime() - 4 * 3600_000).toISOString() };
    const { deps, postedScores, createdIssues, pauses } = makeDeps({ runs: [item], cap: "1" });
    const summary = await runWorker(deps);
    expect(summary).toMatchObject({ runs: 1, graded: 0, scoresPosted: 0, mustPassFailures: 0 });
    expect(postedScores).toHaveLength(0);
    expect(createdIssues.every((issue) => String(issue.title).startsWith("spend cap exceeded"))).toBe(true);
    expect(pauses).toHaveLength(1);
  });

  it("pauses and opens a spend-cap issue only when the UTC day cost exceeds the cap", async () => {
    const bad = run(BAD_ID, "Spend Cap Logistics", 1.2);
    const over = makeDeps({ runs: [exportRun(bad)], cap: "1" });
    await runWorker(over.deps);
    expect(over.pauses).toHaveLength(1);
    expect(over.createdIssues.some((issue) => String(issue.title).startsWith("spend cap exceeded on 2026-10-14"))).toBe(true);

    const under = makeDeps({ runs: [exportRun(bad)], cap: "2" });
    await runWorker(under.deps);
    expect(under.pauses).toHaveLength(0);
    expect(under.createdIssues.some((issue) => String(issue.title).startsWith("spend cap exceeded"))).toBe(false);
  });

  it("derives judge_good and queues no-answer traces once", async () => {
    const traceNo = traceIdFor("run-no", 1, "production");
    const traceGood = traceIdFor("run-good", 1, "production");
    const traceSkip = traceIdFor("run-skip", 1, "production");
    const score = (name: string, observationId: string, traceId: string, value: string) => ({
      id: `${name}-${observationId}`,
      name,
      value,
      dataType: "CATEGORICAL",
      environment: "production",
      subject: { kind: "observation", id: observationId, traceId },
    });
    const scores = {
      judge_q1: [score("judge_q1", "obs-no", traceNo, "no"), score("judge_q1", "obs-good", traceGood, "yes"), score("judge_q1", "obs-skip", traceSkip, "yes")],
      judge_q2: [score("judge_q2", "obs-no", traceNo, "yes"), score("judge_q2", "obs-good", traceGood, "cannot_verify"), score("judge_q2", "obs-skip", traceSkip, "yes")],
      judge_q3: [score("judge_q3", "obs-no", traceNo, "yes"), score("judge_q3", "obs-good", traceGood, "yes"), score("judge_q3", "obs-skip", traceSkip, "cannot_verify")],
    };
    const first = makeDeps({ scores });
    const summary = await runWorker(first.deps);
    expect(summary.judgeGoodPosted).toBe(2);
    expect(first.postedScores.filter((body) => body.name === "judge_good").map((body) => body.value)).toEqual([0, 1]);
    expect(first.queueCreates).toEqual([{ objectId: traceNo, objectType: "TRACE", status: "PENDING" }]);

    const second = makeDeps({ scores, queueItems: [{ id: "item-1", objectId: traceNo, objectType: "TRACE" }] });
    const summary2 = await runWorker(second.deps);
    expect(summary2.queued).toBe(0);
    expect(second.queueCreates).toHaveLength(0);
  });

  it("dry-run performs no score posts, issue creates, pause posts or queue creates", async () => {
    const bad = run(BAD_ID, "Dry Run Logistics", 1.2);
    const traceNo = traceIdFor("dry-no", 1, "production");
    const scores = {
      judge_q1: [{ name: "judge_q1", value: "no", subject: { kind: "observation", id: "obs-no", traceId: traceNo } }],
      judge_q2: [{ name: "judge_q2", value: "yes", subject: { kind: "observation", id: "obs-no", traceId: traceNo } }],
      judge_q3: [{ name: "judge_q3", value: "yes", subject: { kind: "observation", id: "obs-no", traceId: traceNo } }],
    };
    const { deps, postedScores, createdIssues, pauses, queueCreates } = makeDeps({ runs: [exportRun(bad)], scores, cap: "1" });
    const summary = await runWorker({ ...deps, dryRun: true });
    expect(summary).toMatchObject({ mustPassFailures: 1, paused: false, judgeGoodPosted: 1, queued: 1 });
    expect(postedScores).toHaveLength(0);
    expect(createdIssues).toHaveLength(0);
    expect(pauses).toHaveLength(0);
    expect(queueCreates).toHaveLength(0);
  });
});
