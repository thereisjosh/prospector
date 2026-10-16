import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../src/agent/ids";
import { readLastEvents } from "../../../../src/agent/events";
import { loadState, screenedByCode } from "../../../../src/agent/state";
import { isDemoRunId } from "../../../../src/demo/mode";
import { demoSnapshot } from "../../../../src/demo/replay";
import { rateLimit, requireRunOwner } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const owner = await requireRunOwner(request, params.id);
    if (owner instanceof NextResponse) return owner;
    if (isDemoRunId(params.id)) return NextResponse.json(await demoSnapshot(params.id));
    const state = await loadState(params.id);
    const events = await readLastEvents(params.id, 50);
    return NextResponse.json({
      id: state.id,
      createdAt: state.createdAt,
      workspaceId: state.workspaceId,
      model: state.model,
      contract: state.contract,
      status: state.status,
      stopReason: state.stopReason,
      spend: state.spend,
      counters: state.counters,
      leads: state.leads,
      // TODO(contract): state.candidates is added by the engine; old runs have none.
      candidates: (state as { candidates?: unknown[] }).candidates ?? [],
      rejected: state.rejected,
      screened: screenedByCode(state),
      todo: state.todo,
      summary: state.summary,
      strategyApproved: state.strategyApproved,
      initialContract: state.initialContract,
      handback: state.handback,
      pendingApproval: state.pendingApproval,
      events,
    });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs/:id] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
