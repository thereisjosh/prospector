import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "./config";
import { normalizeNullish } from "./plan";
import type { CompanySummary, ExaSearchResponse } from "./types";
import { EXCERPT_MAX } from "./evidence";

export type ExaCredentials = {
  apiKey?: string;
  baseUrl?: string;
};

/** Thrown (message `replay miss: <hash>`) when EXA_REPLAY_DIR has no recording for a request. */
export class ReplayMissError extends Error {
  hash: string;
  body: Record<string, unknown>;
  constructor(hash: string, body: Record<string, unknown>) {
    super(`replay miss: ${hash}`);
    this.name = "ReplayMissError";
    this.hash = hash;
    this.body = body;
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

// Worst-case estimates from observed costDollars (2026-10-11): neural search is
// $0.007 up to 25 results and $0.044 at 50; summaries $0.001/result; company
// lookup ~$0.009. A 25% margin covers tiers we haven't observed.
export const COST_ESTIMATE = {
  searchUpTo25: 0.007,
  searchAt50: 0.044,
  perSummaryResult: 0.001,
  companyLookup: 0.009,
  margin: 1.25,
} as const;

/**
 * Company-lookup page text window. Exa bills `contents.text` per page (the
 * estimate below uses `perSummaryResult` per page, never per character) and
 * `maxCharacters` only truncates what is returned, so a wide window costs the
 * same as a narrow one. It must cover what Exa's summariser read, otherwise a
 * genuine quote from deep in the page looks fabricated to the gate.
 */
export const LOOKUP_TEXT_MAX = 20000;

export function estimateExaCost(body: Record<string, unknown>): number {
  const e = COST_ESTIMATE;
  const contents = body.contents as { summary?: unknown; text?: unknown } | undefined;
  if (body.category === "company") {
    const pages = typeof body.numResults === "number" ? body.numResults : 2;
    return (e.companyLookup + (contents?.text ? e.perSummaryResult * pages : 0)) * e.margin;
  }
  const n = typeof body.numResults === "number" ? body.numResults : 10;
  const search = n <= 25 ? e.searchUpTo25 : e.searchAt50 * Math.max(1, n / 50);
  return (search + (contents?.summary ? e.perSummaryResult * n : 0) + (contents?.text ? e.perSummaryResult * n : 0)) * e.margin;
}

/**
 * Per-run spend cap. `reserve` is called synchronously before each request and
 * refuses it if actual spend + in-flight worst-case estimates + this call's
 * estimate would exceed the cap. `settle` replaces the estimate with actual cost.
 */
export class CostGuard {
  spent = 0;
  inflight = 0;
  breached = false;
  constructor(public readonly capDollars: number) {}

  reserve(estimate: number): void {
    if (this.spent + this.inflight + estimate > this.capDollars + 1e-9) {
      throw new BudgetExceededError(
        `budget cap $${this.capDollars.toFixed(3)} would be exceeded (spent $${this.spent.toFixed(3)}, in flight $${this.inflight.toFixed(3)}, next call est. $${estimate.toFixed(3)})`,
      );
    }
    this.inflight += estimate;
  }

  settle(estimate: number, actual: number | undefined): void {
    this.inflight = Math.max(0, this.inflight - estimate);
    this.spent += actual ?? estimate;
    if (this.spent > this.capDollars + 1e-9) this.breached = true;
  }

  get remaining(): number {
    return this.capDollars - this.spent - this.inflight;
  }
}

function responseCost(json: unknown): number | undefined {
  const cost = (json as { costDollars?: { total?: unknown } } | undefined)?.costDollars;
  return typeof cost?.total === "number" ? cost.total : undefined;
}

export class ExaHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Exa search failed HTTP ${status}: ${body}`);
    this.name = "ExaHttpError";
    this.status = status;
    this.body = body;
  }
}

/** JSON.stringify with object keys sorted recursively, so equal requests serialise identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

export async function exaSearch(
  body: Record<string, unknown>,
  credentials: ExaCredentials = {},
  guard?: CostGuard,
) {
  return exaPost("/search", body, credentials, guard) as Promise<ExaSearchResponse>;
}

export async function exaPost(
  path: string,
  body: Record<string, unknown>,
  credentials: ExaCredentials = {},
  guard?: CostGuard,
): Promise<ExaSearchResponse> {
  const estimate = estimateExaCost(body);
  guard?.reserve(estimate);
  try {
    const json = await exaPostUnguarded(path, body, credentials);
    guard?.settle(estimate, responseCost(json));
    return json;
  } catch (error) {
    guard?.settle(estimate, 0);
    throw error;
  }
}

async function exaPostUnguarded(
  path: string,
  body: Record<string, unknown>,
  credentials: ExaCredentials,
) {
  const replayDir = process.env.EXA_REPLAY_DIR;
  const recordDir = process.env.EXA_RECORD_DIR;
  const hashBody = path === "/search" ? body : { path, ...body };
  const hash = replayDir || recordDir ? requestHash(hashBody) : "";

  // Replay never falls through to the network.
  if (replayDir) {
    let raw: string;
    try {
      raw = readFileSync(join(replayDir, `${hash}.json`), "utf8");
    } catch {
      throw new ReplayMissError(hash, body);
    }
    return (JSON.parse(raw) as { response: ExaSearchResponse }).response;
  }

  const baseUrl = (credentials.baseUrl ?? process.env.EXA_BASE_URL ?? "https://api.exa.ai").replace(/\/$/, "");
  const apiKey = credentials.apiKey ?? requireEnv("EXA_API_KEY");
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  };
  const endpoint = path.startsWith("/") ? path : `/${path}`;
  const { status, text } = await fetchWithRetry(`${baseUrl}${endpoint}`, request);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Exa returned non-JSON HTTP ${status}: ${text}`);
  }

  if (status < 200 || status >= 300) {
    throw new ExaHttpError(status, text);
  }

  if (recordDir) {
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, `${hash}.json`),
      JSON.stringify({ request: body, response: json }, null, 2),
    );
  }

  return json as ExaSearchResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Concurrency limit + retry. Exa rate-limits at ~10 requests/second; a process-
