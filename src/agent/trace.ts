/**
 * Langfuse trace layer (SPEC-observability §2–§3).
 *
 * The ONLY module that imports the Langfuse SDK (JS/TS SDK v5: @langfuse/tracing,
 * @langfuse/otel, @langfuse/client on an isolated OpenTelemetry provider). The SDK
 * is loaded lazily, so with LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset nothing
 * here runs and the agent behaves exactly as without tracing.
 *
 * Model: session = run, trace = one turn keyed by (runId, turn), one observation per
 * event (generation per model call, tool per tool call, guardrail per policy check,
 * span per approval, events for stop/error/feedback), root = the `turn_end` event.
 * `toObservations(events)` is the single, pure mapping; the live path (`emit`, called
 * from `appendEvents`) and the backfill (`backfill`) both use it.
 *
 * Ids are deterministic: trace id = sha256(`${environment}:${runId}:${turn}`)[0:32] (the
 * SDK's `createTraceId` scheme), observation ids = sha256(traceId + event key)[0:16], score
 * ids = sha256 of their target. Langfuse v4 treats observations as immutable and does
 * NOT deduplicate re-ingested ids, so every observation is exported exactly once: live,
 * each event is appended (and emitted) once; the backfill first lists the ids already in
 * Langfuse and exports only the missing ones.
 */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_PRICES_PER_MILLION, RUNS_DIR, isAgentModel } from "./config";
import type { AgentEvent } from "./events";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Tracing is on only when both Langfuse keys are set. */
export function enabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

