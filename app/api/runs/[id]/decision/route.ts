import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { decide } from "../../../../../src/agent/loop";
import { loadState, RunBusyError, saveState, StaleStateError, withRunLock } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoDecide } from "../../../../../src/demo/replay";
import { rateLimit, readJsonBody, RequestValidationError } from "../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    assertRunId(params.id);
    const body = (await readJsonBody(request)) as { approve?: unknown; note?: unknown; revisedValue?: unknown; toolUseId?: unknown };
    if (isDemoRunId(params.id)) {
      return NextResponse.json(
        await demoDecide(params.id, {
          approve: body.approve === true,
          note: typeof body.note === "string" ? body.note : undefined,
          revisedValue: body.revisedValue,
        }),
      );
    }
    const response = await withRunLock(params.id, async () => {
      const state = await loadState(params.id);
      if (state.status !== "awaiting_approval" || typeof body.toolUseId !== "string" || state.pendingApproval?.toolUseId !== body.toolUseId) {
        return NextResponse.json({ error: "Run is busy." }, { status: 409 });
      }
      const loadedVersion = state.version;
      const result = await decide(state, {
      approve: body.approve === true,
      note: typeof body.note === "string" ? body.note : undefined,
      revisedValue: body.revisedValue,
      toolUseId: body.toolUseId,
      });
      await saveState(result.state, loadedVersion);
      return NextResponse.json({
      status: result.state.status,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      events: result.events,
      });
    });
    return response;
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof RequestValidationError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof StaleStateError || error instanceof RunBusyError) return NextResponse.json({ error: "Run is busy." }, { status: 409 });
    console.error("[api/runs/:id/decision] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
