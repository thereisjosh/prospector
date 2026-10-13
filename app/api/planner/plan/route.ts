import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { compilePlan, PlannerTokenLimitError, type CardSet } from "../../../../src/planner";
import { validateCards } from "../../../../src/planner/cards";
import { demoPlan } from "../../../../src/demo/planner";
import { isDemoMode } from "../../../../src/demo/mode";
import { addVisitorSpend } from "../../../../src/agent/quota";
import { tracePlanner } from "../../../../src/agent/trace";
import { addDailySpend, allowanceResponse, dailyBudgetReached, dailyBudgetResponse, missingWorkspaceResponse, rateLimit, readJsonBody, RequestValidationError, validateSmallShape, workspaceIdFromRequest } from "../../_shared";

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
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    const workspaceId = workspaceIdFromRequest(request, body as Record<string, unknown>);
    if (!workspaceId) return missingWorkspaceResponse();
    const exhausted = await allowanceResponse(workspaceId);
    if (exhausted) return exhausted;
    const client = new Anthropic();
    const result = await tracePlanner(
      "plan",
      workspaceId,
      { cards: validCards.value },
      () => compilePlan(validCards.value, { client }),
      (r) => ({ plan: r.plan, cost: r.cost, estimatedRunCost: r.estimatedRunCost }),
    );
    await addDailySpend(result.cost);
    await addVisitorSpend(workspaceId, result.cost);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RequestValidationError || error instanceof PlannerTokenLimitError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/planner/plan] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
