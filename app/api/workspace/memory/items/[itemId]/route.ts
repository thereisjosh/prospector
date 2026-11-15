import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../../src/agent/ids";
import { deleteMemoryItem } from "../../../../../../src/agent/memory";
import { missingWorkspaceResponse, workspaceIdFromRequest } from "../../../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Forget one remembered item (a seen company, a piece of feedback, or a note) and nothing else. */
export async function DELETE(request: Request, { params }: { params: { itemId: string; id?: string } }) {
  try {
    const workspaceId = workspaceIdFromRequest(request);
    if (!workspaceId) return missingWorkspaceResponse();
    if (!ITEM_ID.test(params.itemId)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const removed = await deleteMemoryItem(workspaceId, params.itemId);
    if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspace/memory/items/:itemId] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
