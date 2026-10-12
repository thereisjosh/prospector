import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { RUNS_DIR } from "../../src/agent/config";

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
  return join(RUNS_DIR, `spend-${date.toISOString().slice(0, 10)}.json`);
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
  const cap = Number(process.env.DAILY_SPEND_CAP_DOLLARS ?? 25);
  return await readDailySpend() >= cap;
}

export async function addDailySpend(delta: number): Promise<void> {
  if (delta <= 0) return;
  await mkdir(RUNS_DIR, { recursive: true });
  const total = await readDailySpend() + delta;
  await writeFile(ledgerPath(), JSON.stringify({ total }, null, 2), "utf8");
}

export function clampTargetLeads(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(50, n));
}
