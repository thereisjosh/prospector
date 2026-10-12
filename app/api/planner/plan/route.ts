import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { compilePlan, type CardSet } from "../../../../src/planner";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cards?: unknown };
    if (!body.cards || typeof body.cards !== "object" || Array.isArray(body.cards)) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const client = new Anthropic();
    const result = await compilePlan(body.cards as CardSet, { client });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/planner/plan] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
