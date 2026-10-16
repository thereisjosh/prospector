import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { clearMemory, deleteSeenGroup, groupSeen, isActiveNote, isActivePreference, isWorkspaceId, loadMemory, type Note, type Preference, type SeenGroup } from "../../../../../src/agent/memory";
import { isDemoMode } from "../../../../../src/demo/mode";
import { seedDemoMemory } from "../../../../../src/demo/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

const KEY = /^[A-Za-z0-9_-]{1,40}$/;

export type MemoryResponse = {
  /** Unique live companies across all searches. */
  seenCount: number;
  /** Seen companies grouped by search (live entries only), the current search first; items newest first, capped per group. */
  groups: SeenGroup[];
  /** Active feedback (not superseded), newest first. */
  preferences: Preference[];
  /** Notes that have not expired, newest first. */
  notes: Note[];
  /** Compatibility: active preferences as "User rejected X: why" lines. */
  preferenceNotes: string[];
};

/** What the UI's "What I remember" panel shows: the lists themselves, with provenance. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (isDemoMode()) await seedDemoMemory(params.id);
    const memory = await loadMemory(params.id);
    const now = new Date();
    // `?planKey=` names the search the user is on; without it the most recently touched group is current.
    const asked = new URL(request.url).searchParams.get("planKey");
    const groups = groupSeen(memory.seen, now, asked && KEY.test(asked) ? asked : undefined);
    const body: MemoryResponse = {
      seenCount: groups.reduce((n, g) => n + g.count, 0),
      groups,
      preferences: memory.preferences.filter(isActivePreference).reverse(),
      notes: memory.notes.filter((n) => isActiveNote(n, now)).reverse(),
      preferenceNotes: memory.preferenceNotes,
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/memory] read failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}

/** DELETE clears everything; DELETE ?search=<planKey> forgets only that search's companies. */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const search = new URL(request.url).searchParams.get("search");
    if (search !== null) {
      if (!KEY.test(search)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
      const removed = await deleteSeenGroup(params.id, search);
      return removed > 0 ? NextResponse.json({ ok: true, removed }) : NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await clearMemory(params.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof InvalidIdError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    console.error("[api/workspaces/:id/memory] failed:", error);
    return NextResponse.json({ error: "Request failed." }, { status: 500 });
  }
}
