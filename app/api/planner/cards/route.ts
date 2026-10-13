import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { PlannerTokenLimitError, suggestCards, type SellerProfile } from "../../../../src/planner";
import { isDemoMode, readDemoJson } from "../../../../src/demo/mode";
import { addVisitorSpend } from "../../../../src/agent/quota";
import { tracePlanner } from "../../../../src/agent/trace";
import { addDailySpend, allowanceResponse, dailyBudgetReached, dailyBudgetResponse, missingWorkspaceResponse, rateLimit, readJsonBody, RequestValidationError, validateSmallShape, workspaceIdFromRequest } from "../../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const body = await readJsonBody(request) as { profile?: unknown };
    validateSmallShape(body);
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    if (isDemoMode()) return NextResponse.json(await readDemoJson("planner/cards.json"));
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    const workspaceId = workspaceIdFromRequest(request, body as Record<string, unknown>);
    if (!workspaceId) return missingWorkspaceResponse();
    const exhausted = await allowanceResponse(workspaceId);
    if (exhausted) return exhausted;
    const client = new Anthropic();
    const result = await tracePlanner(
      "cards",
      workspaceId,
      { profile: body.profile },
      () => suggestCards(body.profile as SellerProfile, { client }),
      (r) => ({ cards: r.cards, cost: r.cost }),
    );
    await addDailySpend(result.cost);
    await addVisitorSpend(workspaceId, result.cost);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RequestValidationError || error instanceof PlannerTokenLimitError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/planner/cards] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
