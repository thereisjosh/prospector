import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "./config";
import { assertRunId } from "./ids";
import { PROMPT_VERSION } from "./prompts";
import type { RunState } from "./state";
import { emit as emitTrace } from "./trace";

export type AgentEvent = {
  ts: string;
  runId: string;
  turn: number;
  kind:
    | "model_call"
    | "tool_call"
    | "submit_verdict"
    | "approval_request"
    | "decision"
    | "stop"
    | "error"
    | "policy"
    | "turn_end"
    | "feedback";
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
    promptVersion: PROMPT_VERSION,
    ...payload,
  };
}

/**
 * The single choke point for run events: append to `runs/<id>/events.jsonl`, then hand
 * the same events to the trace layer (fire-and-forget, a no-op with LANGFUSE_* unset).
 * Nothing reaches Langfuse that is not in the file.
 */
export async function appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  const dir = join(RUNS_DIR, assertRunId(runId));
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  emitTrace(events);
}

export async function readLastEvents(runId: string, count = 50): Promise<AgentEvent[]> {
  assertRunId(runId);
  try {
    const raw = await readFile(join(RUNS_DIR, runId, "events.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-count)
      .map((line) => JSON.parse(line) as AgentEvent);
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
