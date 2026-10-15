import { NextResponse } from "next/server";
import { InvalidIdError } from "../../../../../src/agent/ids";
import { clearMemory, isActiveNote, isActivePreference, isWorkspaceId, loadMemory, type Note, type Preference, type SeenItem } from "../../../../../src/agent/memory";
import { isDemoMode } from "../../../../../src/demo/mode";
import { seedDemoMemory } from "../../../../../src/demo/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

/** How many seen companies the panel gets (newest first); the count covers all of them. */
const SEEN_LIMIT = 50;

export type MemoryResponse = {
  /** Unique companies the gate will skip. */
  seenCount: number;
  /** The last SEEN_LIMIT seen items, newest first. */
  seen: SeenItem[];
  /** Active feedback (not superseded), newest first. */
  preferences: Preference[];
  /** Notes that have not expired, newest first. */
  notes: Note[];
  /** Compatibility: active preferences as "User rejected X: why" lines. */
  preferenceNotes: string[];
};

/** What the UI's "What I remember" panel shows: the lists themselves, with provenance. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    if (!isWorkspaceId(params.id)) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (isDemoMode()) await seedDemoMemory(params.id);
    const memory = await loadMemory(params.id);
    const now = new Date();
    const body: MemoryResponse = {
      seenCount: new Set(memory.seen.map((s) => s.squashed)).size,
      seen: memory.seen.slice(-SEEN_LIMIT).reverse(),
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