// wide semaphore keeps bursts (25 parallel company lookups) under it, and
// 429/5xx responses back off exponentially with full jitter.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 10_000;

function maxConcurrency(): number {
  const n = Number(process.env.EXA_MAX_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < maxConcurrency()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next(); // the slot passes directly to the next waiter
  else active -= 1;
}

/** `retry-after`: seconds (up to 60) or milliseconds ("1500", "250ms"); capped at 10 s. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const m = header.trim().match(/^(\d+(?:\.\d+)?)\s*(ms)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const ms = m[2] ? n : n <= 60 ? n * 1000 : n;
  return Math.min(MAX_WAIT_MS, Math.max(0, ms));
}

function backoffMs(attempt: number): number {
  const base = Number(process.env.EXA_RETRY_BASE_MS) || 500;
  return Math.random() * Math.min(MAX_WAIT_MS, base * 2 ** attempt);
}

async function fetchWithRetry(url: string, request: RequestInit): Promise<{ status: number; text: string }> {
  let last = { status: 0, text: "" };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let retryAfter: number | undefined;
    await acquireSlot();
    try {
      const response = await fetch(url, request);
      last = { status: response.status, text: await response.text() };
      retryAfter = retryAfterMs(response.headers?.get?.("retry-after"));
    } finally {
      releaseSlot();
    }
    const retriable = last.status === 429 || last.status >= 500;
    if (!retriable || attempt === MAX_ATTEMPTS - 1) break;
    await sleep(retryAfter ?? backoffMs(attempt));
  }
  return last;
}

export async function lookupCompany(
  companyName: string,
  summaryQuery: string,
  schema: object,
  credentials: ExaCredentials = {},
  guard?: CostGuard,
) {
  const response = await exaSearch({
    query: companyName,
    category: "company",
    numResults: 2,
    contents: {
      summary: {
        query: summaryQuery,
        schema,
      },
      text: { maxCharacters: LOOKUP_TEXT_MAX },
      livecrawl: "fallback",
    },
  }, credentials, guard);
  const result = response.results[0];
  const summary = parseCompanySummary(result?.summary);
  if (result?.text) {
    summary.source_excerpt = result.text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX);
    // Text at the window limit was cut off: a quote missing from it is unverified, not necessarily fabricated.
    summary.lookup_text_truncated = result.text.length >= LOOKUP_TEXT_MAX;
  }

  return {
    result,
    summary,
    costDollars: response.costDollars,
  };
}

export function parseCompanySummary(summary: unknown): CompanySummary {
  if (typeof summary === "object" && summary && !Array.isArray(summary)) {
    return cleanCompanySummary(summary as Record<string, unknown>);
  }
  if (typeof summary === "string") {
    try {
      const parsed = JSON.parse(summary) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return cleanCompanySummary(parsed as Record<string, unknown>);
      }
    } catch {
      const description = normalizeNullish(summary);
      return description ? { description } : {};
    }
  }
  return {};
}

/** Exa can return the literal string "null" or padded strings for fields. */
function cleanCompanySummary(raw: Record<string, unknown>): CompanySummary {
  const out: CompanySummary = {};
  for (const [key, value] of Object.entries(raw)) {
    const cleaned = normalizeNullish(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}
