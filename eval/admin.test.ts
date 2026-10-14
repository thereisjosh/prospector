import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const ADMIN_TOKEN = "a".repeat(32);

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { "x-forwarded-for": crypto.randomUUID(), ...(init.headers ?? {}) } });
}

async function fresh(): Promise<string> {
  vi.resetModules();
  vi.clearAllMocks();
  const root = mkdtempSync(join(tmpdir(), "prospector-admin-"));
  roots.push(root);
  process.env.DATA_DIR = root;
  delete process.env.RUNS_DIR;
  delete process.env.WORKSPACES_DIR;
  delete process.env.ADMIN_TOKEN;
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

async function seedRun(root: string, id: string, state: Record<string, unknown>, events: unknown[], mtime: Date): Promise<void> {
  const dir = join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  await writeFile(join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\nnot-json\n\n", "utf8");
  await import("node:fs/promises").then(({ utimes }) => Promise.all([utimes(join(dir, "state.json"), mtime, mtime), utimes(join(dir, "events.jsonl"), mtime, mtime)]));
}

describe("admin pause route", () => {
  it("returns 503 when ADMIN_TOKEN is unset and 401 for missing or wrong bearer tokens", async () => {
    const { POST } = await import("../app/api/admin/pause/route");
    const disabled = await POST(req("http://x/api/admin/pause", { method: "POST" }));
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "admin_disabled" });

    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    const missing = await POST(req("http://x/api/admin/pause", { method: "POST" }));
    expect(missing.status).toBe(401);
    const wrong = await POST(req("http://x/api/admin/pause", { method: "POST", headers: { authorization: "Bearer wrong" } }));
    expect(wrong.status).toBe(401);
  });

  it("writes DATA_DIR/paused and makes demo/status report paused", async () => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    const { POST } = await import("../app/api/admin/pause/route");
    const res = await POST(
      req("http://x/api/admin/pause", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "test pause" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paused: true, reason: "test pause" });
    const pausedPath = join(process.env.DATA_DIR!, "paused");
    expect(existsSync(pausedPath)).toBe(true);
    expect(JSON.parse(await readFile(pausedPath, "utf8"))).toMatchObject({ reason: "test pause" });

    const { isDemoMode } = await import("../src/demo/mode");
    expect(isDemoMode()).toBe(true);
    const { GET } = await import("../app/api/status/route");
    const status = await GET(req("http://x/api/status?workspaceId=admin-test"));
    expect(await status.json()).toMatchObject({ mode: "demo", reason: "paused", liveAvailable: false });

    // In-flight live runs stop spending too: the step route refuses with 503 and logs a policy event.
    const runId = "00000000-0000-4000-8000-0000000000aa";
    const { createRunState, saveState } = await import("../src/agent/state");
    const { getV1Plan } = await import("./fixtures/v1-plans");
    await saveState(createRunState({ id: runId, workspaceId: "admin-test-ws", plan: getV1Plan(1) }));
    const { POST: stepPOST } = await import("../app/api/runs/[id]/step/route");
    const stepRes = await stepPOST(req(`http://x/api/runs/${runId}/step`, { method: "POST" }), { params: { id: runId } });
    expect(stepRes.status).toBe(503);
    expect(await stepRes.json()).toEqual({ error: "paused" });
    const events = (await readFile(join(process.env.DATA_DIR!, "runs", runId, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toEqual([expect.objectContaining({ kind: "policy", scope: "route", check: "paused", outcome: "blocked" })]);
  });
});

describe("admin runs export route", () => {
  it("authenticates, validates since, filters runs, strips private state and parses events", async () => {
    const root = process.env.DATA_DIR!;
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    const now = new Date("2026-10-14T12:00:00.000Z");
    const recentId = "00000000-0000-4000-8000-000000000001";
    const oldId = "00000000-0000-4000-8000-000000000002";
    const demoId = "demo-00000000-0000-4000-8000-000000000003";
    await seedRun(
      root,
      recentId,
      {
        id: recentId,
        createdAt: "2026-10-14T11:00:00.000Z",
        workspaceId: "secret-workspace",
        model: "claude-opus-5-5",
        contract: { targetLeads: 1, maxCostDollars: 1 },
        status: "done",
        spend: { exa: 0, claude: 0, total: 0 },
        counters: { turns: 1, activeMs: 0, noProgressTurns: 0, toolCalls: 0 },
        leads: [],
        rejected: [],
        todo: "",
        version: 1,
        messages: [{ role: "user", content: "hidden" }],
        caches: { hidden: true },
        pendingApproval: { hidden: true },
        prompt: { text: "hidden" },
      },
      [{ ts: now.toISOString(), kind: "stop", runId: recentId, turn: 1, promptVersion: "test" }],
      now,
    );
    await seedRun(root, oldId, { id: oldId, status: "done" }, [], new Date("2026-10-10T00:00:00.000Z"));
    await seedRun(root, demoId, { id: demoId, status: "done" }, [], now);

    const { GET } = await import("../app/api/admin/runs/export/route");
    const unauth = await GET(req("http://x/api/admin/runs/export?since=2026-10-14T00:00:00.000Z"));
    expect(unauth.status).toBe(401);
    const bad = await GET(req("http://x/api/admin/runs/export?since=nope", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
    expect(bad.status).toBe(400);

    const res = await GET(req("http://x/api/admin/runs/export?since=2026-10-14T00:00:00.000Z&limit=5000", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(recentId);
    expect(body.runs[0].events).toHaveLength(1);
    expect(body.runs[0].state).toMatchObject({ id: recentId, status: "done" });
    expect(body.runs[0].state).not.toHaveProperty("messages");
    expect(body.runs[0].state).not.toHaveProperty("caches");
    expect(body.runs[0].state).not.toHaveProperty("workspaceId");
  });
});
