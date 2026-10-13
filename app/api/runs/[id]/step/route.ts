import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { checkLead } from "../../../../../src/gates";
import { allowanceHandback, step } from "../../../../../src/agent/loop";
import { addVisitorSpend, dollarsExhausted, loadQuota } from "../../../../../src/agent/quota";
import { loadState, RunBusyError, saveState, StaleStateError, withRunLock } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoStep } from "../../../../../src/demo/replay";
import { addDailySpend, dailyBudgetReached, dailyBudgetResponse, rateLimit } from "../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    assertRunId(params.id);
    if (isDemoRunId(params.id)) return NextResponse.json(await demoStep(params.id));
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    const response = await withRunLock(params.id, async () => {
      const state = await loadState(params.id);
      const loadedVersion = state.version;
      const quota = await loadQuota(state.workspaceId);
      if (dollarsExhausted(quota) && state.status === "running") {
        state.handback ??= allowanceHandback(state);
        state.status = "stopped";
        state.stopReason = "visitor_allowance";
        await saveState(state, loadedVersion);
        return routeStepResponse(state);
      }
      const before = state.spend.total;
      const result = await step(state, { client: new Anthropic(), checkLead });
      const delta = Math.max(0, result.state.spend.total - before);
      await addDailySpend(delta);
      const updatedQuota = await addVisitorSpend(result.state.workspaceId, delta);
      if (dollarsExhausted(updatedQuota) && result.state.status === "running") {
        result.state.handback ??= allowanceHandback(result.state);
        result.state.status = "stopped";
        result.state.stopReason = "visitor_allowance";
      }
      await saveState(result.state, loadedVersion);
      return routeStepResponse(result.state, result.events);
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof StaleStateError || error instanceof RunBusyError) return NextResponse.json({ error: "Run is busy." }, { status: 409 });
    console.error("[api/runs/:id/step] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

function routeStepResponse(state: Awaited<ReturnType<typeof loadState>>, events: unknown[] = []) {
  return {
    status: state.status,
    turn: state.counters.turns,
    spend: state.spend,
    leadsCount: state.leads.length,
    pendingApproval: state.pendingApproval,
    events,
    handback: state.handback,
  };
}
