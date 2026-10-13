import { NextResponse } from "next/server";
import { appendEvents, readLastEvents, type AgentEvent } from "../../../../../src/agent/events";
import { InvalidIdError, isRunId } from "../../../../../src/agent/ids";
import { addFeedback, isWorkspaceId } from "../../../../../src/agent/memory";
import { PROMPT_VERSION } from "../../../../../src/agent/prompts";
import { loadState } from "../../../../../src/agent/state";

export const runtime = "nodejs";

const REASON_LIMIT = 500;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const body = (await request.json()) as { company?: unknown; verdict?: unknown; reason?: unknown; runId?: unknown; signal_url?: unknown };
    if (typeof body.company !== "string" || !body.company.trim() || (body.verdict !== "up" && body.verdict !== "down")) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    if (body.runId !== undefined && (!isRunId(body.runId) || typeof body.signal_url !== "string" || !body.signal_url.trim())) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const memory = await addFeedback(params.id, {
      company: body.company,
      verdict: body.verdict,
      reason,
    });
    if (typeof body.runId === "string" && typeof body.signal_url === "string") {
      await recordLeadFeedback(params.id, body.runId, {
        company: body.company,
        signalUrl: body.signal_url,
        verdict: body.verdict,
        reason,
      });
    }
    return NextResponse.json({ ok: true, preferenceNotes: memory.preferenceNotes });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/feedback] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

/**
 * Attach a 👍/👎 to the accepted lead it is about: append a `feedback` event to that run's
 * events.jsonl (turn = the lead's turn, toolUseId = its submit_lead call). The trace layer
 * turns the event into a `user_feedback` score on the lead's submit span. Only runs owned
 * by this workspace, only accepted leads; anything else is ignored (the preference note
 * above is still stored).
 */
async function recordLeadFeedback(
  workspaceId: string,
  runId: string,
  feedback: { company: string; signalUrl: string; verdict: "up" | "down"; reason?: string },
): Promise<void> {
  let state;
  try {
    state = await loadState(runId);
  } catch {
    return;
  }
  if (state.workspaceId !== workspaceId) return;
  const lead = state.leads.find((l) => l.signal_url === feedback.signalUrl && l.company.trim().toLowerCase() === feedback.company.trim().toLowerCase())
    ?? state.leads.find((l) => l.signal_url === feedback.signalUrl);
  if (!lead) return;
  const events = await readLastEvents(runId, Number.POSITIVE_INFINITY);
  const submit = findAcceptedSubmit(events, lead.turn, lead.company, lead.signal_url);
  const event: AgentEvent = {
    ts: new Date().toISOString(),
    runId,
    turn: lead.turn,
    kind: "feedback",
    promptVersion: PROMPT_VERSION,
    company: lead.company,
    signal_url: lead.signal_url,
    verdict: feedback.verdict,
    ...(feedback.reason ? { reason: feedback.reason.slice(0, REASON_LIMIT) } : {}),
    ...(submit ? { toolUseId: submit } : {}),
  };
  await appendEvents(runId, [event]);
}

/** The toolUseId of the submit_lead call whose verdict accepted this lead. */
function findAcceptedSubmit(events: AgentEvent[], turn: number, company: string, signalUrl: string): string | undefined {
  for (let i = 0; i < events.length - 1; i += 1) {
    const e = events[i]!;
    const next = events[i + 1]!;
    if (e.turn !== turn || e.kind !== "tool_call" || e.tool !== "submit_lead") continue;
    const input = (e.input ?? {}) as { company?: unknown; signal_url?: unknown };
    if (next.kind !== "submit_verdict" || next.ok !== true) continue;
    if (input.company !== company.slice(0, 200) || input.signal_url !== signalUrl.slice(0, 200)) continue;
    return typeof e.toolUseId === "string" ? e.toolUseId : undefined;
  }
  return undefined;
}
