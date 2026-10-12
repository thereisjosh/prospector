import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { InvalidIdError, assertWorkspaceId } from "../../../src/agent/ids";
import { isAgentModel } from "../../../src/agent/config";
import { loadMemory } from "../../../src/agent/memory";
import { createRunState, saveState } from "../../../src/agent/state";
import { validatePlan } from "../../../src/plan";
import { isDemoMode } from "../../../src/demo/mode";
import { createDemoRun } from "../../../src/demo/replay";
import { clampTargetLeads, dailyBudgetReached, rateLimit, readJsonBody, RequestValidationError } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    if (await dailyBudgetReached()) return NextResponse.json({ error: "Daily budget reached." }, { status: 503 });
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const validation = validatePlan(body.plan);
    if (!validation.ok) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : randomUUID();
    assertWorkspaceId(workspaceId);
    if (isDemoMode()) return NextResponse.json(await createDemoRun(workspaceId));
    const memory = await loadMemory(workspaceId);
    const maxCost = Math.min(5, typeof body.maxCostDollars === "number" ? body.maxCostDollars : 1);
    const state = createRunState({
      id: randomUUID(),
      workspaceId,
      plan: validation.plan,
      model: isAgentModel(body.model) ? body.model : undefined,
      targetLeads: clampTargetLeads(body.targetLeads),
      maxCostDollars: maxCost,
      preferenceNotes: memory.preferenceNotes,
      seenKeys: memory.seen.map((s) => s.squashed),
    });
    await saveState(state);
    return NextResponse.json({ id: state.id });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (error instanceof RequestValidationError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs] create failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
