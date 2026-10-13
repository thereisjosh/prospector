import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./config";
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

export async function saveQuota(workspaceId: string, quota: VisitorQuota): Promise<void> {
  const dir = join(WORKSPACES_DIR, assertWorkspaceId(workspaceId));
  await mkdir(dir, { recursive: true });
  await writeFile(quotaPath(workspaceId), JSON.stringify(quota, null, 2), "utf8");
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

export async function recordLiveRun(workspaceId: string, now = new Date()): Promise<VisitorQuota> {
  const quota = await loadQuota(workspaceId);
  const at = now.toISOString();
  quota.liveRuns += 1;
  quota.firstRunAt ??= at;
  quota.lastRunAt = at;
  await saveQuota(workspaceId, quota);
  return quota;
}

export async function addVisitorSpend(workspaceId: string, delta: number, now = new Date()): Promise<VisitorQuota> {
  const quota = await loadQuota(workspaceId);
  if (delta > 0) quota.spentDollars += delta;
  const at = now.toISOString();
  quota.firstRunAt ??= at;
  quota.lastRunAt = at;
  await saveQuota(workspaceId, quota);
  return quota;
}
