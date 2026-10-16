/**
 * Demo replay of one recorded agent run (today: memory-eval 2026-10-15b S1 rep 2, see docs/DEMO.md).
 *
 * Inputs (drop-in, no code changes): eval/demo/run/state.json (the run's final
 * RunState) and eval/demo/run/events.jsonl (every AgentEvent, in order), as
 * written by `eval/run-agent.ts --record`. Each POST /step advances one turn
 * (up to the next model_call, or up to and including an approval_request,
 * which pauses the replay until POST /decision). The snapshot GET /runs/:id
 * returns is rebuilt from the events consumed so far, so leads, rejections and
 * spend appear in the order they were recorded.
 *
 * Live view: a step writes the events it replays to the demo run's own events.jsonl as it paces
 * them (runs/<demo-id>/events.jsonl, with seq), so GET /api/runs/:id/events streams the demo line
 * by line exactly as it streams a live run. Recordings made before `tool_started` existed get one
 * per tool call, derived from that call (same tool, id and input): a parallel batch's starts right
 * after the model call, a submit_lead's just before it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNS_DIR } from "../agent/config";
import { appendEventLines, type AgentEvent } from "../agent/events";
import { appendRunToMemory, loadMemory, NOTE_TTL_MS, squashName } from "../agent/memory";
import type { SeenInfo } from "../agent/recall";
import { screenedByCode, type AcceptedLead, type CandidateLead, type Handback, type RunState, type RunStatus } from "../agent/state";
import { seedDemoMemory } from "./memory";
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
  candidates?: CandidateLead[];
  rejected: RunState["rejected"];
  /** Lookup-stage screening (newer recordings); each item carries the turn it happened in. */
  screened?: RunState["screened"];
  todo: string;
  handback?: Handback;
  /** Self-notes the recorded run saved with `remember`; promoted to the workspace's notes when the replay ends. */
  notes?: RunState["notes"];
};

