import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./config";
import { withFileLock, writeFileAtomic } from "./fslock";
import { assertWorkspaceId } from "./ids";

export type VisitorQuota = {
  liveRuns: number;
  spentDollars: number;
  firstRunAt?: string;
  lastRunAt?: string;
};

export type VisitorAllowance = {
  remainingRuns: number;
  remainingDollars: number;
};

const EMPTY: VisitorQuota = { liveRuns: 0, spentDollars: 0 };

export function visitorRunLimit(): number {
  const value = Number(process.env.VISITOR_MAX_LIVE_RUNS ?? 2);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 2;
}

export function visitorDollarLimit(): number {
  const value = Number(process.env.VISITOR_MAX_DOLLARS ?? 2.5);
  return Number.isFinite(value) ? Math.max(0, value) : 2.5;
}

function quotaPath(workspaceId: string): string {
  return join(WORKSPACES_DIR, assertWorkspaceId(workspaceId), "quota.json");
}

export async function loadQuota(workspaceId: string): Promise<VisitorQuota> {
  try {
    const raw = JSON.parse(await readFile(quotaPath(workspaceId), "utf8")) as Partial<VisitorQuota>;
    return {
      liveRuns: typeof raw.liveRuns === "number" ? raw.liveRuns : 0,
      spentDollars: typeof raw.spentDollars === "number" ? raw.spentDollars : 0,
      firstRunAt: typeof raw.firstRunAt === "string" ? raw.firstRunAt : undefined,
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Atomic write. Callers that read-modify-write must hold `withQuotaLock`. */
export async function saveQuota(workspaceId: string, quota: VisitorQuota): Promise<void> {
  await writeFileAtomic(quotaPath(workspaceId), JSON.stringify(quota, null, 2));
}

/** Serialises every quota mutation for one workspace (O_EXCL lock file, 10 s stale, ~2 s retry). */
export function withQuotaLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(join(WORKSPACES_DIR, assertWorkspaceId(workspaceId), ".quota.lock"), fn);
}

export function remainingAllowance(quota: VisitorQuota): VisitorAllowance {
  return {
    remainingRuns: Math.max(0, visitorRunLimit() - quota.liveRuns),
    remainingDollars: Math.max(0, visitorDollarLimit() - quota.spentDollars),
  };
}

export function allowanceExhausted(quota: VisitorQuota): boolean {
  return quota.liveRuns >= visitorRunLimit() || quota.spentDollars >= visitorDollarLimit();
}

export async function readVisitorAllowance(workspaceId: string): Promise<VisitorAllowance> {
  return remainingAllowance(await loadQuota(workspaceId));
}

export type LiveRunReservation =
  | { ok: true; quota: VisitorQuota }
  | { ok: false; quota: VisitorQuota };

/**
 * Check the allowance and take a live run in one step, inside the lock, so two concurrent
 * requests cannot both pass the check. `ok: false` means the allowance is exhausted and
 * nothing was reserved.
 */
export async function reserveLiveRun(workspaceId: string, now = new Date()): Promise<LiveRunReservation> {
  return withQuotaLock(workspaceId, async () => {
    const quota = await loadQuota(workspaceId);
    if (allowanceExhausted(quota)) return { ok: false, quota };
    const at = now.toISOString();
    quota.liveRuns += 1;
    quota.firstRunAt ??= at;
    quota.lastRunAt = at;
    await saveQuota(workspaceId, quota);
    return { ok: true, quota };
  });
}

/** Give back a reserved run (the run could not be created after all). */
export async function releaseLiveRun(workspaceId: string): Promise<VisitorQuota> {
  return withQuotaLock(workspaceId, async () => {
    const quota = await loadQuota(workspaceId);
    quota.liveRuns = Math.max(0, quota.liveRuns - 1);
    await saveQuota(workspaceId, quota);
    return quota;
  });
}

/** Unconditional increment (kept for callers that already decided). Prefer reserveLiveRun. */
export async function recordLiveRun(workspaceId: string, now = new Date()): Promise<VisitorQuota> {
  return withQuotaLock(workspaceId, async () => {
    const quota = await loadQuota(workspaceId);
    const at = now.toISOString();
    quota.liveRuns += 1;
    quota.firstRunAt ??= at;
    quota.lastRunAt = at;
    await saveQuota(workspaceId, quota);
    return quota;
  });
}

export async function addVisitorSpend(workspaceId: string, delta: number, now = new Date()): Promise<VisitorQuota> {
  return withQuotaLock(workspaceId, async () => {
    const quota = await loadQuota(workspaceId);
    if (delta > 0) quota.spentDollars += delta;
    const at = now.toISOString();
    quota.firstRunAt ??= at;
    quota.lastRunAt = at;
    await saveQuota(workspaceId, quota);
    return quota;
  });
}
