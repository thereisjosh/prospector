import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "../agent/config";
import { assertWorkspaceId } from "../agent/ids";
import { NOTE_TTL_MS, squashName, updateMemory } from "../agent/memory";
import { demoDir } from "./mode";

/**
 * The demo's second workspace state: a workspace that already remembers part of the recorded run.
 *
 * Built only from the recording itself (eval/demo/run/state.json), never invented:
 *  - `seen`: the recording's first and last accepted leads, with the recording's run id, date and
 *    signal URL, as if an earlier run had delivered them. A demo run in this workspace therefore
 *    skips them (src/demo/replay.ts), the way the real gate would.
 *  - one self-note, worded from the recording's own checklist ("new-warehouse news ... (good); ... job ads
 *    (mostly large firms)"), so the panel shows an episodic item with provenance and an expiry.
 * Seeded once per workspace (marker file), so "Clear memory" stays cleared.
 */

type Recording = {
  id: string;
  createdAt: string;
  contract: { signalTypes: string[]; gateFields: Array<{ key: string }> };
  leads: Array<{ company: string; signal_url: string }>;
};

const MARKER = ".demo-seeded";

export const DEMO_SEEDED_NOTE_TEXT = "New-warehouse news worked well for this kind of search; job-ad searches mostly surfaced large firms.";

export async function seedDemoMemory(workspaceId: string, now: Date = new Date()): Promise<void> {
  const dir = join(WORKSPACES_DIR, assertWorkspaceId(workspaceId));
  const marker = join(dir, MARKER);
  try {
    await readFile(marker, "utf8");
    return;
  } catch {
    /* not seeded yet */
  }
  let rec: Recording;
  try {
    rec = JSON.parse(await readFile(join(demoDir(), "run", "state.json"), "utf8")) as Recording;
  } catch {
    return; // no recording, nothing to remember
  }
  await mkdir(dir, { recursive: true });
  await writeFile(marker, now.toISOString(), "utf8");
  const picked = [rec.leads[0], rec.leads.length > 1 ? rec.leads[rec.leads.length - 1] : undefined].filter(
    (l): l is Recording["leads"][number] => !!l,
  );
  await updateMemory(
    workspaceId,
    (memory) => {
      if (memory.seen.length > 0 || memory.notes.length > 0 || memory.preferences.length > 0) return; // real memory wins
      for (const lead of picked) {
        const index = rec.leads.indexOf(lead);
        memory.seen.push({
          id: `demo_seen_${index}`,
          name: lead.company,
          squashed: squashName(lead.company),
          verdict: "accepted",
          reason: "accepted",
          runId: rec.id,
          at: rec.createdAt,
          signalUrl: lead.signal_url,
          leadIndex: index,
        });
      }
      memory.notes.push({
        id: "demo_note_1",
        text: DEMO_SEEDED_NOTE_TEXT,
        tags: [...rec.contract.gateFields.map((g) => g.key), ...rec.contract.signalTypes.slice(0, 2)].slice(0, 6),
        runId: rec.id,
        at: rec.createdAt,
        expiresAt: new Date(now.getTime() + NOTE_TTL_MS).toISOString(),
      });
    },
    now,
  );
}
