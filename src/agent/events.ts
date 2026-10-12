import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "./config";
import { PROMPT_VERSION } from "./prompts";
import type { RunState } from "./state";

export type AgentEvent = {
  ts: string;
  runId: string;
  turn: number;
  kind: "model_call" | "tool_call" | "submit_verdict" | "approval_request" | "decision" | "stop" | "error";
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

export async function appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  const dir = join(RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

export async function readLastEvents(runId: string, count = 50): Promise<AgentEvent[]> {
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
