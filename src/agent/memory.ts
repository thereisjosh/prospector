import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./config";
import type { RunState } from "./state";

export type WorkspaceMemory = {
  seen: Array<{ name: string; squashed: string; verdict: string; reason: string; runId: string; at: string }>;
  preferenceNotes: string[];
};

const EMPTY: WorkspaceMemory = { seen: [], preferenceNotes: [] };

import { squashName } from "../gates";
export { squashName };

export async function loadMemory(workspaceId: string): Promise<WorkspaceMemory> {
  try {
    return JSON.parse(await readFile(join(WORKSPACES_DIR, workspaceId, "memory.json"), "utf8")) as WorkspaceMemory;
  } catch {
    return { ...EMPTY, seen: [], preferenceNotes: [] };
  }
}

export async function saveMemory(workspaceId: string, memory: WorkspaceMemory): Promise<void> {
  const dir = join(WORKSPACES_DIR, workspaceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "memory.json"), JSON.stringify(memory, null, 2), "utf8");
}

export async function clearMemory(workspaceId: string): Promise<void> {
  await rm(join(WORKSPACES_DIR, workspaceId, "memory.json"), { force: true });
}

export async function appendRunToMemory(state: RunState): Promise<void> {
  const memory = await loadMemory(state.workspaceId);
  const at = new Date().toISOString();
  for (const lead of state.leads) {
    memory.seen.push({
      name: lead.company,
      squashed: squashName(lead.company),
      verdict: "accepted",
      reason: "accepted",
      runId: state.id,
      at,
    });
  }
  for (const rejection of state.rejected) {
    memory.seen.push({
      name: rejection.company,
      squashed: squashName(rejection.company),
      verdict: "rejected",
      reason: `${rejection.code}: ${rejection.reason}`,
      runId: state.id,
      at,
    });
  }
  await saveMemory(state.workspaceId, memory);
}
