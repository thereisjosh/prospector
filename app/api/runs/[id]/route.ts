import { NextResponse } from "next/server";
import { readLastEvents } from "../../../../src/agent/events";
import { loadState } from "../../../../src/agent/state";
import { isDemoRunId } from "../../../../src/demo/mode";
import { demoSnapshot } from "../../../../src/demo/replay";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
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
      rejected: state.rejected,
      todo: state.todo,
      handback: state.handback,
      pendingApproval: state.pendingApproval,
      events,
    });
  } catch (error) {
    console.error("[api/runs/:id] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
