import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

const plan = () => ({
  label: "API controls",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "Summarize signal.",
  companySummaryQuery: "Summarize company.",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
});

function jsonRequest(url: string, body: unknown, ip = crypto.randomUUID()) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function claudeMessage(usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

async function fresh(rootName = "api-controls-") {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("../src/planner");
  const root = mkdtempSync(join(tmpdir(), rootName));
  roots.push(root);
  process.env.DATA_DIR = root;
  delete process.env.RUNS_DIR;
  delete process.env.WORKSPACES_DIR;
  delete process.env.DEMO_MODE;
  delete process.env.NEXT_PUBLIC_DEMO;
  delete process.env.LIVE_MODE;
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  process.env.EXA_API_KEY = "exa-test";
  process.env.DAILY_SPEND_CAP_DOLLARS = "10";
  process.env.VISITOR_MAX_LIVE_RUNS = "2";
  process.env.VISITOR_MAX_DOLLARS = "2.50";
  return root;
}

beforeEach(async () => {
  await fresh();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run routes check that the caller's workspace owns the run (FAILURES #28)", () => {
  const OWNER = "owner-ws";
  const call = (method: string, workspace?: string, query = "") =>
    new Request(`http://x/api/runs/id${query}`, {
      method,
      headers: { "x-forwarded-for": crypto.randomUUID(), "content-type": "application/json", ...(workspace ? { "x-workspace-id": workspace } : {}) },
      body: method === "POST" ? JSON.stringify({ approve: true, toolUseId: "t" }) : undefined,
    });

  async function routes() {
    const { createRunState, saveState } = await import("../src/agent/state");
    const state = createRunState({ id: crypto.randomUUID(), workspaceId: OWNER, plan: plan() as never });
    await saveState(state);
    const run = await import("../app/api/runs/[id]/route");
    const step = await import("../app/api/runs/[id]/step/route");
    const stop = await import("../app/api/runs/[id]/stop/route");
    const decision = await import("../app/api/runs/[id]/decision/route");
    const unknownId = crypto.randomUUID();
    return {
      id: state.id,
      unknownId,
      all: [
        { name: "GET run", call: (r: Request, id: string) => run.GET(r, { params: { id } }), method: "GET" },
        { name: "POST step", call: (r: Request, id: string) => step.POST(r, { params: { id } }), method: "POST" },
        { name: "POST stop", call: (r: Request, id: string) => stop.POST(r, { params: { id } }), method: "POST" },
        { name: "POST decision", call: (r: Request, id: string) => decision.POST(r, { params: { id } }), method: "POST" },
      ],
    };
  }

  it("400 without a workspace, 403 for another workspace, 404 for an unknown run, on every run route", async () => {
    const { id, unknownId, all } = await routes();
    for (const route of all) {
      expect((await route.call(call(route.method), id)).status, `${route.name} no workspace`).toBe(400);
      expect((await route.call(call(route.method, "stranger"), id)).status, `${route.name} other workspace`).toBe(403);
      expect((await route.call(call(route.method, OWNER), unknownId)).status, `${route.name} unknown run`).toBe(404);
    }
  });

  it("a stranger's step, stop and decision change nothing and spend nothing", async () => {
    const { id, all } = await routes();
    const { loadState } = await import("../src/agent/state");
    const before = await loadState(id);
    for (const route of all) await route.call(call(route.method, "stranger"), id);
    const after = await loadState(id);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.spend.total).toBe(0);
  });

  it("?workspaceId= is not accepted on the run routes (only the EventSource route reads the query)", async () => {
    const { id, all } = await routes();
    for (const route of all) expect((await route.call(call(route.method, undefined, `?workspaceId=${OWNER}`), id)).status, route.name).toBe(400);
  });

  it("the owner gets through: GET run 200, stop 200", async () => {
    const { id, all } = await routes();
    expect((await all[0].call(call("GET", OWNER), id)).status).toBe(200);
    expect((await all[2].call(call("POST", OWNER), id)).status).toBe(200);
  });

  it("the demo run belongs to the workspace that created it; creating one needs a workspace", async () => {
    const { POST: create } = await import("../app/api/runs/route");
    const { GET } = await import("../app/api/runs/[id]/route");
    const { POST: step } = await import("../app/api/runs/[id]/step/route");
    expect((await create(jsonRequest("http://x/api/runs", { mode: "demo", plan: plan() }))).status).toBe(400);
    const made = await create(jsonRequest("http://x/api/runs", { mode: "demo", workspaceId: OWNER, plan: plan() }));
    expect(made.status).toBe(200);
    const { id } = (await made.json()) as { id: string };
    expect((await GET(call("GET", OWNER), { params: { id } })).status).toBe(200);
    expect((await GET(call("GET", "stranger"), { params: { id } })).status).toBe(403);
    expect((await step(call("POST", "stranger"), { params: { id } })).status).toBe(403);
    expect((await step(call("POST", OWNER), { params: { id } })).status).toBe(200);
  });
});

