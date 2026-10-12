import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { addFeedback, isWorkspaceId } from "../../../../../src/agent/memory";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const body = (await request.json()) as { company?: unknown; verdict?: unknown; reason?: unknown };
    if (typeof body.company !== "string" || !body.company.trim() || (body.verdict !== "up" && body.verdict !== "down")) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const memory = await addFeedback(params.id, {
      company: body.company,
      verdict: body.verdict,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return NextResponse.json({ ok: true, preferenceNotes: memory.preferenceNotes });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/feedback] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
