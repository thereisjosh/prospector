import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { InvalidIdError, assertRunId } from "../../../../../src/agent/ids";
import { checkLead } from "../../../../../src/gates";
import { step } from "../../../../../src/agent/loop";
import { loadState, saveState } from "../../../../../src/agent/state";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { demoStep } from "../../../../../src/demo/replay";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    assertRunId(params.id);
    if (isDemoRunId(params.id)) return NextResponse.json(await demoStep(params.id));
    const state = await loadState(params.id);
    const result = await step(state, { client: new Anthropic(), checkLead });
    await saveState(result.state);
    return NextResponse.json({
      status: result.state.status,
      turn: result.state.counters.turns,
      spend: result.state.spend,
      leadsCount: result.state.leads.length,
      pendingApproval: result.state.pendingApproval,
      events: result.events,
      handback: result.state.handback,
    });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/runs/:id/step] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