describe("R1 public controls", () => {
  it("POST /api/runs records live runs and returns 402 when the visitor run allowance is exhausted", async () => {
    process.env.VISITOR_MAX_LIVE_RUNS = "1";
    const { POST } = await import("../app/api/runs/route");
    const workspaceId = "visitor-one";
    const first = await POST(jsonRequest("http://x/api/runs", { workspaceId, plan: plan() }));
    expect(first.status).toBe(200);
    const second = await POST(jsonRequest("http://x/api/runs", { workspaceId, plan: plan() }));
    expect(second.status).toBe(402);
    expect(await second.json()).toEqual({ error: "allowance_exhausted", remainingRuns: 0, remainingDollars: 2.5 });
  });

  it("POST /api/runs defaults to Sonnet 5.5 and honours an explicit model: opus", async () => {
    process.env.VISITOR_MAX_LIVE_RUNS = "5";
    const { POST } = await import("../app/api/runs/route");
    const { loadState } = await import("../src/agent/state");
    const a = (await (await POST(jsonRequest("http://x/api/runs", { workspaceId: "visitor-model-a", plan: plan() }))).json()) as { id: string };
    expect((await loadState(a.id)).model).toBe("claude-sonnet-5-5");
    const b = (await (await POST(jsonRequest("http://x/api/runs", { workspaceId: "visitor-model-b", plan: plan(), model: "claude-opus-5-5" }))).json()) as { id: string };
    expect((await loadState(b.id)).model).toBe("claude-opus-5-5");
    const c = (await (await POST(jsonRequest("http://x/api/runs", { workspaceId: "visitor-model-c", plan: plan(), model: "kimi-k2.6" }))).json()) as { id: string };
    expect((await loadState(c.id)).model).toBe("claude-sonnet-5-5"); // public app: Anthropic only, falls to the default
  });

  it("live POST /api/runs requires a workspace id so allowance cannot be bypassed", async () => {
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(jsonRequest("http://x/api/runs", { plan: plan() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request." });
  });

  it("POST /api/runs returns 503 when the global daily cap is reached", async () => {
    process.env.DAILY_SPEND_CAP_DOLLARS = "0.01";
    const { addDailySpend } = await import("../app/api/_shared");
    await addDailySpend(0.02);
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(jsonRequest("http://x/api/runs", { workspaceId: "cap-visitor", plan: plan() }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "daily_budget_reached" });
  });

  it("POST /api/runs accepts mode demo even when live keys are available", async () => {
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(jsonRequest("http://x/api/runs", { workspaceId: "demo-choice", mode: "demo", plan: plan() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: expect.stringMatching(/^demo-/) });
  });

  it("POST /api/runs behaves demo-only when LIVE_MODE is off", async () => {
    process.env.LIVE_MODE = "off";
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(jsonRequest("http://x/api/runs", { workspaceId: "paused-choice", plan: plan() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: expect.stringMatching(/^demo-/) });
  });

  it("/api/status reports live availability, visitor allowance, caps, and rounded daily spend", async () => {
    const { recordLiveRun, addVisitorSpend } = await import("../src/agent/quota");
    const { addDailySpend } = await import("../app/api/_shared");
    await recordLiveRun("status-visitor");
    await addVisitorSpend("status-visitor", 0.126);
    await addDailySpend(1.234);
    const { GET } = await import("../app/api/status/route");
    const res = await GET(new Request("http://x/api/status?workspaceId=status-visitor", { headers: { "x-forwarded-for": crypto.randomUUID() } }));
    expect(await res.json()).toEqual({
      mode: "live",
      liveAvailable: true,
      visitor: { remainingRuns: 1, remainingDollars: 2.37 },
      caps: { perRun: 1, perRunMax: 5, visitorRuns: 2, visitorDollars: 2.5, daily: 10 },
      today: { spentDollars: 1.23 },
    });
  });

  it("/api/status reports paused demo mode when DAILY_SPEND_CAP_DOLLARS is zero", async () => {
    process.env.DAILY_SPEND_CAP_DOLLARS = "0";
    const { GET } = await import("../app/api/status/route");
    const res = await GET(new Request("http://x/api/status?workspaceId=paused-status", { headers: { "x-forwarded-for": crypto.randomUUID() } }));
    expect(await res.json()).toMatchObject({ mode: "demo", reason: "paused", liveAvailable: false });
  });

  it("/api/health is not rate-limited and reports version from deploy env", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc123";
    const { GET } = await import("../app/api/health/route");
    for (let i = 0; i < 35; i++) {
      const res = await GET();
      expect(res.status).toBe(200);
    }
    expect(await (await GET()).json()).toMatchObject({ ok: true, mode: "live", version: "abc123" });
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  it("/api/runs/:id/step increments visitor spend by the turn delta", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn(async () => claudeMessage()) };
      },
    }));
    const { createRunState, saveState } = await import("../src/agent/state");
    const { POST } = await import("../app/api/runs/[id]/step/route");
    const state = createRunState({ id: crypto.randomUUID(), workspaceId: "step-spend", plan: plan() as never });
    await saveState(state);
    const res = await POST(new Request("http://x/api/runs/id/step", { method: "POST", headers: { "x-forwarded-for": crypto.randomUUID(), "x-workspace-id": "step-spend" } }), { params: { id: state.id } });
    expect(res.status).toBe(200);
    const { loadQuota } = await import("../src/agent/quota");
    expect((await loadQuota("step-spend")).spentDollars).toBeGreaterThan(0);
  });

  it("/api/runs/:id/step stops with visitor_allowance before further live turns when dollars are exhausted", async () => {
    process.env.VISITOR_MAX_DOLLARS = "0.01";
    const { createRunState, loadState, saveState } = await import("../src/agent/state");
    const { addVisitorSpend } = await import("../src/agent/quota");
    const { POST } = await import("../app/api/runs/[id]/step/route");
    const state = createRunState({ id: crypto.randomUUID(), workspaceId: "spent-out", plan: plan() as never });
    await saveState(state);
    await addVisitorSpend("spent-out", 0.01);
    const res = await POST(new Request("http://x/api/runs/id/step", { method: "POST", headers: { "x-forwarded-for": crypto.randomUUID(), "x-workspace-id": "spent-out" } }), { params: { id: state.id } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "stopped", handback: { shortfall: "0 of 10" } });
    expect(await loadState(state.id)).toMatchObject({ status: "stopped", stopReason: "visitor_allowance" });
  });

  it("planner routes return 402 for exhausted visitor dollars and 503 for daily cap", async () => {
    process.env.VISITOR_MAX_DOLLARS = "0.10";
    const { addVisitorSpend } = await import("../src/agent/quota");
    await addVisitorSpend("planner-spent", 0.10);
    const { POST } = await import("../app/api/planner/profile/route");
    const exhausted = await POST(jsonRequest("http://x/api/planner/profile", { workspaceId: "planner-spent", input: "https://example.com" }));
    expect(exhausted.status).toBe(402);
    expect(await exhausted.json()).toEqual({ error: "allowance_exhausted", remainingRuns: 2, remainingDollars: 0 });

    await fresh("api-controls-cap-");
    process.env.DAILY_SPEND_CAP_DOLLARS = "0.01";
    const { addDailySpend } = await import("../app/api/_shared");
    await addDailySpend(0.02);
    const capped = await (await import("../app/api/planner/profile/route")).POST(jsonRequest("http://x/api/planner/profile", { workspaceId: "planner-cap", input: "https://example.com" }));
    expect(capped.status).toBe(503);
    expect(await capped.json()).toEqual({ error: "daily_budget_reached" });
  });

  it("live planner routes require and charge a visitor workspace", async () => {
    vi.doMock("../src/planner", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/planner")>()),
      suggestCards: vi.fn(async () => ({ cards: { ok: true }, cost: 0.42 })),
    }));
    const { POST } = await import("../app/api/planner/cards/route");
    const missing = await POST(jsonRequest("http://x/api/planner/cards", { profile: { offering: "x" } }));
    expect(missing.status).toBe(400);
    const charged = await POST(jsonRequest("http://x/api/planner/cards", { workspaceId: "planner-charged", profile: { offering: "x" } }));
    expect(charged.status).toBe(200);
    const { loadQuota } = await import("../src/agent/quota");
    expect((await loadQuota("planner-charged")).spentDollars).toBe(0.42);
  });

  it("resolveDataDirs honors DATA_DIR while explicit dirs still win", async () => {
    const { resolveDataDirs } = await import("../src/agent/config");
    expect(resolveDataDirs({})).toEqual({ data: ".", runs: "./runs", workspaces: "./workspaces" });
    expect(resolveDataDirs({ DATA_DIR: "/data" })).toEqual({ data: "/data", runs: "/data/runs", workspaces: "/data/workspaces" });
    expect(resolveDataDirs({ DATA_DIR: "/data", RUNS_DIR: "/runs", WORKSPACES_DIR: "/work" })).toEqual({ data: "/data", runs: "/runs", workspaces: "/work" });
  });

  it("quota and daily ledgers live under DATA_DIR", async () => {
    const { addDailySpend } = await import("../app/api/_shared");
    const { recordLiveRun } = await import("../src/agent/quota");
    await addDailySpend(0.5);
    await recordLiveRun("ledger-visitor");
    const today = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(await readFile(join(process.env.DATA_DIR!, `spend-${today}.json`), "utf8"))).toEqual({ total: 0.5 });
    expect(JSON.parse(await readFile(join(process.env.DATA_DIR!, "workspaces", "ledger-visitor", "quota.json"), "utf8"))).toMatchObject({ liveRuns: 1 });
  });
});
