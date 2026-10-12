import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { checkLead } from "../../../../../src/gates";
import { step } from "../../../../../src/agent/loop";
import { loadState, RunBusyError, saveState, StaleStateError, withRunLock } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoStep } from "../../../../../src/demo/replay";
import { addDailySpend, dailyBudgetReached, rateLimit } from "../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    assertRunId(params.id);
    if (await dailyBudgetReached()) return NextResponse.json({ error: "Daily budget reached." }, { status: 503 });
    if (isDemoRunId(params.id)) return NextResponse.json(await demoStep(params.id));
    const response = await withRunLock(params.id, async () => {
      const state = await loadState(params.id);
      const before = state.spend.total;
      const loadedVersion = state.version;
      const result = await step(state, { client: new Anthropic(), checkLead });
      await saveState(result.state, loadedVersion);
      await addDailySpend(Math.max(0, result.state.spend.total - before));
      return {
      status: result.state.status,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      pendingApproval: result.state.pendingApproval,
      events: result.events,
      handback: result.state.handback,
      };
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof StaleStateError || error instanceof RunBusyError) return NextResponse.json({ error: "Run is busy." }, { status: 409 });
    console.error("[api/runs/:id/step] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
