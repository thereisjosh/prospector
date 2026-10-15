import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../../../src/agent/ids";
import { deleteMemoryItem, isWorkspaceId } from "../../../../../../../src/agent/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Forget one remembered item (a seen company, a piece of feedback, or a note) and nothing else. */
export async function DELETE(_request: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    if (!isWorkspaceId(params.id) || !ITEM_ID.test(params.itemId)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const removed = await deleteMemoryItem(params.id, params.itemId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/memory/items/:itemId] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
