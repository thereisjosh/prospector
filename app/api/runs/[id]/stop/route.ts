import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { stopRun } from "../../../../../src/agent/loop";
import { loadState, RunBusyError, saveState, StaleStateError, withRunLock } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoSnapshot } from "../../../../../src/demo/replay";
import { rateLimit, requireRunOwner } from "../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const owner = await requireRunOwner(request, params.id);
    if (owner instanceof NextResponse) return owner;
    // Demo runs replay a fixed recording; there is nothing to stop server-side.
    if (isDemoRunId(params.id)) return NextResponse.json(await demoSnapshot(params.id));
    const response = await withRunLock(params.id, async () => {
      const state = await loadState(params.id);
      const loadedVersion = state.version;
      const result = await stopRun(state);
      await saveState(result.state, loadedVersion);
      return {
      status: result.state.status,
      stopReason: result.state.stopReason,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      handback: result.state.handback,
      events: result.events,
      };
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof RunBusyError) {
      const state = await loadState(params.id);
      const loadedVersion = state.version;
      if (state.status === "running") {
        state.stopRequested = true;
        await saveState(state, loadedVersion);
        return NextResponse.json({ status: state.status, stopRequested: true });
      }
      return NextResponse.json({ error: "Run is busy." }, { status: 409 });
    }
    if (error instanceof StaleStateError) return NextResponse.json({ error: "Run is busy." }, { status: 409 });
    console.error("[api/runs/:id/stop] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
