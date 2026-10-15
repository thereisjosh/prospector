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
import { spawnSync } from "node:child_process";
import { backoffMs, LockTimeoutError, withFileLock } from "../src/agent/fslock";
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
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => addVisitorSpend("race-spend", 0.01)));
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof LockTimeoutError)).toHaveLength(0);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const body = (pid: number, ts: number) => JSON.stringify({ pid, ts, token: "foreign" });
  const deadPid = () => {
    const child = spawnSync(process.execPath, ["-e", ""]);
    return child.pid as number; // exited and reaped, so signal 0 reports ESRCH
  };
  const prep = async (path: string, content: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  };

  it("backoff starts near 5 ms, doubles, caps at 100 ms, and is jittered", () => {
    expect(backoffMs(0, () => 0)).toBe(2.5);
    expect(backoffMs(0, () => 1)).toBe(5);
    expect(backoffMs(3, () => 1)).toBe(40);
    for (const attempt of [6, 10, 50]) expect(backoffMs(attempt, () => 1)).toBe(100);
    expect(backoffMs(8, () => 0)).toBe(50);
    expect(new Set(Array.from({ length: 20 }, () => backoffMs(5))).size).toBeGreaterThan(1);
  });

  it("reclaims a lock whose pid is dead and whose timestamp is older than the stale threshold", async () => {
    const path = lock();
    await prep(path, body(deadPid(), Date.now() - 60_000));
    await expect(withFileLock(path, async () => "ok", { staleMs: 30_000, deadlineMs: 500 })).resolves.toBe("ok");
  });

  it("reclaims a legacy/unreadable lock only by file age", async () => {
    const path = lock();
    await prep(path, "999999");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    await expect(withFileLock(path, async () => "ok", { staleMs: 30_000, deadlineMs: 500 })).resolves.toBe("ok");
  });

  it("does NOT reclaim an old lock whose pid is alive (a slow holder is not a dead one)", async () => {
    const path = lock();
    await prep(path, body(process.pid, Date.now() - 60_000));
    await expect(withFileLock(path, async () => "x", { staleMs: 30_000, deadlineMs: 200 })).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("does NOT reclaim a fresh lock even when its pid is dead", async () => {
    const path = lock();
    await prep(path, body(deadPid(), Date.now()));
    await expect(withFileLock(path, async () => "x", { staleMs: 30_000, deadlineMs: 200 })).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("a held lock times out after the deadline, then works once released", async () => {
    const path = lock();
    await prep(path, body(process.pid, Date.now()));
    const started = Date.now();
    await expect(withFileLock(path, async () => "x", { deadlineMs: 150 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    await rm(path);
    await expect(withFileLock(path, async () => "x", { deadlineMs: 150 })).resolves.toBe("x");
  });

  it("an in-process waiter that times out leaves the queue and does not block later callers", async () => {
    const path = lock();
    let release!: () => void;
    const holder = withFileLock(path, () => new Promise<void>((r) => (release = r)));
    await sleep(20);
    await expect(withFileLock(path, async () => "x", { deadlineMs: 80 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    await holder;
    await expect(withFileLock(path, async () => "after", { deadlineMs: 500 })).resolves.toBe("after");
  });

  it("serialises critical sections and releases the lock when the function throws", async () => {
    const path = lock();
    let active = 0;
    let max = 0;
    await Promise.all(Array.from({ length: 10 }, () => withFileLock(path, async () => {
      active += 1;
      max = Math.max(max, active);
      await sleep(3);
      active -= 1;
    })));
    expect(max).toBe(1);
    await expect(withFileLock(path, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withFileLock(path, async () => "after", { deadlineMs: 100 })).resolves.toBe("after");
  });

  it("50 writers, 50 ms critical section (2.5 s total, past the old 2 s deadline): all succeed, no timeout, strict mutual exclusion", async () => {
    const path = lock();
    let active = 0;
    let max = 0;
    let sum = 0;
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => withFileLock(path, async () => {
      active += 1;
      max = Math.max(max, active);
      const read = sum;
      await sleep(50);
      sum = read + 1;
      active -= 1;
    }, { deadlineMs: 20_000 })));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(max).toBe(1);
    expect(sum).toBe(50);
  }, 30_000);

  it("50 writers behind an external (cross-process) holder that releases after 400 ms: backoff acquires it, nothing times out", async () => {
    const path = lock();
    await prep(path, body(process.pid, Date.now()));
    setTimeout(() => void rm(path, { force: true }), 400);
    let sum = 0;
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => withFileLock(path, async () => {
      const read = sum;
      await sleep(5);
      sum = read + 1;
    }, { deadlineMs: 20_000 })));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(sum).toBe(50);
  }, 30_000);
});
