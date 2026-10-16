import { NextResponse } from "next/server";
import { classifyInput, countryFromLocale, profileFromText, profileSeller, resolveToSite } from "../../../../src/planner";
import { CostGuard } from "../../../../src/exa";
import { isDemoMode, readDemoJson } from "../../../../src/demo/mode";
import { addVisitorSpend } from "../../../../src/agent/quota";
import { tracePlanner } from "../../../../src/agent/trace";
import { addDailySpend, allowanceResponse, dailyBudgetReached, dailyBudgetResponse, missingWorkspaceResponse, rateLimit, readJsonBody, RequestValidationError, validateSmallShape, workspaceIdFromRequest } from "../../_shared";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request);
    if (limited) return limited;
    const body = await readJsonBody(request) as { input?: unknown; asName?: unknown };
    validateSmallShape(body);
    if (typeof body.input !== "string" || !body.input.trim()) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    // asName: the seller answered "What's the business called?", so the text is a name whatever its casing.
    const classified = classifyInput(body.input, { asName: body.asName === true });
    if (isDemoMode()) {
      // Demo: one recorded seller. Anything that resolves to candidates shows the recorded "Is this you?"
      // candidates, labelled with the real source so the heading still names the platform.
      if (classified.kind === "social" || classified.kind === "biolink" || classified.kind === "maps" || classified.kind === "name") {
        const fixture = await readDemoJson("planner/profile-instagram.json") as Record<string, unknown>;
        return NextResponse.json({
          ...fixture,
          source: classified.kind,
          ...(classified.kind === "social" || classified.kind === "biolink" ? { platform: classified.platform } : { platform: undefined }),
        });
      }
      return NextResponse.json(await readDemoJson("planner/profile.json"));
    }
    if (await dailyBudgetReached()) return dailyBudgetResponse();
    const workspaceId = workspaceIdFromRequest(request, body as Record<string, unknown>);
    if (!workspaceId) return missingWorkspaceResponse();
    const exhausted = await allowanceResponse(workspaceId);
    if (exhausted) return exhausted;
    const guard = new CostGuard(0.10);
    if (classified.kind === "unusable") {
      return NextResponse.json({ kind: "unusable", reason: classified.reason });
    }
    if (classified.kind === "social" || classified.kind === "biolink" || classified.kind === "maps" || classified.kind === "name") {
      const resolved = await tracePlanner(
        "profile",
        workspaceId,
        { kind: classified.kind, input: classified.value },
        () => resolveToSite(classified, { guard, countryHint: countryFromLocale(request.headers.get("x-locale")) }),
        (r) => ({ kind: "candidates", source: r.source, platform: r.platform, candidates: r.candidates.length, askName: r.askName === true, exaCost: guard.spent }),
      );
      await addDailySpend(guard.spent);
      await addVisitorSpend(workspaceId, guard.spent);
      return NextResponse.json({
        kind: "candidates",
        source: resolved.source,
        ...(resolved.platform ? { platform: resolved.platform } : {}),
        candidates: resolved.candidates,
        ...(resolved.askName ? { askName: true } : {}),
      });
    }
    if (classified.kind === "text") {
      return NextResponse.json({
        kind: "text",
        profile: profileFromText(classified.value),
        needsDescription: false,
        cost: 0,
      });
    }
    const result = await tracePlanner(
      "profile",
      workspaceId,
      { kind: "url", input: classified.value },
      () => profileSeller(classified.value, { guard }),
      (r) => ({ kind: "url", profile: r.profile, needsDescription: r.needsDescription, cost: r.cost }),
    );
    await addDailySpend(guard.spent);
    await addVisitorSpend(workspaceId, guard.spent);
    return NextResponse.json({ kind: "url", ...result });
  } catch (error) {
    if (error instanceof RequestValidationError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/planner/profile] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
