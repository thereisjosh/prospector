import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { decide } from "../../../../../src/agent/loop";
import { loadState, saveState } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoDecide } from "../../../../../src/demo/replay";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    assertRunId(params.id);
    const body = (await request.json()) as { approve?: unknown; note?: unknown; revisedValue?: unknown };
    if (isDemoRunId(params.id)) {
      return NextResponse.json(
        await demoDecide(params.id, {
          approve: body.approve === true,
          note: typeof body.note === "string" ? body.note : undefined,
          revisedValue: body.revisedValue,
        }),
      );
    }
    const state = await loadState(params.id);
    const result = await decide(state, {
      approve: body.approve === true,
      note: typeof body.note === "string" ? body.note : undefined,
      revisedValue: body.revisedValue,
    });
    await saveState(result.state);
    return NextResponse.json({
      status: result.state.status,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      events: result.events,
    });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs/:id/decision] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
