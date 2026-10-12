import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { stopRun } from "../../../../../src/agent/loop";
import { loadState, saveState } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoSnapshot } from "../../../../../src/demo/replay";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    assertRunId(params.id);
    // Demo runs replay a fixed recording; there is nothing to stop server-side.
    if (isDemoRunId(params.id)) return NextResponse.json(await demoSnapshot(params.id));
    const state = await loadState(params.id);
    const result = await stopRun(state);
    await saveState(result.state);
    return NextResponse.json({
      status: result.state.status,
      stopReason: result.state.stopReason,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      handback: result.state.handback,
      events: result.events,
    });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs/:id/stop] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
