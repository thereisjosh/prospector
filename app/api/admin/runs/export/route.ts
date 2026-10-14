import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { resolveDataDirs } from "../../../../../src/agent/config";
import { isRunId } from "../../../../../src/agent/ids";
import { isDemoRunId } from "../../../../../src/demo/mode";
import { requireAdmin } from "../../_auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRIP_STATE_KEYS = new Set(["messages", "caches", "workspaceId", "pendingApproval", "prompt"]);

function parseSince(value: string | null): { date?: Date; response?: Response } {
  if (!value) return { response: NextResponse.json({ error: "since_required" }, { status: 400 }) };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { response: NextResponse.json({ error: "invalid_since" }, { status: 400 }) };
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  return { date: new Date(Math.max(date.getTime(), eightDaysAgo)) };
}

function parseLimit(value: string | null): number {
  const n = value === null ? 200 : Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 200;
}

function publicState(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !STRIP_STATE_KEYS.has(key)));
}

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readEvents(path: string): Promise<unknown[]> {
  try {
    const raw = await readFile(path, "utf8");
    const events: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        /* skip malformed lines in the export projection */
      }
    }
    return events;
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const parsed = parseSince(url.searchParams.get("since"));
  if (parsed.response) return parsed.response;
  const since = parsed.date!;
  const limit = parseLimit(url.searchParams.get("limit"));
  const until = new Date();
  const runsDir = resolveDataDirs().runs;

  const out: Array<{ id: string; updatedAt: string; state: Record<string, unknown>; events: unknown[] }> = [];
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    entries = [];
  }

  for (const id of entries) {
    if (!isRunId(id) || isDemoRunId(id)) continue;
    const dir = join(runsDir, id);
    const statePath = join(dir, "state.json");
    const eventsPath = join(dir, "events.jsonl");
    const updatedMs = Math.max(await mtimeMs(statePath), await mtimeMs(eventsPath));
    if (updatedMs < since.getTime()) continue;
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push({ id, updatedAt: new Date(updatedMs).toISOString(), state: publicState(state), events: await readEvents(eventsPath) });
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return NextResponse.json(
    { since: since.toISOString(), until: until.toISOString(), runs: out.slice(0, limit) },
    { headers: { "cache-control": "no-store" } },
  );
}
