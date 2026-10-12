import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { clearMemory, isWorkspaceId, loadMemory } from "../../../../../src/agent/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

/** What the UI's "What I remember" panel shows: a count, not the list, plus the notes. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const memory = await loadMemory(params.id);
    const seenCount = new Set(memory.seen.map((s) => s.squashed)).size;
    return NextResponse.json({ seenCount, preferenceNotes: memory.preferenceNotes });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/memory] read failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    await clearMemory(params.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/memory] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
