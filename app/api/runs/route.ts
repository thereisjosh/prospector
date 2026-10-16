import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { InvalidIdError, assertWorkspaceId } from "../../../src/agent/ids";
import { isAgentModel, providerOf } from "../../../src/agent/config";
import { loadMemory } from "../../../src/agent/memory";
import { RECALL_BUDGET_TOKENS, recall } from "../../../src/agent/recall";
import { releaseLiveRun, reserveLiveRun } from "../../../src/agent/quota";
import { createRunState, saveState } from "../../../src/agent/state";
import { validatePlan } from "../../../src/plan";
import { isDemoMode } from "../../../src/demo/mode";
import { createDemoRun } from "../../../src/demo/replay";
import { allowanceDeniedResponse, clampTargetLeads, dailyBudgetReached, dailyBudgetResponse, missingWorkspaceResponse, rateLimit, readJsonBody, RequestValidationError, workspaceIdFrom } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const validation = validatePlan(body.plan);
    if (!validation.ok) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const workspaceId = workspaceIdFrom(body.workspaceId);
    // Demo runs belong to the caller's workspace too: every run route checks ownership, so a demo run
    // created under a made-up workspace would be unreachable.
    if (!workspaceId) return missingWorkspaceResponse();
    if (body.mode === "demo" || isDemoMode()) return NextResponse.json(await createDemoRun(workspaceId));
    assertWorkspaceId(workspaceId);
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    // Atomic check-and-reserve: two concurrent requests cannot both pass the allowance check.
    const reservation = await reserveLiveRun(workspaceId);
    if (!reservation.ok) return allowanceDeniedResponse(reservation.quota);
    try {
      const memory = await loadMemory(workspaceId);
      const maxCost = Math.min(5, typeof body.maxCostDollars === "number" ? body.maxCostDollars : 1);
      const state = createRunState({
        id: randomUUID(),
        workspaceId,
        plan: validation.plan,
        // The public app runs Anthropic models only; kimi-k2.6 is an eval-CLI model (docs/RESEARCH-kimi.md).
        model: isAgentModel(body.model) && providerOf(body.model) === "anthropic" ? body.model : undefined,
        targetLeads: clampTargetLeads(body.targetLeads),
        maxCostDollars: maxCost,
        // Memory reaches the run only through recall(): all seen keys, plus the ranked preferences and notes.
        recalled: recall(memory, validation.plan, { budgetTokens: RECALL_BUDGET_TOKENS, now: new Date() }),
      });
      await saveState(state);
      return NextResponse.json({ id: state.id });
    } catch (error) {
      await releaseLiveRun(workspaceId).catch(() => undefined); // the run was never created
      throw error;
    }
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof RequestValidationError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs] create failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
