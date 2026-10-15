import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "../agent/config";
import { assertWorkspaceId } from "../agent/ids";
import { updateMemory, type SeenItem } from "../agent/memory";
import { demoDir } from "./mode";

/**
 * The demo workspace's memory: what the recorded run's workspace remembered when the run started.
 *
 * The recording (eval/demo/run/, memory-eval 2026-10-15b S1 rep 2) was the SECOND run in its workspace,
 * so it started with the companies the first run delivered. The harness saved that memory in
 * eval/demo/run/run.json (`memoryBefore`). Seeding a demo workspace with exactly those items makes the
 * replay and the rail agree with the recording: the run recalls the same 7 companies, its two
 * "Skipped …, delivered … in an earlier run" lookups are the recorded ones, and all 8 recorded leads
 * are delivered. Nothing is invented: every item, run id and date is the recording's own.
 * Seeded once per workspace (marker file), so "Clear memory" stays cleared.
 */

type RunRecord = { memoryBefore?: { seen?: SeenItem[] } };

const MARKER = ".demo-seeded";

/** The companies the recorded run's workspace remembered before it started (from run.json). */
export async function recordedMemoryBefore(): Promise<SeenItem[]> {
  try {
    const run = JSON.parse(await readFile(join(demoDir(), "run", "run.json"), "utf8")) as RunRecord;
    return Array.isArray(run.memoryBefore?.seen) ? run.memoryBefore.seen : [];
  } catch {
    return []; // no run record: nothing to remember
  }
}

export async function seedDemoMemory(workspaceId: string, now: Date = new Date()): Promise<void> {
  const dir = join(WORKSPACES_DIR, assertWorkspaceId(workspaceId));
  const marker = join(dir, MARKER);
  try {
    await readFile(marker, "utf8");
    return;
  } catch {
    /* not seeded yet */
  }
  const seen = await recordedMemoryBefore();
  if (seen.length === 0) return;
  await mkdir(dir, { recursive: true });
  await writeFile(marker, now.toISOString(), "utf8");
  await updateMemory(
    workspaceId,
    (memory) => {
      if (memory.seen.length > 0 || memory.notes.length > 0 || memory.preferences.length > 0) return; // real memory wins
      for (const item of seen) memory.seen.push({ ...item });
    },
    now,
  );
}
