import { mkdir, readFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "./config";
import { withFileLock } from "./fslock";
import { assertRunId } from "./ids";
import { publishLive } from "./live-bus";
import { promptVersionOf } from "./prompts";
import type { RunState } from "./state";
import { emit as emitTrace } from "./trace";

export type AgentEvent = {
  ts: string;
  runId: string;
  turn: number;
  /**
   * Position in the run's events.jsonl (1-based line number), assigned under the append lock.
   * Clients resume a live stream from it (GET /api/runs/:id/events?after=<seq>). Lines written
   * before seq existed read back with their line number (parseEventLines), so the two agree.
   */
  seq?: number;
  kind:
    | "model_call"
    | "tool_started"
    | "tool_call"
    | "lookup_retry"
    | "submit_verdict"
    | "approval_request"
    | "decision"
    | "stop"
    | "error"
    | "policy"
    | "turn_end"
    | "feedback"
    | "memory_recalled"
    | "turn_repaired"
    | "context_trimmed"
    | "token_count_estimated"
    | "stream_fallback";
  promptVersion: string;
  [key: string]: unknown;
};

export function makeEvent(
  state: RunState,
  kind: AgentEvent["kind"],
  payload: Record<string, unknown> = {},
): AgentEvent {
  return {
    ts: new Date().toISOString(),
    runId: state.id,
    turn: state.counters.turns,
    kind,
    promptVersion: promptVersionOf(state),
    ...payload,
  };
}

/**
 * The single choke point for run events: append to `runs/<id>/events.jsonl`, then hand
 * the same events to the trace layer (fire-and-forget, a no-op with LANGFUSE_* unset).
 * Nothing reaches Langfuse that is not in the file.
 *
 * Each event gets `seq` (its line number) set on the object itself, so callers that return
 * these events (the step response) carry the same seq the live stream serves.
 */
export async function appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  await appendEventLines(runId, events);
  emitTrace(events);
}

const EVENTS_FILE = "events.jsonl";
/** Last known (size, seq) per events file, so an append does not re-read the file it just wrote. */
const seqCache = new Map<string, { size: number; seq: number }>();

export function eventsPath(runId: string): string {
  return join(RUNS_DIR, assertRunId(runId), EVENTS_FILE);
}

/**
 * Append with seq, no trace export (the demo replay writes through this: its events are a
 * recording, not a live run). Serialised per file by a lock: seq is read and written under it,
 * so two writers (a step and a route-policy line, or two processes) never share a seq.
 * Append-only: existing lines are never rewritten.
 */
export async function appendEventLines(runId: string, events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  const dir = join(RUNS_DIR, assertRunId(runId));
  const path = join(dir, EVENTS_FILE);
  await mkdir(dir, { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const cached = seqCache.get(path);
    let seq = cached && cached.size === size ? cached.seq : size === 0 ? 0 : countLines(await readFile(path, "utf8"));
    for (const event of events) event.seq = ++seq;
    const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    await appendFile(path, payload, "utf8");
    seqCache.set(path, { size: size + Buffer.byteLength(payload, "utf8"), seq });
    if (seqCache.size > 5_000) seqCache.clear();
  });
  publishLive(runId, { type: "appended" });
}

function countLines(raw: string): number {
  let n = 0;
  for (const line of raw.split("\n")) if (line.trim()) n += 1;
  return n;
}

/** Parse events.jsonl text; a line without `seq` (written before seq existed) gets its line number. */
export function parseEventLines(raw: string, firstLine = 1): AgentEvent[] {
  const out: AgentEvent[] = [];
  let lineNo = firstLine - 1;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lineNo += 1;
    const event = JSON.parse(line) as AgentEvent;
    if (typeof event.seq !== "number") event.seq = lineNo;
    out.push(event);
  }
  return out;
}

export async function readLastEvents(runId: string, count = 50): Promise<AgentEvent[]> {
  assertRunId(runId);
  try {
    const raw = await readFile(join(RUNS_DIR, runId, EVENTS_FILE), "utf8");
    return parseEventLines(raw).slice(-count);
  } catch {
    return [];
  }
}

const INPUT_LIMIT = 200;

function clip(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, INPUT_LIMIT) : undefined;
}

/**
 * A short description of what a tool call asked for, for the UI feed:
 * query / name / url / change only, each capped at 200 chars, never page text.
 */
export function eventInput(tool: string | undefined, input: unknown): Record<string, unknown> {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const query = clip(rec.query);
  if (query !== undefined) out.query = query;
  const name = clip(rec.name);
  if (name !== undefined) out.name = name;
  const url = clip(rec.url);
  if (url !== undefined) out.url = url;
  if (rec.change && typeof rec.change === "object") {
    const change = rec.change as { field?: unknown; value?: unknown };
    const raw = typeof change.value === "string" ? change.value : JSON.stringify(change.value ?? null);
    out.change = {
      field: clip(change.field),
      value: typeof change.value !== "string" && raw.length <= INPUT_LIMIT ? change.value : raw.slice(0, INPUT_LIMIT),
    };
  }
  if (tool === "lookup_company" && Array.isArray(rec.skipped_companies)) {
    out.skipped_companies = rec.skipped_companies
      .filter((v): v is string => typeof v === "string")
      .slice(0, 20)
      .map((v) => v.slice(0, INPUT_LIMIT));
  }
  if (tool === "update_todo") {
    const markdown = clip600(rec.markdown);
    if (markdown !== undefined) out.markdown = markdown;
  }
  if (tool === "submit_lead") {
    const company = clip(rec.company);
    const signalUrl = clip(rec.signal_url);
    if (company !== undefined) out.company = company;
    if (signalUrl !== undefined) out.signal_url = signalUrl;
  }
  return out;
}

function clip600(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 600) : undefined;
}
