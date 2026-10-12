import { NextResponse } from "next/server";
import { classifyInput, profileFromText, profileSeller, resolveInstagram } from "../../../../src/planner";
import { CostGuard } from "../../../../src/exa";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { input?: unknown };
    if (typeof body.input !== "string" || !body.input.trim()) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const classified = classifyInput(body.input);
    const guard = new CostGuard(0.10);
    if (classified.kind === "instagram") {
      const { candidates } = await resolveInstagram(classified.value, { guard });
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
    return NextResponse.json({ kind: "url", ...result });
  } catch (error) {
    console.error("[api/planner/profile] request failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
