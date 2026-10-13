import { NextResponse } from "next/server";
import { classifyInput, profileFromText, profileSeller, resolveInstagram } from "../../../../src/planner";
import { CostGuard } from "../../../../src/exa";
import { isDemoMode, readDemoJson } from "../../../../src/demo/mode";
import { addVisitorSpend } from "../../../../src/agent/quota";
import { addDailySpend, allowanceResponse, dailyBudgetReached, dailyBudgetResponse, missingWorkspaceResponse, rateLimit, readJsonBody, RequestValidationError, validateSmallShape, workspaceIdFromRequest } from "../../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const body = await readJsonBody(request) as { input?: unknown };
    validateSmallShape(body);
    if (typeof body.input !== "string" || !body.input.trim()) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const classified = classifyInput(body.input);
    if (isDemoMode()) {
      // Demo: one recorded seller. Instagram input shows the recorded "Is this you?" candidates.
      return NextResponse.json(
        await readDemoJson(classified.kind === "instagram" ? "planner/profile-instagram.json" : "planner/profile.json"),
      );
    }
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    const workspaceId = workspaceIdFromRequest(request, body as Record<string, unknown>);
    if (!workspaceId) return missingWorkspaceResponse();
    const exhausted = await allowanceResponse(workspaceId);
    if (exhausted) return exhausted;
    const guard = new CostGuard(0.10);
    if (classified.kind === "instagram") {
      const { candidates } = await resolveInstagram(classified.value, { guard });
      await addDailySpend(guard.spent);
      await addVisitorSpend(workspaceId, guard.spent);
      return NextResponse.json({ kind: "instagram", candidates });
    }
    if (classified.kind === "text") {
      return NextResponse.json({
        kind: "text",
        profile: profileFromText(classified.value),
        needsDescription: false,
        cost: 0,
      });
    }
    const result = await profileSeller(classified.value, { guard });
    await addDailySpend(guard.spent);
    await addVisitorSpend(workspaceId, guard.spent);
    return NextResponse.json({ kind: "url", ...result });
  } catch (error) {
    if (error instanceof RequestValidationError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/planner/profile] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
