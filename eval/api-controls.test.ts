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
    const res = await POST(new Request("http://x/api/runs/id/step", { method: "POST", headers: { "x-forwarded-for": crypto.randomUUID() } }), { params: { id: state.id } });
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
    const res = await POST(new Request("http://x/api/runs/id/step", { method: "POST", headers: { "x-forwarded-for": crypto.randomUUID() } }), { params: { id: state.id } });
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
