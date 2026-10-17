import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

const plan = () => ({
  label: "Allowance",
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

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

// A turn that keeps the run going (free update_todo tool call) and costs real tokens.
function todoTurn() {
  return {
    id: crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "tool_use", id: `tu_${crypto.randomUUID()}`, name: "update_todo", input: { markdown: "Looking for leads." } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 13300, output_tokens: 1330 },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = mkdtempSync(join(tmpdir(), "allowance-"));
  roots.push(root);
  process.env.DATA_DIR = root;
  delete process.env.RUNS_DIR;
  delete process.env.WORKSPACES_DIR;
  delete process.env.DEMO_MODE;
  delete process.env.NEXT_PUBLIC_DEMO;
  delete process.env.LIVE_MODE;
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  process.env.EXA_API_KEY = "exa-test";
  process.env.DAILY_SPEND_CAP_DOLLARS = "100";
  process.env.VISITOR_MAX_LIVE_RUNS = "2";
  process.env.VISITOR_MAX_DOLLARS = "0.30";
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      messages = { create: vi.fn(async () => todoTurn()) };
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("visitor allowance on the LAST permitted run", () => {
  it("second of two runs keeps stepping while dollars remain, stops with visitor_allowance only once spent >= limit, and a third run is refused with 402", async () => {
    const workspaceId = "last-run-ws";
    const { POST: create } = await import("../app/api/runs/route");
    const { POST: stepRoute } = await import("../app/api/runs/[id]/step/route");
    const { loadQuota, visitorDollarLimit } = await import("../src/agent/quota");
    const { loadState } = await import("../src/agent/state");

    const first = await create(jsonRequest("http://x/api/runs", { workspaceId, plan: plan(), model: "claude-opus-5-5" }));
    expect(first.status).toBe(200);
    const second = await create(jsonRequest("http://x/api/runs", { workspaceId, plan: plan(), model: "claude-opus-5-5" }));
    expect(second.status).toBe(200);
    const { id } = (await second.json()) as { id: string };
    expect((await loadQuota(workspaceId)).liveRuns).toBe(2); // slot consumed: liveRuns === limit

    let continued = 0;
    let stopped = false;
    for (let i = 0; i < 60 && !stopped; i++) {
      const res = await stepRoute(new Request("http://x/api/runs/id/step", { method: "POST", headers: { "x-forwarded-for": crypto.randomUUID(), "x-workspace-id": workspaceId } }), { params: { id } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      const quota = await loadQuota(workspaceId);
      if (body.status === "running") {
        expect(quota.spentDollars).toBeLessThan(visitorDollarLimit());
        continued += 1;
      } else {
        stopped = true;
        expect(quota.spentDollars).toBeGreaterThanOrEqual(visitorDollarLimit());
      }
    }
    expect(continued).toBeGreaterThanOrEqual(3);
    expect(stopped).toBe(true);
    const final = await loadState(id);
    expect(final).toMatchObject({ status: "stopped", stopReason: "visitor_allowance" });
    expect(final.handback?.top_reasons).toEqual([{ code: "visitor_allowance", count: 1 }]);
    expect(final.handback?.shortfall).toMatch(/^0 of /);

    const third = await create(jsonRequest("http://x/api/runs", { workspaceId, plan: plan(), model: "claude-opus-5-5" }));
    expect(third.status).toBe(402);
  });

  it("a visitor with 0 runs left but dollars remaining can call all three planner routes (200) and gets 402 only at run creation", async () => {
    process.env.VISITOR_MAX_DOLLARS = "5";
    vi.doMock("../src/planner", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/planner")>()),
      profileFromText: vi.fn(async () => ({ profile: { offering: "x" }, cost: 0.01 })),
      suggestCards: vi.fn(async () => ({ cards: { ok: true }, cost: 0.01 })),
      compilePlan: vi.fn(async () => ({ plan: plan(), estimatedRunCost: 0.5, cost: 0.01 })),
    }));
    const workspaceId = "zero-runs-ws";
    const { recordLiveRun, loadQuota, remainingAllowance } = await import("../src/agent/quota");
    await recordLiveRun(workspaceId);
    await recordLiveRun(workspaceId);
    const left = remainingAllowance(await loadQuota(workspaceId));
    expect(left.remainingRuns).toBe(0);
    expect(left.remainingDollars).toBeGreaterThan(0);

    const { POST: profile } = await import("../app/api/planner/profile/route");
    const { POST: cardsRoute } = await import("../app/api/planner/cards/route");
    const { POST: planRoute } = await import("../app/api/planner/plan/route");
    expect((await profile(jsonRequest("http://x/api/planner/profile", { workspaceId, input: "we sell scheduling software to warehouses" }))).status).toBe(200);
    expect((await cardsRoute(jsonRequest("http://x/api/planner/cards", { workspaceId, profile: { offering: "x" } }))).status).toBe(200);
    const cards = JSON.parse((await import("node:fs")).readFileSync(join(import.meta.dirname, "demo", "planner", "cards.json"), "utf8")).cards;
    expect((await planRoute(jsonRequest("http://x/api/planner/plan", { workspaceId, cards }))).status).toBe(200);

    const { POST: runs } = await import("../app/api/runs/route");
    expect((await runs(jsonRequest("http://x/api/runs", { workspaceId, plan: plan(), model: "claude-opus-5-5" }))).status).toBe(402);
  });
});