type Session = {
  id: string;
  workspaceId: string;
  createdAt: string;
  cursor: number;
  status: RunStatus;
  pending?: { tool: string; input: unknown };
  memoryWritten: boolean;
  /** What the workspace remembered when this run started, by squashed company name (see applySeen). */
  seen?: Record<string, SeenInfo>;
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

/** Owner and status of a demo run (for the live event stream); undefined when it does not exist. */
export async function demoRunAccess(id: string): Promise<{ workspaceId: string; status: RunStatus } | undefined> {
  try {
    const session = await loadSession(id);
    return { workspaceId: session.workspaceId, status: session.status };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Pause before each replayed tool call lands, so the live view shows calls resolving one by one. */
export const DEMO_TOOL_MS = 300;

function startedFor(call: AgentEvent): AgentEvent {
  return {
    ts: new Date().toISOString(),
    runId: call.runId,
    turn: call.turn,
    kind: "tool_started",
    promptVersion: call.promptVersion,
    tool: call.tool,
    toolUseId: call.toolUseId,
    input: call.input,
  };
}

/**
 * How one step's replayed events land, as a live turn would write them: the model call together
 * with its parallel batch's tool_started lines, then each tool call after DEMO_TOOL_MS (a
 * submit_lead's start just before it). Recordings that already carry tool_started keep theirs.
 * Pure: the order of the recording is never changed, only starts are added.
 */
export function pacedSchedule(taken: AgentEvent[]): Array<{ delayMs: number; events: AgentEvent[] }> {
  const out: Array<{ delayMs: number; events: AgentEvent[] }> = [];
  const started = new Set(taken.filter((e) => e.kind === "tool_started").map((e) => String(e.toolUseId)));
  const needsStart = (e: AgentEvent) => e.kind === "tool_call" && typeof e.toolUseId === "string" && !started.has(e.toolUseId);
  for (let i = 0; i < taken.length; i += 1) {
    const event = taken[i]!;
    if (event.kind === "model_call") {
      const batch = taken.slice(i + 1).filter((e) => e.turn === event.turn && e.tool !== "submit_lead" && needsStart(e));
      for (const e of batch) started.add(String(e.toolUseId));
      out.push({ delayMs: 0, events: [event, ...batch.map(startedFor)] });
    } else if (event.kind === "tool_call") {
      if (needsStart(event)) {
        started.add(String(event.toolUseId));
        out.push({ delayMs: 0, events: [startedFor(event)] });
      }
      out.push({ delayMs: DEMO_TOOL_MS, events: [event] });
    } else {
      out.push({ delayMs: 0, events: [event] });
    }
  }
  return out;
}

/** Write one step's events to the demo run's events.jsonl on that schedule; returns them (with seq), in order. */
async function writePaced(id: string, taken: AgentEvent[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (const { delayMs, events } of pacedSchedule(taken)) {
    if (delayMs > 0) await demoDelay(delayMs);
    await appendEventLines(id, events);
    out.push(...events);
  }
  return out;
}

async function saveSession(session: Session): Promise<void> {
  const path = sessionPath(session.id);
  await mkdir(join(RUNS_DIR, session.id), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), "utf8");
}

export async function createDemoRun(workspaceId: string): Promise<{ id: string }> {
  await loadRecording(); // fail fast if the recording is missing
  await seedDemoMemory(workspaceId); // the demo's second state: a workspace that already remembers part of the recording
  const memory = await loadMemory(workspaceId);
  const seen: Record<string, SeenInfo> = {};
  for (const item of memory.seen) seen[item.squashed] ??= { name: item.name, verdict: item.verdict, at: item.at, runId: item.runId };
  const session: Session = {
    id: `${DEMO_RUN_PREFIX}${randomUUID()}`,
    workspaceId,
    createdAt: new Date().toISOString(),
    cursor: 0,
    status: "running",
    memoryWritten: false,
    seen,
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

/**
 * The recording is replayed as recorded, except where this workspace already remembers a company
 * the recorded agent looked up: there the real run would not have paid for the lookup nor submitted
 * the company (lookup_company skips seen names; the gate would reject the submit as `already_seen`).
 * So its lookup becomes a "skipped, lookup saved" event, and its submit_lead / accepted verdict are
 * dropped. Nothing is invented: every company and event comes from the recording.
 * `events` is parallel to the recording (null = dropped) so the replay cursor still indexes the raw list.
 */
function applySeen(rec: { state: RecordedState; events: AgentEvent[] }, seen: Record<string, SeenInfo>) {
  const nameOf = (event: AgentEvent, field: "name" | "company") => {
    const raw = field === "name" ? (event.input as { name?: unknown } | undefined)?.name : (event.input as { company?: unknown } | undefined)?.company;
    return typeof raw === "string" ? raw : undefined;
  };
  let savedExa = 0;
  const screened: NonNullable<RunState["screened"]> = [];
  const skippedKeys = new Set<string>();
  const recordedScreened = new Set((rec.state.screened ?? []).map((s) => squashName(s.company)));
  const events = rec.events.map((event): AgentEvent | null => {
    // A lookup the recorded run already skipped from its own memory is replayed as recorded.
    const recordedSkip = event.seen !== undefined && event.seen !== null && typeof event.seen === "object";
    if (event.kind === "tool_call" && event.tool === "lookup_company" && event.is_error !== true && !recordedSkip) {
      const name = nameOf(event, "name");
      const info = name ? seen[squashName(name)] : undefined;
      if (name && info) {
        savedExa += num(event.exaCost);
        skippedKeys.add(squashName(name));
        if (!recordedScreened.has(squashName(name)) && !screened.some((s) => squashName(s.company) === squashName(name))) {
          screened.push({ company: name, code: "already_seen", reason: "company was delivered or rejected in an earlier run", turn: event.turn, stage: "lookup" });
        }
        return { ...event, exaCost: 0, resultSummary: `skipped_seen: ${name}`, seen: info, lookupSaved: true };
      }
    }
    if (event.kind === "tool_call" && event.tool === "submit_lead") {
      const name = nameOf(event, "company");
      if (name && seen[squashName(name)]) return null;
    }
    if (event.kind === "submit_verdict" && typeof event.company === "string" && seen[squashName(event.company)]) return null;
    return event;
  });
  return { events, savedExa, screened, skippedKeys };
}

/** Rebuild what the run looked like after `cursor` events. */
function snapshotAt(session: Session, rec: { state: RecordedState; events: AgentEvent[] }) {
  const fx = applySeen(rec, session.seen ?? {});
  const consumed = fx.events.slice(0, session.cursor).filter((e): e is AgentEvent => e !== null);
  const finished = session.status !== "running" && session.status !== "awaiting_approval";
  const leads: AcceptedLead[] = [];
  const candidates: CandidateLead[] = [];
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
  const finishedLeads = rec.state.leads.filter((l) => !(session.seen ?? {})[squashName(l.company)]);
  const spend = finished
    ? { ...rec.state.spend, exa: Math.max(0, rec.state.spend.exa - fx.savedExa), total: Math.max(0, rec.state.spend.total - fx.savedExa) }
    : { claude, exa, total: claude + exa };
  const handback =
    finished && rec.state.handback
      ? { ...rec.state.handback, shortfall: rec.state.handback.shortfall.replace(/^\d+(?= of \d+$)/, String(finishedLeads.length)) }
      : undefined;
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
    leads: finished ? finishedLeads : leads,
    candidates: finished ? rec.state.candidates ?? [] : candidates,
    rejected: finished ? rec.state.rejected : rejected,
    // Same grouped shape as the live GET /api/runs/:id.
    screened: screenedByCode({ screened: [...(rec.state.screened ?? []), ...fx.screened].filter((s) => finished || s.turn <= turns) }),
    todo,
    handback,
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
  const fx = applySeen(rec, session.seen ?? {});
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
      const shown = fx.events[session.cursor];
      if (shown) taken.push(shown);
      session.cursor += 1;
      if (next.kind === "approval_request") {
        session.status = "awaiting_approval";
        session.pending = { tool: String(next.tool ?? ""), input: next.input };
        break;
      }
    }
    taken.splice(0, taken.length, ...(await writePaced(id, taken)));
    if (session.status === "running" && session.cursor >= rec.events.length) {
      session.status = rec.state.status === "running" || rec.state.status === "awaiting_approval" ? "done" : rec.state.status;
    }
    if (session.status !== "running" && session.status !== "awaiting_approval" && !session.memoryWritten) {
      await appendRunToMemory({
        id: session.id,
        workspaceId: session.workspaceId,
        // The recorded run's plan, so its entries carry the same search scope as the seeded ones.
        initialContract: rec.state.initialContract ?? rec.state.contract,
        leads: rec.state.leads.filter((l) => !(session.seen ?? {})[squashName(l.company)]),
        rejected: rec.state.rejected,
        // The recorded note, saved by this replayed run: same provenance and clock as its leads above
        // (appendRunToMemory stamps those now / session.id), so it never expires mid-demo-life.
        notes: (rec.state.notes ?? []).map((n) => ({ ...n, runId: session.id, at: new Date().toISOString(), expiresAt: new Date(Date.now() + NOTE_TTL_MS).toISOString() })),
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
  await appendEventLines(id, [event]);
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
