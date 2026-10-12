import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { compilePlan, PlannerTokenLimitError, type CardSet } from "../../../../src/planner";
import { validateCards } from "../../../../src/planner/cards";
import { demoPlan } from "../../../../src/demo/planner";
import { isDemoMode } from "../../../../src/demo/mode";
import { addDailySpend, rateLimit, readJsonBody, RequestValidationError, validateSmallShape } from "../../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const body = await readJsonBody(request) as { cards?: unknown };
    validateSmallShape(body);
    if (!body.cards || typeof body.cards !== "object" || Array.isArray(body.cards)) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const validCards = validateCards(body.cards);
    if (!validCards.ok) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (isDemoMode()) return NextResponse.json(await demoPlan(body.cards as CardSet));
    const client = new Anthropic();
    const result = await compilePlan(validCards.value, { client });
    await addDailySpend(result.cost);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RequestValidationError || error instanceof PlannerTokenLimitError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/planner/plan] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
