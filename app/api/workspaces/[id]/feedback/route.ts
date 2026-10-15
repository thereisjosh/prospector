import { NextResponse } from "next/server";
import { appendEvents, readLastEvents, type AgentEvent } from "../../../../../src/agent/events";
import { InvalidIdError, isRunId } from "../../../../../src/agent/ids";
import { addFeedback, isWorkspaceId } from "../../../../../src/agent/memory";
import { PROMPT_VERSION } from "../../../../../src/agent/prompts";
import { loadState } from "../../../../../src/agent/state";
import { findAcceptedSubmit, leadFeedback } from "../../../../../src/agent/online-eval";

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
      ...(typeof body.runId === "string" ? { runId: body.runId, signalUrl: String(body.signal_url) } : {}),
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
 * turns the event into a `user_feedback` score on the lead's submit span, with the reason as
 * the score comment; a 👎 also selects the lead for the online judge and adds its trace to the
 * `review-queue` annotation queue (src/agent/online-eval.ts). Only runs owned
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
  const submit = findAcceptedSubmit(events, lead);
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
  // 👎: judge this lead online (priority, under the daily cap) and queue its trace for review.
  leadFeedback(state, lead, feedback.verdict);
}
