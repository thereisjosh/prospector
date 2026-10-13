import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "../../src/agent/config";
import { appendEvents, makeEvent } from "../../src/agent/events";
import { isRunId, isWorkspaceId } from "../../src/agent/ids";
import { loadState, type RunState } from "../../src/agent/state";
import { withFileLock, writeFileAtomic } from "../../src/agent/fslock";
import { dollarsExhausted, loadQuota, remainingAllowance, type VisitorQuota } from "../../src/agent/quota";

const buckets = new Map<string, { tokens: number; updated: number }>();
const CAPACITY = 30;
const REFILL_PER_MS = CAPACITY / 60_000;
const BODY_LIMIT = 64 * 1024;

export function firstIp(request: Request): string {
  return (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown").slice(0, 80);
}

export function rateLimit(request: Request): Response | undefined {
  const key = firstIp(request);
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: CAPACITY, updated: now };
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + (now - bucket.updated) * REFILL_PER_MS);
  bucket.updated = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return undefined;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) throw new RequestValidationError("Request too large.");
  return text ? JSON.parse(text) : {};
}

export class RequestValidationError extends Error {
  constructor(message = "Invalid request.") {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function validateSmallShape(value: unknown): void {
  const seen = new Set<unknown>();
  const visit = (v: unknown) => {
    if (typeof v === "string" && v.length > 2000) throw new RequestValidationError();
    if (Array.isArray(v)) {
      if (v.length > 50) throw new RequestValidationError();
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
}

function ledgerPath(date = new Date()): string {
  return join(DATA_DIR, `spend-${date.toISOString().slice(0, 10)}.json`);
}

export async function readDailySpend(): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(ledgerPath(), "utf8")) as { total?: unknown };
    return typeof raw.total === "number" ? raw.total : 0;
  } catch {
    return 0;
  }
}

export async function dailyBudgetReached(): Promise<boolean> {
  const cap = dailySpendCapDollars();
  if (cap <= 0) return false;
  return await readDailySpend() >= cap;
}

export async function addDailySpend(delta: number): Promise<void> {
  if (delta <= 0) return;
  // Read-modify-write under a lock so concurrent steps cannot lose an update.
  await withFileLock(join(DATA_DIR, ".spend.lock"), async () => {
    const total = await readDailySpend() + delta;
    await writeFileAtomic(ledgerPath(), JSON.stringify({ total }, null, 2));
  });
}

export function dailySpendCapDollars(): number {
  const cap = Number(process.env.DAILY_SPEND_CAP_DOLLARS ?? 10);
  return Number.isFinite(cap) ? Math.max(0, cap) : 10;
}

export function livePaused(): boolean {
  return process.env.LIVE_MODE === "off" || dailySpendCapDollars() === 0;
}

export function liveKeysPresent(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.EXA_API_KEY);
}

export async function liveAvailable(): Promise<boolean> {
  return liveKeysPresent() && !livePaused() && !(await dailyBudgetReached());
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function workspaceIdFrom(value: unknown): string | undefined {
  return typeof value === "string" && isWorkspaceId(value) ? value : undefined;
}

export function workspaceIdFromRequest(request: Request, body?: Record<string, unknown>): string | undefined {
  const url = new URL(request.url);
  return workspaceIdFrom(body?.workspaceId) ?? workspaceIdFrom(request.headers.get("x-workspace-id")) ?? workspaceIdFrom(url.searchParams.get("workspaceId"));
}

/**
 * Planner-route gate: DOLLARS only. Planner calls never take a run slot, so a visitor with
 * 0 runs left but dollars remaining must still get through; only `POST /api/runs` gates on runs.
 */
export async function allowanceResponse(workspaceId: string): Promise<Response | undefined> {
  const quota = await loadQuota(workspaceId);
  if (!dollarsExhausted(quota)) return undefined;
  return allowanceDeniedResponse(quota);
}

/** The 402 for an exhausted allowance (used after an atomic reserveLiveRun is refused). */
export function allowanceDeniedResponse(quota: VisitorQuota): Response {
  const remaining = remainingAllowance(quota);
  return NextResponse.json(
    { error: "allowance_exhausted", remainingRuns: remaining.remainingRuns, remainingDollars: roundCents(remaining.remainingDollars) },
    { status: 402 },
  );
}

export function missingWorkspaceResponse(): Response {
  return NextResponse.json({ error: "Invalid request." }, { status: 400 });
}

export function dailyBudgetResponse(): Response {
  return NextResponse.json({ error: "daily_budget_reached" }, { status: 503 });
}

export function clampTargetLeads(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(50, n));
}

export type RoutePolicyCheck = "rate_limit" | "daily_cap" | "visitor_allowance";

/** A route-level `policy` event for the run's trace (SPEC-observability §2). */
export function routePolicyEvent(state: RunState, check: RoutePolicyCheck, outcome: "blocked" | "stop") {
  return makeEvent(state, "policy", { scope: "route", check, outcome, reason: check });
}

const routePolicyLogged = new Map<string, number>();
const ROUTE_POLICY_THROTTLE_MS = 60_000;

/**
 * Record that a route check blocked a request for this run. At most one line per
 * (run, check) per minute, so a flood of refused requests cannot grow the log.
 * Never throws: a refused request must stay refused, not become a 500.
 */
export async function recordRoutePolicy(runId: string, check: RoutePolicyCheck): Promise<void> {
  try {
    if (!isRunId(runId) || runId.startsWith("demo-")) return;
    const key = `${runId}|${check}`;
    const now = Date.now();
    if (now - (routePolicyLogged.get(key) ?? 0) < ROUTE_POLICY_THROTTLE_MS) return;
    routePolicyLogged.set(key, now);
    if (routePolicyLogged.size > 10_000) routePolicyLogged.clear();
    const state = await loadState(runId);
    await appendEvents(runId, [routePolicyEvent(state, check, "blocked")]);
  } catch {
    /* no state yet, or disk trouble: the refusal itself still stands */
  }
}
