/**
 * Demo replay of one recorded agent run.
 *
 * Inputs (drop-in, no code changes): eval/demo/run/state.json (the run's final
 * RunState) and eval/demo/run/events.jsonl (every AgentEvent, in order), as
 * written by `eval/run-agent.ts --record`. Each POST /step advances one turn
 * (up to the next model_call, or up to and including an approval_request,
 * which pauses the replay until POST /decision). The snapshot GET /runs/:id
 * returns is rebuilt from the events consumed so far, so leads, rejections and
 * spend appear in the order they were recorded.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "../agent/config";
import type { AgentEvent } from "../agent/events";
import { appendRunToMemory, squashName } from "../agent/memory";
import type { AcceptedLead, Handback, RunState, RunStatus } from "../agent/state";
import { DEMO_RUN_PREFIX, demoDelay, demoDir } from "./mode";

/** The fields of a recorded RunState the replay reads. Extra fields are ignored. */
type RecordedState = {
  id: string;
  createdAt: string;
  model: string;
  contract: RunState["contract"];
  /** Contract as approved before the run. Optional: without it, mid-run snapshots show the final contract. */
  initialContract?: RunState["contract"];
  status: RunStatus;
  stopReason?: string;
  summary?: string;
  spend: RunState["spend"];
  leads: AcceptedLead[];
  rejected: RunState["rejected"];
  todo: string;
  handback?: Handback;
};

type Session = {
  id: string;
  workspaceId: string;
  createdAt: string;
  cursor: number;
  status: RunStatus;
  pending?: { tool: string; input: unknown };
  memoryWritten: boolean;
};

async function loadRecording(): Promise<{ state: RecordedState; events: AgentEvent[] }> {
  const dir = join(demoDir(), "run");
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as RecordedState;
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentEvent);
  return { state, events };
}

const SESSION_FILE = "demo-session.json";
const ID_RE = /^demo-[a-f0-9-]{36}$/;

function sessionPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid demo run id");
  return join(RUNS_DIR, id, SESSION_FILE);
}

async function loadSession(id: string): Promise<Session> {
  return JSON.parse(await readFile(sessionPath(id), "utf8")) as Session;
}

async function saveSession(session: Session): Promise<void> {
  const path = sessionPath(session.id);
  await mkdir(join(RUNS_DIR, session.id), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), "utf8");
}

export async function createDemoRun(workspaceId: string): Promise<{ id: string }> {
  await loadRecording(); // fail fast if the recording is missing
  const session: Session = {
    id: `${DEMO_RUN_PREFIX}${randomUUID()}`,
    workspaceId,
    createdAt: new Date().toISOString(),
    cursor: 0,
    status: "running",
    memoryWritten: false,
  };
  await saveSession(session);
  return { id: session.id };
}

function findLead(state: RecordedState, company: string): AcceptedLead | undefined {
  const key = squashName(company);
  return state.leads.find((lead) => lead.company === company) ?? state.leads.find((lead) => squashName(lead.company) === key);
}

