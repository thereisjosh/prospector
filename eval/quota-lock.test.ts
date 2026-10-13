import { afterAll, describe, expect, it, vi } from "vitest";

// Temp data dirs, set before the modules read them.
const dirs = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "quota-lock-"));
  process.env.DATA_DIR = root;
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.VISITOR_MAX_LIVE_RUNS = "2";
  process.env.VISITOR_MAX_DOLLARS = "2.5";
  return { root };
});

import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LockTimeoutError, withFileLock } from "../src/agent/fslock";
import { addVisitorSpend, loadQuota, releaseLiveRun, reserveLiveRun } from "../src/agent/quota";
import { addDailySpend, readDailySpend } from "../app/api/_shared";

afterAll(() => rm(dirs.root, { recursive: true, force: true }));

describe("per-workspace quota lock", () => {
  it("20 concurrent reserveLiveRun against a 2-run allowance: exactly 2 succeed", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveLiveRun("race-runs")));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(18);
    expect((await loadQuota("race-runs")).liveRuns).toBe(2);
  });

  it("release gives a reservation back", async () => {
    await reserveLiveRun("release-ws");
    await reserveLiveRun("release-ws");
    expect((await reserveLiveRun("release-ws")).ok).toBe(false);
    await releaseLiveRun("release-ws");
    expect((await reserveLiveRun("release-ws")).ok).toBe(true);
  });

  it("20 concurrent addVisitorSpend of $0.01 sum to $0.20", async () => {
    await Promise.all(Array.from({ length: 20 }, () => addVisitorSpend("race-spend", 0.01)));
    expect((await loadQuota("race-spend")).spentDollars).toBeCloseTo(0.2, 9);
  });

  it("mixed reserve + spend writers never lose an update", async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, () => addVisitorSpend("mixed", 0.01)),
      reserveLiveRun("mixed"),
      ...Array.from({ length: 10 }, () => addVisitorSpend("mixed", 0.01)),
    ]);
    const q = await loadQuota("mixed");
    expect(q.liveRuns).toBe(1);
    expect(q.spentDollars).toBeCloseTo(0.2, 9);
  });
});

describe("daily ledger lock", () => {
  it("20 concurrent addDailySpend sum correctly", async () => {
    await Promise.all(Array.from({ length: 20 }, () => addDailySpend(0.01)));
    expect(await readDailySpend()).toBeCloseTo(0.2, 9);
    const date = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(await readFile(join(dirs.root, `spend-${date}.json`), "utf8")).total).toBeCloseTo(0.2, 9);
  });
});

describe("withFileLock", () => {
  const lock = () => join(dirs.root, "locks", `${crypto.randomUUID()}.lock`);

  it("reclaims a stale lock (older than the stale timeout)", async () => {
    const path = lock();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "999999", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    await expect(withFileLock(path, async () => "ok", { staleMs: 10_000, retryMs: 500 })).resolves.toBe("ok");
  });

  it("a fresh lock held by someone else times out after the bounded retry, then works once released", async () => {
    const path = lock();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "1", "utf8");
    const started = Date.now();
    await expect(withFileLock(path, async () => "x", { retryMs: 150 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await rm(path);
    await expect(withFileLock(path, async () => "x", { retryMs: 150 })).resolves.toBe("x");
  });

  it("serialises critical sections and releases the lock when the function throws", async () => {
    const path = lock();
    let active = 0;
    let max = 0;
    await Promise.all(Array.from({ length: 10 }, () => withFileLock(path, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 3));
      active -= 1;
    })));
    expect(max).toBe(1);
    await expect(withFileLock(path, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withFileLock(path, async () => "after", { retryMs: 100 })).resolves.toBe("after");
  });
});
