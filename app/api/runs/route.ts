import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAgentModel } from "../../../src/agent/config";
import { loadMemory } from "../../../src/agent/memory";
import { createRunState, saveState } from "../../../src/agent/state";
import { validatePlan } from "../../../src/plan";
import { isDemoMode } from "../../../src/demo/mode";
import { createDemoRun } from "../../../src/demo/replay";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const validation = validatePlan(body.plan);
    if (!validation.ok) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : randomUUID();
    if (isDemoMode()) return NextResponse.json(await createDemoRun(workspaceId));
    const memory = await loadMemory(workspaceId);
    const maxCost = Math.min(5, typeof body.maxCostDollars === "number" ? body.maxCostDollars : 1);
    const state = createRunState({
      id: randomUUID(),
      workspaceId,
      plan: validation.plan,
      model: isAgentModel(body.model) ? body.model : undefined,
      targetLeads: typeof body.targetLeads === "number" ? body.targetLeads : undefined,
      maxCostDollars: maxCost,
      preferenceNotes: memory.preferenceNotes,
      seenKeys: memory.seen.map((s) => s.squashed),
    });
    await saveState(state);
    return NextResponse.json({ id: state.id });
  } catch (error) {
    console.error("[api/runs] create failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