/** Mirrors loop.ts applyScopeChange for the fields the UI shows; invalid values are ignored. */
function applyChange(contract: RunState["contract"], field: unknown, value: unknown): RunState["contract"] {
  const next = { ...contract };
  const r = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (field === "employeeRange" && typeof r.min === "number" && typeof r.max === "number" && r.min <= r.max) {
    next.employeeRange = { min: r.min, max: r.max, unknownPolicy: r.unknownPolicy === "reject" ? "reject" : "allow-if-not-enterprise" };
  } else if (field === "months" && typeof value === "number") {
    next.months = value;
  } else if (field === "hqCountries" && Array.isArray(value)) {
    next.hqCountries = value.filter((v): v is string => typeof v === "string");
  } else if (field === "maxCostDollars" && typeof value === "number") {
    next.maxCostDollars = value;
  }
  return next;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Rebuild what the run looked like after `cursor` events. */
function snapshotAt(session: Session, rec: { state: RecordedState; events: AgentEvent[] }) {
  const consumed = rec.events.slice(0, session.cursor);
  const finished = session.status !== "running" && session.status !== "awaiting_approval";
  const leads: AcceptedLead[] = [];
  const rejected: RunState["rejected"] = [];
  let claude = 0;
  let exa = 0;
  let turns = 0;
  let todo = "";
  let sawTodoCall = false;
  let contract = rec.state.initialContract ?? rec.state.contract;
  let lastApproval: AgentEvent | undefined;
  for (const event of consumed) {
    if (event.kind === "approval_request") lastApproval = event;
    if (event.kind === "decision" && event.approve === true && lastApproval?.tool === "request_scope_change" && rec.state.initialContract) {
      const change = (lastApproval.input as { change?: { field?: unknown; value?: unknown } } | undefined)?.change;
      contract = applyChange(contract, change?.field, event.revisedValue ?? change?.value);
    }
    turns = Math.max(turns, event.turn);
    if (event.kind === "model_call") claude += num(event.claudeCost);
    if (event.kind === "tool_call") {
      exa += num(event.exaCost);
      if (event.tool === "update_todo") {
        sawTodoCall = true;
        const input = event.input as { markdown?: unknown } | undefined;
        if (typeof input?.markdown === "string") todo = input.markdown;
      }
    }
    if (event.kind === "submit_verdict") {
      const company = String(event.company ?? "");
      if (event.ok === true) {
        const lead = findLead(rec.state, company);
        if (lead) leads.push(lead);
      } else {
        rejected.push({ company, code: String(event.code ?? ""), reason: String(event.reason ?? ""), turn: event.turn });
      }
    }
  }
  // Recordings without per-call todo text fall back to the final checklist.
  if (!todo && (sawTodoCall || finished)) todo = rec.state.todo;
  const spend = finished
    ? rec.state.spend
    : { claude, exa, total: claude + exa };
  return {
    id: session.id,
    createdAt: session.createdAt,
    workspaceId: session.workspaceId,
    model: rec.state.model,
    contract: finished ? rec.state.contract : contract,
    status: session.status,
    stopReason: finished ? rec.state.stopReason : undefined,
    summary: finished ? rec.state.summary : undefined,
    spend,
    counters: { turns },
    leads: finished ? rec.state.leads : leads,
    rejected: finished ? rec.state.rejected : rejected,
    todo,
    handback: finished ? rec.state.handback : undefined,
    pendingApproval: session.status === "awaiting_approval" ? session.pending : undefined,
    events: consumed.slice(-50),
    demo: true as const,
  };
}

export async function demoSnapshot(id: string) {
  const [session, rec] = await Promise.all([loadSession(id), loadRecording()]);
  return snapshotAt(session, rec);
}

export async function demoStep(id: string) {
  const [session, rec] = await Promise.all([loadSession(id), loadRecording()]);
  const taken: AgentEvent[] = [];
  if (session.status === "running") {
    await demoDelay();
    let sawModelCall = false;
    while (session.cursor < rec.events.length) {
      const next = rec.events[session.cursor]!;
      if (next.kind === "decision") {
        // A recorded decision whose approval was already answered; skip it.
        session.cursor += 1;
        continue;
      }
      if (next.kind === "model_call" && sawModelCall) break;
      if (next.kind === "model_call") sawModelCall = true;
      taken.push(next);
      session.cursor += 1;
      if (next.kind === "approval_request") {
        session.status = "awaiting_approval";
        session.pending = { tool: String(next.tool ?? ""), input: next.input };
        break;
      }
    }
    if (session.status === "running" && session.cursor >= rec.events.length) {
      session.status = rec.state.status === "running" || rec.state.status === "awaiting_approval" ? "done" : rec.state.status;
    }
    if (session.status !== "running" && session.status !== "awaiting_approval" && !session.memoryWritten) {
      await appendRunToMemory({
        id: session.id,
        workspaceId: session.workspaceId,
        leads: rec.state.leads,
        rejected: rec.state.rejected,
      } as unknown as RunState);
      session.memoryWritten = true;
    }
    await saveSession(session);
  }
  const snap = snapshotAt(session, rec);
  return {
    status: snap.status,
    turn: snap.counters.turns,
    spend: snap.spend,
    leadsCount: snap.leads.length,
    pendingApproval: snap.pendingApproval,
    events: taken,
    handback: snap.handback,
  };
}

export async function demoDecide(id: string, decision: { approve: boolean; note?: string; revisedValue?: unknown }) {
  const [session, rec] = await Promise.all([loadSession(id), loadRecording()]);
  if (session.status !== "awaiting_approval") throw new Error("no pending approval");
  // Skip the recorded decision: the replay continues as recorded, whatever was chosen.
  while (rec.events[session.cursor]?.kind === "decision") session.cursor += 1;
  const last = rec.events[session.cursor - 1];
  const event: AgentEvent = {
    ts: new Date().toISOString(),
    runId: session.id,
    turn: last?.turn ?? 0,
    kind: "decision",
    promptVersion: String(last?.promptVersion ?? "demo"),
    approve: decision.approve,
    note: decision.note,
    revisedValue: decision.revisedValue,
  };
  session.status = "running";
  delete session.pending;
  await saveSession(session);
  const snap = snapshotAt(session, rec);
  return {
    status: snap.status,
    turn: snap.counters.turns,
    spend: snap.spend,
    leadsCount: snap.leads.length,
    events: [event],
  };
}