export const AGENT_TRACE_NAME = "agent-turn";

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Langfuse environment of this process (the SDK's default when unset). */
export function tracingEnvironment(env: Record<string, string | undefined> = process.env): string {
  return env.LANGFUSE_TRACING_ENVIRONMENT || "default";
}

/**
 * Same as the SDK's `createTraceId(seed)` with seed `${environment}:${runId}:${turn}`:
 * first 32 hex chars of sha256(seed). The environment is part of the id so an `eval`
 * backfill and the `production` live trace of the same turn never share ids (and the
 * backfill's existing-id check cannot confuse them).
 */
export function traceIdFor(runId: string, turn: number, environment = tracingEnvironment()): string {
  return sha256Hex(`${environment}:${runId}:${turn}`).slice(0, 32);
}

/** W3C span id (16 hex) for an observation key inside a trace. Never all zeros. */
export function observationIdFor(traceId: string, key: string): string {
  const id = sha256Hex(`${traceId}|${key}`).slice(0, 16);
  return id === "0000000000000000" ? "0000000000000001" : id;
}

export function rootObservationId(runId: string, turn: number, environment = tracingEnvironment()): string {
  return observationIdFor(traceIdFor(runId, turn, environment), "root");
}

/** Key of a tool span: the Anthropic tool_use id when the event carries it. */
export function toolObservationKey(toolUseId: string): string {
  return `tool:${toolUseId}`;
}

function scoreIdFor(...parts: string[]): string {
  return sha256Hex(`score|${parts.join("|")}`).slice(0, 32);
}

/** HMAC-SHA256(TRACE_HMAC_SECRET, workspaceId), 32 hex. Undefined without a secret. */
export function hashWorkspaceId(workspaceId: string, secret = process.env.TRACE_HMAC_SECRET): string | undefined {
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(workspaceId).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Masking (§3)                                                        */
/* ------------------------------------------------------------------ */

const MAX_STRING = 2000;
const SECRET_ENV_VARS = ["ANTHROPIC_API_KEY", "EXA_API_KEY", "ADMIN_TOKEN", "LANGFUSE_SECRET_KEY", "TRACE_HMAC_SECRET"];

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted:key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted:key]"],
  [/\b(?:sk|pk)-lf-[0-9a-f-]{20,}/g, "[redacted:key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted:token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted:token]"],
  [/\b(authorization|x-api-key|api[_-]?key|access[_-]?token|admin[_-]?token|token|secret|password)(["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;]{6,}/gi, "$1$2[redacted:secret]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted:key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted:key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted:key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted:email]"],
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[redacted:ip]"],
  [/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, "[redacted:ip]"],
  [/\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?(?![:\w])/g, "[redacted:ip]"],
  [/\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g, "[redacted:phone]"],
  [/(?<![\w-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[redacted:phone]"],
];

export type MaskOptions = { workspaceId?: string; env?: Record<string, string | undefined>; keepBlobs?: boolean };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const BLOB_RE = /\b(?:[0-9a-fA-F]{32,}|(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{32,}={0,2})(?![A-Za-z0-9+/])/g;

/** Generic 32+ char hex/base64 blobs are masked only outside URLs (URL slugs and ids are real signal). */
function maskBlobsOutsideUrls(value: string): string {
  let out = "";
  let last = 0;
  for (const m of value.matchAll(URL_RE)) {
    out += value.slice(last, m.index).replace(BLOB_RE, "[redacted:blob]") + m[0];
    last = m.index + m[0].length;
  }
  return out + value.slice(last).replace(BLOB_RE, "[redacted:blob]");
}

/** Mask one string: known secret values, the raw workspace id, then patterns; clip to 2,000 chars. */
export function maskString(value: string, options: MaskOptions = {}): string {
  const env = options.env ?? process.env;
  let out = value;
  for (const name of SECRET_ENV_VARS) {
    const secret = env[name];
    if (secret && secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(`[redacted:${name.toLowerCase()}]`);
  }
  const ws = options.workspaceId;
  if (ws && ws.length >= 6 && out.includes(ws)) {
    const hashed = hashWorkspaceId(ws, env.TRACE_HMAC_SECRET);
    out = out.replace(new RegExp(escapeRegExp(ws), "g"), hashed ? `ws:${hashed}` : "[redacted:workspace]");
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  if (!options.keepBlobs) out = maskBlobsOutsideUrls(out);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[clipped]` : out;
}

/**
 * Mask every string in a payload (keys included) before it leaves the process.
 * Returns a new value; the input is not modified.
 */
export function mask<T>(payload: T, options: MaskOptions = {}): T {
  const seen = new WeakMap<object, unknown>();
  // Our own digests and ids (prompt/page hashes, HMAC'd userId, trace ids) are policy-mandated hex, not secrets.
  const DIGEST_KEY = /hash|sha256|digest|^(?:trace|session|user|run)?_?id$/i;
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return maskString(value, key && DIGEST_KEY.test(key) ? { ...options, keepBlobs: true } : options);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      seen.set(value, arr);
      for (const item of value) arr.push(walk(item, key));
      return arr;
    }
    const obj: Record<string, unknown> = {};
    seen.set(value, obj);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) obj[maskString(key, options)] = walk(item, key);
    return obj;
  };
  return walk(payload) as T;
}

/* ------------------------------------------------------------------ */
/* Events → observations (pure)                                        */
/* ------------------------------------------------------------------ */

export type ObservationType = "agent" | "generation" | "tool" | "guardrail" | "span" | "event";

export type TraceObservation = {
  id: string;
  traceId: string;
  /** Undefined only for the root (turn) observation. */
  parentId?: string;
  name: string;
  type: ObservationType;
  startTime: string;
  endTime: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  model?: string;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  /** Langfuse prompt version a generation used (prompt management link; never set for the repo fallback). */
  prompt?: { name: string; version: number };
};

export type TraceScore = {
  id: string;
  traceId?: string;
  observationId?: string;
  sessionId?: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  comment?: string;
};

export type TurnTrace = {
  traceId: string;
  runId: string;
  turn: number;
  sessionId: string;
  promptVersion?: string;
  observations: TraceObservation[];
  scores: TraceScore[];
};

export type ToObservationsOptions = {
  /** Model for events recorded before `model_call.model` existed. */
  model?: string;
  /**
   * Events recorded before `turn_end` existed: synthesize each turn's root from its
   * events, and carry cumulative spend/leads across turns. Use only on a whole file.
   */
  legacyRoots?: boolean;
  /** Langfuse environment the ids are qualified with; defaults to this process's. */
  environment?: string;
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A model_call event's `prompt` link, if well-formed. */
function promptLinkOf(value: unknown): { name: string; version: number } | undefined {
  const r = rec(value);
  const name = str(r.name);
  return name && typeof r.version === "number" && Number.isInteger(r.version) && r.version > 0 ? { name, version: r.version } : undefined;
}

function minusMs(ts: string, ms: number): string {
  const t = Date.parse(ts);
  return Number.isFinite(t) && ms > 0 ? new Date(t - ms).toISOString() : ts;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Cost per usage type from our price table; `total` is the event's claudeCost, unrounded, so trace totals equal event sums. */
function costBreakdown(model: string | undefined, tokens: Record<string, unknown>, total: number): Record<string, number> {
  if (!model || !isAgentModel(model)) return { total };
  const p = CLAUDE_PRICES_PER_MILLION[model];
  return {
    input: (num(tokens.input) * p.input) / 1e6,
    output: (num(tokens.output) * p.output) / 1e6,
    cache_read_input_tokens: (num(tokens.cache_read) * p.cache_read) / 1e6,
    cache_creation_input_tokens: (num(tokens.cache_creation) * p.cache_write) / 1e6,
    total,
  };
}

/** Render the clipped model response as an assistant message the Langfuse UI shows as chat + tool cards. */
function assistantOutput(response: unknown): unknown {
  const r = rec(response);
  if (Object.keys(r).length === 0) return undefined;
  const toolUses = Array.isArray(r.tool_uses) ? r.tool_uses.map(rec) : [];
  return {
    role: "assistant",
    content: str(r.text) ?? "",
    ...(toolUses.length
      ? {
          tool_calls: toolUses.map((t) => ({
            ...(str(t.id) ? { id: str(t.id) } : {}),
            type: "function",
            function: { name: str(t.name) ?? "", arguments: str(t.input) ?? "" },
          })),
        }
      : {}),
  };
}

function groupByTurn(events: AgentEvent[]): Array<{ runId: string; turn: number; events: AgentEvent[] }> {
  const groups = new Map<string, { runId: string; turn: number; events: AgentEvent[] }>();
  for (const event of events) {
    const key = `${event.runId}:${event.turn}`;
    let group = groups.get(key);
    if (!group) {
      group = { runId: event.runId, turn: event.turn, events: [] };
      groups.set(key, group);
    }
    group.events.push(event);
  }
  return [...groups.values()];
}

/**
 * The only mapping from events to Langfuse objects. Pure and deterministic: the same
 * events always yield the same ids and payloads (masking is applied later, in export).
 */
export function toObservations(events: AgentEvent[], options: ToObservationsOptions = {}): TurnTrace[] {
  const traces: TurnTrace[] = [];
  let cumulativeSpend = 0;
  let cumulativeLeads = 0;
  const environment = options.environment ?? tracingEnvironment();
  for (const group of groupByTurn(events)) {
    const { runId, turn } = group;
    const traceId = traceIdFor(runId, turn, environment);
    const rootId = rootObservationId(runId, turn, environment);
    const observations: TraceObservation[] = [];
    const scores: TraceScore[] = [];
    const used = new Map<string, number>();
    const idFor = (key: string): string => {
      const n = used.get(key) ?? 0;
      used.set(key, n + 1);
      return observationIdFor(traceId, n === 0 ? key : `${key}#${n}`);
    };
    let lastModelCallTs: string | undefined;
    let lastSubmit: TraceObservation | undefined;
    const openApprovals: AgentEvent[] = [];
    let root: TraceObservation | undefined;
    let stopEvent: AgentEvent | undefined;
    let promptVersion: string | undefined;
    const child = (obs: Omit<TraceObservation, "traceId" | "parentId">): TraceObservation => {
      const full: TraceObservation = { traceId, parentId: rootId, ...obs };
      observations.push(full);
      return full;
    };

    for (const e of group.events) {
      promptVersion ??= str(e.promptVersion);
      switch (e.kind) {
        case "model_call": {
          const tokens = rec(e.tokens);
          const latencyMs = num(e.latencyMs);
          const model = str(e.model) ?? options.model;
          const handback = e.handback === true;
          const stopReason = str(e.stop_reason);
          const prompt = promptLinkOf(e.prompt);
          child({
            id: idFor(str(e.responseId) ? `model:${str(e.responseId)}` : `model:${e.ts}:${handback ? "handback" : "loop"}`),
            name: "model",
            type: "generation",
            startTime: minusMs(e.ts, latencyMs),
            endTime: e.ts,
            input: {
              ...(e.messages !== undefined ? { messages: e.messages } : {}),
              ...(e.systemSha256 !== undefined ? { system_sha256: e.systemSha256 } : {}),
              ...(e.toolsSha256 !== undefined ? { tools_sha256: e.toolsSha256 } : {}),
              promptVersion: e.promptVersion,
            },
            output: assistantOutput(e.response),
            model,
            usageDetails: {
              input: num(tokens.input),
              output: num(tokens.output),
              cache_read_input_tokens: num(tokens.cache_read),
              cache_creation_input_tokens: num(tokens.cache_creation),
            },
            costDetails: costBreakdown(model, tokens, num(e.claudeCost)),
            metadata: {
              purpose: handback ? "handback" : "loop",
              stop_reason: stopReason ?? null,
              latencyMs,
              promptVersion: e.promptVersion,
            },
            ...(stopReason === "max_tokens" || stopReason === "refusal" ? { level: "WARNING" as const, statusMessage: `stop_reason=${stopReason}` } : {}),
            ...(prompt ? { prompt } : {}),
          });
          lastModelCallTs = e.ts;
          cumulativeSpend += num(e.claudeCost);
          break;
        }
        case "tool_call": {
          const tool = str(e.tool) ?? "unknown";
          const latencyMs = num(e.latencyMs);
          const isError = e.is_error === true;
          const toolUseId = str(e.toolUseId);
          const key = toolUseId ? toolObservationKey(toolUseId) : `tool:${e.ts}:${tool}:${sha256Hex(JSON.stringify(e.input ?? null)).slice(0, 16)}`;
          const obs = child({
            id: idFor(key),
            name: `tool:${tool}`,
            type: "tool",
            startTime: latencyMs > 0 ? minusMs(e.ts, latencyMs) : (lastModelCallTs ?? e.ts),
            endTime: e.ts,
            input: e.input ?? {},
            output: { ...(str(e.resultSummary) !== undefined ? { result: str(e.resultSummary) } : {}), is_error: isError },
            metadata: { tool, exaCost: num(e.exaCost), latencyMs, ...(toolUseId ? { toolUseId } : {}) },
            ...(isError ? { level: "ERROR" as const, statusMessage: str(e.resultSummary) ?? "tool error" } : {}),
          });
          lastSubmit = tool === "submit_lead" ? obs : undefined;
          cumulativeSpend += num(e.exaCost);
          break;
        }
        case "submit_verdict": {
          const code = str(e.code) ?? "unknown";
          const target = lastSubmit;
          if (target) {
            target.output = { ...rec(target.output), company: str(e.company) ?? null, verdict: code, ok: e.ok === true, reason: str(e.reason) ?? null };
            target.metadata = { ...target.metadata, verdict: code };
            if (e.ok !== true) target.level = "WARNING";
            lastSubmit = undefined;
          }
          if (e.ok === true) cumulativeLeads += 1;
          scores.push({
            id: scoreIdFor("gate_verdict", traceId, target?.id ?? e.ts),
            traceId,
            ...(target ? { observationId: target.id } : {}),
            name: "gate_verdict",
            value: code,
            dataType: "CATEGORICAL",
            ...(str(e.reason) ? { comment: str(e.reason) } : {}),
          });
          break;
        }
        case "approval_request": {
          openApprovals.push(e);
          child({
            id: idFor(`approval_request:${e.ts}`),
            name: "approval-request",
            type: "event",
            startTime: e.ts,
            endTime: e.ts,
            input: { tool: e.tool ?? null, proposal: e.input ?? null },
          });
          break;
        }
        case "decision": {
          const paired = openApprovals.shift();
          const requestTs = str(e.requestTs) ?? paired?.ts ?? e.ts;
          const waitMs = Math.max(0, Date.parse(e.ts) - Date.parse(requestTs)) || 0;
          const decision = e.approve === true ? (e.revisedValue !== undefined ? "revise" : "approve") : "decline";
          const approvalTool = str(e.tool) ?? str(paired?.tool);
          const approvalId = idFor(`approval:${e.ts}`);
          // A score, so dashboards can chart the decline rate (a span's output is not a chart dimension).
          scores.push({
            id: scoreIdFor("approval_decision", traceId, approvalId),
            traceId,
            observationId: approvalId,
            name: "approval_decision",
            value: decision,
            dataType: "CATEGORICAL",
            ...(approvalTool ? { comment: approvalTool } : {}),
          });
          child({
            id: approvalId,
            name: "approval",
            type: "span",
            startTime: requestTs,
            endTime: e.ts,
            input: { tool: e.tool ?? paired?.tool ?? null },
            output: {
              decision,
              note: e.note ?? null,
              ...(e.revisedValue !== undefined ? { revisedValue: e.revisedValue } : {}),
              ...(e.before !== undefined ? { before: e.before } : {}),
              ...(e.error !== undefined ? { error: e.error } : {}),
            },
            metadata: { waitMs },
            ...(e.error !== undefined ? { level: "WARNING" as const, statusMessage: String(e.error) } : {}),
          });
          break;
        }
        case "policy": {
          const outcome = str(e.outcome) ?? "pass";
          child({
            id: idFor(`policy:${e.ts}:${str(e.scope) ?? "loop"}:${str(e.check) ?? "limits"}`),
            name: "policy",
            type: "guardrail",
            startTime: e.ts,
            endTime: e.ts,
            input: { scope: e.scope ?? "loop", check: e.check ?? "limits" },
            output: { outcome, ...(e.reason !== undefined ? { reason: e.reason } : {}) },
            metadata: rec(e.snapshot),
            // A limit that ends the run on target is the happy path; anything else is worth a look.
            ...(outcome !== "pass" && e.status !== "done" ? { level: "WARNING" as const, statusMessage: `${outcome}: ${String(e.reason ?? "")}` } : {}),
          });
          break;
        }
        case "turn_end": {
          const durationMs = num(e.durationMs);
          root = {
            id: rootId,
            traceId,
            name: AGENT_TRACE_NAME,
            type: "agent",
            startTime: minusMs(e.ts, durationMs),
            endTime: e.ts,
            input: e.before ?? { turn },
            output: {
              status: e.status ?? null,
              stopReason: e.stopReason ?? null,
              spend: e.spend ?? null,
              leads: e.leads ?? null,
            },
            metadata: { turn, durationMs },
            ...(e.status === "error" ? { level: "ERROR" as const, statusMessage: String(e.stopReason ?? "error") } : {}),
          };
          break;
        }
        case "stop": {
          stopEvent = e;
          child({
            id: idFor(`stop:${e.ts}`),
            name: "stop",
            type: "event",
            startTime: e.ts,
            endTime: e.ts,
            output: { status: e.status ?? null, reason: e.reason ?? null },
            ...(e.status === "error" ? { level: "ERROR" as const } : e.status === "stopped" ? { level: "WARNING" as const } : {}),
            ...(e.status !== "done" && e.reason !== undefined ? { statusMessage: String(e.reason) } : {}),
          });
          break;
        }
        case "error": {
          child({
            id: idFor(`error:${e.ts}`),
            name: "error",
            type: "event",
            startTime: e.ts,
            endTime: e.ts,
            output: { message: e.message ?? null, reason: e.reason ?? null },
            level: "ERROR",
            statusMessage: String(e.message ?? e.reason ?? "error"),
          });
          break;
        }
        case "feedback": {
          const toolUseId = str(e.toolUseId);
          const observationId = toolUseId ? observationIdFor(traceId, toolObservationKey(toolUseId)) : undefined;
          child({
            id: idFor(`feedback:${e.ts}`),
            name: "user-feedback",
            type: "event",
            startTime: e.ts,
            endTime: e.ts,
            input: { company: e.company ?? null, signal_url: e.signal_url ?? null },
            output: { verdict: e.verdict ?? null, reason: e.reason ?? null },
          });
          scores.push({
            id: scoreIdFor("user_feedback", runId, String(e.signal_url ?? ""), String(e.company ?? "")),
            traceId,
            ...(observationId ? { observationId } : {}),
            name: "user_feedback",
            value: e.verdict === "up" ? 1 : -1,
            dataType: "NUMERIC",
            ...(str(e.reason) ? { comment: str(e.reason) } : {}),
          });
          break;
        }
        default:
          break;
      }
    }

    if (!root && options.legacyRoots && group.events.some((e) => e.kind === "model_call")) {
      const starts = observations.map((o) => o.startTime).sort();
      const ends = observations.map((o) => o.endTime).sort();
      const startTime = starts[0] ?? group.events[0]!.ts;
      const endTime = ends[ends.length - 1] ?? group.events[group.events.length - 1]!.ts;
      root = {
        id: rootId,
        traceId,
        name: AGENT_TRACE_NAME,
        type: "agent",
        startTime,
        endTime,
        input: { turn },
        output: {
          status: stopEvent ? (stopEvent.status ?? "done") : "running",
          stopReason: stopEvent?.reason ?? null,
          spend: { total: round6(cumulativeSpend) },
          leads: cumulativeLeads,
        },
        metadata: { turn, durationMs: Math.max(0, Date.parse(endTime) - Date.parse(startTime)), legacy: true },
      };
    }

    traces.push({
      traceId,
      runId,
      turn,
      sessionId: runId,
      ...(promptVersion ? { promptVersion } : {}),
      observations: root ? [root, ...observations] : observations,
      scores,
    });
  }
  return traces;
}

/* ------------------------------------------------------------------ */
/* Run context (run-level attributes from state.json)                  */
/* ------------------------------------------------------------------ */

export type RunContext = { workspaceId?: string; model?: string; contractLabel?: string };

export function runContextFromState(state: unknown): RunContext {
  const s = rec(state);
  return {
    ...(str(s.workspaceId) ? { workspaceId: str(s.workspaceId) } : {}),
    ...(str(s.model) ? { model: str(s.model) } : {}),
    ...(str(rec(s.contract).label) ? { contractLabel: str(rec(s.contract).label) } : {}),
  };
}

async function loadRunContext(runId: string): Promise<RunContext> {
  try {
    return runContextFromState(JSON.parse(await readFile(join(RUNS_DIR, runId, "state.json"), "utf8")));
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* SDK (lazy)                                                          */
/* ------------------------------------------------------------------ */

type Sdk = {
  tracing: typeof import("@langfuse/tracing");
  api: typeof import("@opentelemetry/api");
  processor: import("@langfuse/otel").LangfuseSpanProcessor;
  provider: import("@opentelemetry/sdk-trace-base").BasicTracerProvider;
  ids: FixedIdGenerator;
  client?: import("@langfuse/client").LangfuseClient;
};

/** Hands out the ids we choose for the next span; random otherwise (planner spans). */
class FixedIdGenerator {
  next: { spanId?: string; traceId?: string } | undefined;
  generateTraceId(): string {
    const id = this.next?.traceId;
    if (id) {
      this.next!.traceId = undefined;
      return id;
    }
    return randomHex(16);
  }
  generateSpanId(): string {
    const id = this.next?.spanId;
    if (id) {
      this.next!.spanId = undefined;
      return id;
    }
    return randomHex(8);
  }
}

function randomHex(bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out;
}

export type TraceTestHooks = {
  /** OpenTelemetry SpanExporter used instead of the Langfuse OTLP exporter. */
  exporter?: import("@opentelemetry/sdk-trace-base").SpanExporter;
  /** Receives every score body instead of the Langfuse client. */
  onScore?: (body: Record<string, unknown>) => void;
  /** Score client used instead of a real LangfuseClient. */
  client?: { score: { create(body: never): unknown }; flush(): Promise<unknown> };
  /** Receives every annotation-queue item instead of the Langfuse API. */
  onQueueItem?: (item: { queue: string; objectId: string; objectType: "TRACE" | "OBSERVATION" | "SESSION" }) => void;
};

let testHooks: TraceTestHooks | undefined;
let sdkPromise: Promise<Sdk> | undefined;
const pending = new Set<Promise<unknown>>();
const stats = { emitted: 0, exportFailures: 0, emitErrors: 0 };
let warned = false;

/** Tests only: route spans and scores to fakes. Resets the SDK so the next emit re-initializes. */
export async function __setTraceTestHooks(hooks: TraceTestHooks | undefined): Promise<void> {
  if (sdkPromise) {
    const sdk = await sdkPromise.catch(() => undefined);
    await sdk?.provider.shutdown().catch(() => undefined);
  }
  sdkPromise = undefined;
  queueIds.clear();
  testHooks = hooks;
  stats.emitted = 0;
  stats.exportFailures = 0;
  stats.emitErrors = 0;
}

/** Export failures are counted, never thrown; the completeness grader reads these. */
export function traceStats(): { emitted: number; exportFailures: number; emitErrors: number } {
  return { ...stats };
}

function warnOnce(message: string, error?: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[trace] ${message}${error instanceof Error ? `: ${maskString(error.message)}` : ""}`);
}

async function init(): Promise<Sdk> {
  sdkPromise ??= (async () => {
    const [tracing, otel, api, base, core, asyncHooks] = await Promise.all([
      import("@langfuse/tracing"),
      import("@langfuse/otel"),
      import("@opentelemetry/api"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/core"),
      import("@opentelemetry/context-async-hooks"),
    ]);
    // propagateAttributes and startActiveObservation need an async context manager.
    // Returns false (and keeps the existing one) if the host already registered one.
    api.context.setGlobalContextManager(new asyncHooks.AsyncLocalStorageContextManager().enable());
    // Span export failures surface through the OTel global error handler: count them.
    core.setGlobalErrorHandler((error) => {
      stats.exportFailures += 1;
      warnOnce("Langfuse span export failed", error);
    });
    const ids = new FixedIdGenerator();
    const processor = new otel.LangfuseSpanProcessor({
      ...(testHooks?.exporter ? { exporter: testHooks.exporter } : {}),
      // Real-time ingestion on the Langfuse v4 data model (OTel endpoint docs).
      additionalHeaders: { "x-langfuse-ingestion-version": "4" },
      // Second masking layer: the processor masks input/output/metadata at export.
      mask: ({ data }) => (typeof data === "string" ? maskString(data) : data),
      // We only create Langfuse spans on this isolated provider; export all of them.
      shouldExportSpan: () => true,
      // Batched (long-running server), but flushed every second rather than every 5 s:
      // Next.js exits on SIGTERM without waiting for us, so this bounds what a redeploy
      // can drop (the backfill restores it). LANGFUSE_FLUSH_INTERVAL still overrides.
      ...(process.env.LANGFUSE_FLUSH_INTERVAL ? {} : { flushInterval: 1 }),
    });
    const provider = new base.BasicTracerProvider({ idGenerator: ids, spanProcessors: [processor] });
    tracing.setLangfuseTracerProvider(provider);
    let client: Sdk["client"];
    if (testHooks?.client) client = testHooks.client as unknown as Sdk["client"];
    else if (!testHooks?.onScore) {
      const { LangfuseClient } = await import("@langfuse/client");
      client = new LangfuseClient();
    }
    registerExitFlush();
    return { tracing, api, processor, provider, ids, client };
  })();
  return sdkPromise;
}

let exitHooked = false;
function registerExitFlush(): void {
  if (exitHooked || typeof process === "undefined" || typeof process.once !== "function") return;
  exitHooked = true;
  process.once("beforeExit", () => {
    void flush();
  });
  // Prepended so the flush starts before a host handler (Next.js) begins its own shutdown.
  process.prependOnceListener("SIGTERM", () => {
    const done = () => {
      // Re-raise with the default handler unless the host installed its own.
      if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
    };
    Promise.race([flush(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(done, done);
  });
}

function sdkLevel(level: TraceObservation["level"]): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" | undefined {
  return level;
}

function observationAttributes(obs: TraceObservation, maskOptions: MaskOptions): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (obs.input !== undefined) attrs.input = mask(obs.input, maskOptions);
  if (obs.output !== undefined) attrs.output = mask(obs.output, maskOptions);
  if (obs.metadata !== undefined) attrs.metadata = mask(obs.metadata, maskOptions);
  if (obs.level) attrs.level = sdkLevel(obs.level);
  if (obs.statusMessage) attrs.statusMessage = maskString(obs.statusMessage, maskOptions);
  if (obs.model) attrs.model = obs.model;
  if (obs.usageDetails) attrs.usageDetails = obs.usageDetails;
  if (obs.costDetails) attrs.costDetails = obs.costDetails;
  // SDK prompt link (docs: prompt-management/features/link-to-traces): sets
  // langfuse.observation.prompt.name/.version, which drive per-version metrics.
  if (obs.prompt && obs.type === "generation") attrs.prompt = { name: obs.prompt.name, version: obs.prompt.version, isFallback: false };
  return attrs;
}

/** Propagated (filterable) attributes for every observation of a run's traces. */
function runAttributes(trace: TurnTrace, ctx: RunContext, maskOptions: MaskOptions) {
  const userId = ctx.workspaceId ? hashWorkspaceId(ctx.workspaceId) : undefined;
  const metadata: Record<string, string> = { runId: trace.runId, turn: String(trace.turn) };
  if (ctx.model) metadata.model = ctx.model;
  if (trace.promptVersion) metadata.promptVersion = trace.promptVersion.slice(0, 200);
  if (ctx.contractLabel) metadata.contract = maskString(ctx.contractLabel, maskOptions).slice(0, 200);
  return {
    sessionId: trace.sessionId,
    ...(userId ? { userId } : {}),
    traceName: AGENT_TRACE_NAME,
    tags: ["agent"],
    ...(trace.promptVersion ? { version: trace.promptVersion.slice(0, 200) } : {}),
    metadata,
  };
}

function exportObservations(sdk: Sdk, traces: TurnTrace[], ctx: RunContext, skip?: { observations: Set<string>; scores: Set<string> }): { observations: number; scores: number } {
  const maskOptions: MaskOptions = { workspaceId: ctx.workspaceId };
  let observations = 0;
  let scores = 0;
  for (const trace of traces) {
    sdk.tracing.propagateAttributes(runAttributes(trace, ctx, maskOptions), () => {
      for (const obs of trace.observations) {
        if (skip?.observations.has(obs.id)) continue;
        const attrs = observationAttributes(obs, maskOptions);
        const startTime = new Date(obs.startTime);
        const create = () => {
          sdk.ids.next = obs.parentId ? { spanId: obs.id } : { spanId: obs.id, traceId: obs.traceId };
          try {
            const observation = sdk.tracing.startObservation(obs.name, attrs as never, {
              asType: obs.type as never,
              startTime,
              ...(obs.parentId ? { parentSpanContext: { traceId: obs.traceId, spanId: obs.parentId, traceFlags: 1 } } : {}),
            }) as { end(endTime?: Date): void };
            if (obs.type !== "event") observation.end(new Date(obs.endTime));
          } finally {
            sdk.ids.next = undefined;
          }
        };
        // A root must not attach to whatever span happens to be active.
        if (obs.parentId) create();
        else sdk.api.context.with(sdk.api.trace.deleteSpan(sdk.api.context.active()), create);
        observations += 1;
      }
    });
    for (const s of trace.scores) {
      if (skip?.scores.has(s.id)) continue;
      sendScore(sdk, s, maskOptions);
      scores += 1;
    }
  }
  stats.emitted += observations;
  return { observations, scores };
}

function sendScore(sdk: Sdk, s: TraceScore, maskOptions: MaskOptions): void {
  const body: Record<string, unknown> = {
    id: s.id,
    name: s.name,
    value: typeof s.value === "string" ? maskString(s.value, maskOptions) : s.value,
    dataType: s.dataType,
    ...(s.traceId ? { traceId: s.traceId } : {}),
    ...(s.observationId ? { observationId: s.observationId } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    ...(s.comment ? { comment: maskString(s.comment, maskOptions).slice(0, 500) } : {}),
  };
  if (testHooks?.onScore) {
    testHooks.onScore({ ...body, environment: process.env.LANGFUSE_TRACING_ENVIRONMENT });
    return;
  }
  try {
    // create() queues and returns void today; guard anyway so a rejecting transport can
    // never become an unhandled rejection, and count it as an export failure.
    const result = sdk.client?.score.create(body as never) as unknown;
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch((error) => {
        stats.exportFailures += 1;
        warnOnce("Langfuse score export failed", error);
      });
    }
  } catch (error) {
    stats.exportFailures += 1;
    warnOnce("Langfuse score export failed", error);
  }
}

function track(promise: Promise<unknown>): void {
  const p = promise.catch((error) => {
    stats.emitErrors += 1;
    warnOnce("trace emit failed", error);
  });
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Live path: called once per `appendEvents`, after the file append succeeded.
 * Fire-and-forget: never throws, never blocks the loop, never touches run files.
 */
export function emit(events: AgentEvent[]): void {
  try {
    if (!enabled() || events.length === 0) return;
    track(
      (async () => {
        const sdk = await init();
        const ctx = await loadRunContext(events[0]!.runId);
        exportObservations(sdk, toObservations(events, { model: ctx.model }), ctx);
      })(),
    );
  } catch (error) {
    stats.emitErrors += 1;
    warnOnce("trace emit failed", error);
  }
}

/** A score on a trace, observation or session (masked comment). Fire-and-forget. */
export function score(
  target: { traceId?: string; observationId?: string; sessionId?: string },
  name: string,
  value: number | string,
  options: { id?: string; comment?: string; dataType?: TraceScore["dataType"]; workspaceId?: string } = {},
): void {
  try {
    if (!enabled()) return;
    track(
      (async () => {
        const sdk = await init();
        sendScore(
          sdk,
          {
            id: options.id ?? scoreIdFor(name, target.traceId ?? "", target.observationId ?? "", target.sessionId ?? ""),
            name,
            value,
            dataType: options.dataType ?? (typeof value === "string" ? "CATEGORICAL" : "NUMERIC"),
            ...target,
            ...(options.comment ? { comment: options.comment } : {}),
          },
          { workspaceId: options.workspaceId },
        );
      })(),
    );
  } catch (error) {
    stats.emitErrors += 1;
    warnOnce("trace score failed", error);
  }
}

/* ---------- online evaluation (SPEC-observability §5) ---------- */

/** Name of the observation the managed lead judges (Langfuse evaluators judge_q1..q3) run on. */
export const LEAD_JUDGE_OBSERVATION = "lead-judge";

/** Observation id of a lead's judge request: a child of its `tool:submit_lead` span, at most one per lead. */
export function leadJudgeObservationId(traceId: string, toolUseId: string): string {
  return observationIdFor(traceId, `lead-judge:${toolUseId}`);
}

/**
 * Emit the observation the managed LLM-as-a-judge evaluators run on: input = the judge
 * payload (src/agent/judge-input.ts, the same object the offline judge reads), metadata =
 * why it was selected. Its parent is the lead's submit span in the lead's turn trace, so
 * the judge scores sit under the lead they judge. Fire-and-forget; never throws.
 */
export function emitLeadJudge(request: {
  runId: string;
  turn: number;
  toolUseId: string;
  input: unknown;
  metadata: Record<string, string>;
  state?: unknown;
  ts?: string;
}): { traceId: string; observationId: string } | undefined {
  try {
    if (!enabled()) return undefined;
    const traceId = traceIdFor(request.runId, request.turn);
    const observationId = leadJudgeObservationId(traceId, request.toolUseId);
    const ts = request.ts ?? new Date().toISOString();
    const ctx = runContextFromState(request.state);
    const trace: TurnTrace = {
      traceId,
      runId: request.runId,
      turn: request.turn,
      sessionId: request.runId,
      observations: [
        {
          id: observationId,
          traceId,
          parentId: observationIdFor(traceId, toolObservationKey(request.toolUseId)),
          name: LEAD_JUDGE_OBSERVATION,
          type: "event",
          startTime: ts,
          endTime: ts,
          input: request.input,
          metadata: request.metadata,
        },
      ],
      scores: [],
    };
    track(
      (async () => {
        const sdk = await init();
        exportObservations(sdk, [trace], ctx);
      })(),
    );
    return { traceId, observationId };
  } catch (error) {
    stats.emitErrors += 1;
    warnOnce("lead judge emit failed", error);
    return undefined;
  }
}

/** Langfuse annotation queue that collects production runs for review. */
export const REVIEW_QUEUE_NAME = "review-queue";
const queueIds = new Map<string, Promise<string | undefined>>();

async function queueId(sdk: Sdk, name: string): Promise<string | undefined> {
  let id = queueIds.get(name);
  if (!id) {
    id = (async () => {
      for (let page = 1; page <= 10; page += 1) {
        const res = await sdk.client!.api.annotationQueues.listQueues({ page, limit: 100 });
        const hit = res.data.find((q) => q.name === name);
        if (hit) return hit.id;
        if (page >= (res.meta?.totalPages ?? 1)) break;
      }
      return undefined;
    })();
    queueIds.set(name, id);
    // A miss (queue not created yet) or an error is retried next time instead of cached.
    id.then((v) => (v ? undefined : queueIds.delete(name)), () => queueIds.delete(name));
  }
  return id;
}

/**
 * Add a trace (or observation/session) to the review annotation queue. Fire-and-forget;
 * a missing queue or an API error is logged once, never thrown.
 */
export function enqueueForReview(objectId: string, objectType: "TRACE" | "OBSERVATION" | "SESSION" = "TRACE", queue = REVIEW_QUEUE_NAME): void {
  try {
    if (!enabled()) return;
    if (testHooks?.onQueueItem) {
      testHooks.onQueueItem({ queue, objectId, objectType });
      return;
    }
    track(
      (async () => {
        const sdk = await init();
        if (!sdk.client) return;
        const id = await queueId(sdk, queue);
        if (!id) {
          warnOnce(`annotation queue "${queue}" not found; run eval/online/setup-langfuse.ts`);
          return;
        }
        await sdk.client.api.annotationQueues.createQueueItem(id, { objectId, objectType } as never);
      })(),
    );
  } catch (error) {
    stats.emitErrors += 1;
    warnOnce("review enqueue failed", error);
  }
}

/** Wait for queued emits, then flush spans and scores. Never throws. */
export async function flush(): Promise<void> {
  if (!sdkPromise) return;
  await Promise.allSettled([...pending]);
  const sdk = await sdkPromise.catch(() => undefined);
  if (!sdk) return;
  try {
    await sdk.processor.forceFlush();
  } catch (error) {
    stats.exportFailures += 1;
    warnOnce("Langfuse span flush failed", error);
  }
  try {
    await sdk.client?.flush();
  } catch (error) {
    stats.exportFailures += 1;
    warnOnce("Langfuse score flush failed", error);
  }
}

/* ---------- planner routes: one trace per call ---------- */

const PLANNER_INPUT_LIMIT = 2000;

/**
 * Wrap one planner route call in its own trace (session = user = HMAC(workspaceId)).
 * Tracing problems never change the route's result: `fn` runs exactly once either way.
 */
export async function tracePlanner<T>(
  route: "profile" | "cards" | "plan",
  workspaceId: string,
  input: unknown,
  fn: () => Promise<T>,
  summarize: (result: T) => unknown,
): Promise<T> {
  if (!enabled()) return fn();
  let sdk: Sdk;
  try {
    sdk = await init();
  } catch (error) {
    stats.emitErrors += 1;
    warnOnce("trace init failed", error);
    return fn();
  }
  const maskOptions: MaskOptions = { workspaceId };
  const hashed = hashWorkspaceId(workspaceId);
  const name = `planner-${route}`;
  const run = () =>
    sdk.tracing.startActiveObservation(
      name,
      async (span) => {
        safe(() => span.update({ input: mask(clipJson(input), maskOptions) }));
        try {
          const result = await fn();
          safe(() => span.update({ output: mask(clipJson(summarize(result)), maskOptions) }));
          return result;
        } catch (error) {
          safe(() => span.update({ level: "ERROR", statusMessage: maskString(error instanceof Error ? error.message : "error", maskOptions) }));
          throw error;
        }
      },
      { asType: "chain" },
    );
  return sdk.tracing.propagateAttributes(
    { ...(hashed ? { sessionId: hashed, userId: hashed } : {}), traceName: name, tags: ["planner"] },
    () => sdk.api.context.with(sdk.api.trace.deleteSpan(sdk.api.context.active()), run),
  );
}

/** Inside a planner trace: one generation per Claude call. No-op outside one or when disabled. */
export function recordPlannerGeneration(call: {
  model: string;
  startTime: Date;
  endTime: Date;
  system: string;
  user: string;
  outputText: string;
  usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | null;
  cost: number;
  attempt: number;
  /** Langfuse prompt version used (absent when the repo fallback ran). */
  prompt?: { name: string; version: number };
}): void {
  try {
    if (!enabled() || !sdkPromise) return;
    void sdkPromise
      .then((sdk) => {
        if (!sdk.api.trace.getActiveSpan()) return;
        const usage = call.usage ?? {};
        const tokens = { input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_creation: usage.cache_creation_input_tokens };
        const generation = sdk.tracing.startObservation(
          "planner-model",
          {
            model: call.model,
            input: mask([{ role: "system", content: `sha256:${sha256Hex(call.system)}` }, { role: "user", content: call.user.slice(0, PLANNER_INPUT_LIMIT) }]),
            output: mask({ role: "assistant", content: call.outputText.slice(0, PLANNER_INPUT_LIMIT) }),
            usageDetails: {
              input: num(usage.input_tokens),
              output: num(usage.output_tokens),
              cache_read_input_tokens: num(usage.cache_read_input_tokens),
              cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
            },
            costDetails: costBreakdown(call.model, tokens, call.cost),
            metadata: { attempt: call.attempt },
            ...(call.prompt ? { prompt: { name: call.prompt.name, version: call.prompt.version, isFallback: false } } : {}),
          },
          { asType: "generation", startTime: call.startTime },
        );
        generation.end(call.endTime);
      })
      .catch(() => undefined);
  } catch {
    /* never affects the planner */
  }
}

function clipJson(value: unknown): unknown {
  const text = JSON.stringify(value ?? null) ?? "null";
  if (text.length <= PLANNER_INPUT_LIMIT) return value;
  return { clipped: `${text.slice(0, PLANNER_INPUT_LIMIT)}…`, length: text.length };
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* tracing must not affect the caller */
  }
}

/* ---------- backfill ---------- */

export type BackfillResult = {
  traces: Array<{ traceId: string; turn: number; observations: number; newObservations: number; scores: number; newScores: number }>;
  exported: { observations: number; scores: number };
  skipped: { observations: number; scores: number };
};

export type ExistingClient = {
  api: {
    observations: { getMany(req: Record<string, unknown>): Promise<{ data: Array<{ id: string }>; meta: { cursor?: string | null } }> };
    scoresV3: { getManyV3(req: Record<string, unknown>): Promise<{ data: Array<{ id: string }>; meta: { cursor?: string | null } }> };
  };
};
export type ExistingOptions = {
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (p: { done: number; total: number; etaMs: number | undefined }) => void;
  now?: () => number;
};

/** Seconds from a 429's Retry-After header (or body), else undefined. */
function retryAfterMs(error: unknown): number | undefined {
  const e = error as { statusCode?: number; rawResponse?: { headers?: Headers | Record<string, string> } };
  if (e?.statusCode !== 429) return undefined;
  const h = e.rawResponse?.headers;
  const raw = h && typeof (h as Headers).get === "function" ? (h as Headers).get("retry-after") : (h as Record<string, string> | undefined)?.["retry-after"];
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : 5000;
}

async function withRetryAfter<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait === undefined || i >= attempts) throw error;
      await sleep(wait);
    }
  }
}

/**
 * Ids Langfuse already holds for these traces. Scores are listed in batches (the API takes a
 * comma-separated traceId list), observations per trace; 429s honour retry-after; work runs at
 * `concurrency` and reports progress with an ETA.
 */
export async function listExisting(client: ExistingClient, traceIds: string[], environment: string, options: ExistingOptions = {}): Promise<{ observations: Set<string>; scores: Set<string> }> {
  const { concurrency = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = options;
  const observations = new Set<string>();
  const scores = new Set<string>();
  const BATCH = 10;
  const tasks: Array<() => Promise<void>> = [];
  for (const traceId of traceIds) {
    tasks.push(async () => {
      let cursor: string | undefined;
      do {
        const page = await withRetryAfter(() => client.api.observations.getMany({ traceId, environment, fields: "core", limit: 1000, ...(cursor ? { cursor } : {}) }), sleep);
        for (const o of page.data) observations.add(o.id);
        cursor = page.meta.cursor ?? undefined;
      } while (cursor);
    });
  }
  for (let i = 0; i < traceIds.length; i += BATCH) {
    const batch = traceIds.slice(i, i + BATCH).join(",");
    tasks.push(async () => {
      let cursor: string | undefined;
      do {
        const page = await withRetryAfter(() => client.api.scoresV3.getManyV3({ traceId: batch, environment, limit: 100, ...(cursor ? { cursor } : {}) }), sleep);
        for (const s of page.data) scores.add(s.id);
        cursor = page.meta.cursor ?? undefined;
      } while (cursor);
    });
  }
  const started = now();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
      done += 1;
      const elapsed = now() - started;
      options.onProgress?.({ done, total: tasks.length, etaMs: done > 0 ? Math.round((elapsed / done) * (tasks.length - done)) : undefined });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return { observations, scores };
}

/** Ids of observations and scores Langfuse already holds for these traces, in this environment only. */
export async function existingIds(traceIds: string[], environment = tracingEnvironment(), options: ExistingOptions = {}): Promise<{ observations: Set<string>; scores: Set<string> }> {
  const sdk = await init();
  const client = sdk.client ?? new (await import("@langfuse/client")).LangfuseClient();
  return listExisting(client as unknown as ExistingClient, traceIds, environment, options);
}

/**
 * Backfill one run from its events (+ state). Lists what Langfuse already has and
 * exports only missing observations and scores, so re-running never duplicates.
 */
export async function backfill(events: AgentEvent[], state: unknown, options: ExistingOptions = {}): Promise<BackfillResult> {
  const ctx = runContextFromState(state);
  const environment = tracingEnvironment();
  const traces = toObservations(events, { model: ctx.model, environment, legacyRoots: !events.some((e) => e.kind === "turn_end") });
  const sdk = await init();
  const have = await existingIds(traces.map((t) => t.traceId), environment, options);
  const exported = exportObservations(sdk, traces, ctx, have);
  await flush();
  const total = { observations: traces.reduce((n, t) => n + t.observations.length, 0), scores: traces.reduce((n, t) => n + t.scores.length, 0) };
  return {
    traces: traces.map((t) => ({
      traceId: t.traceId,
      turn: t.turn,
      observations: t.observations.length,
      newObservations: t.observations.filter((o) => !have.observations.has(o.id)).length,
      scores: t.scores.length,
      newScores: t.scores.filter((s) => !have.scores.has(s.id)).length,
    })),
    exported,
    skipped: { observations: total.observations - exported.observations, scores: total.scores - exported.scores },
  };
}

/** Project id for building UI links (`/project/<id>/traces/<traceId>`). */
export async function projectId(): Promise<string | undefined> {
  const sdk = await init();
  const client = sdk.client ?? new (await import("@langfuse/client")).LangfuseClient();
  const projects = await client.api.projects.get();
  return projects.data[0]?.id;
}
