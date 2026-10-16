import { createHash, randomUUID } from "node:crypto";
import { rm, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACES_DIR } from "./config";
import { withFileLock, writeFileAtomic } from "./fslock";
import { assertWorkspaceId, isWorkspaceId } from "./ids";
export { isWorkspaceId };
import type { RunState } from "./state";

import { squashName } from "../gates";
export { squashName };

/**
 * Long-term memory for one workspace. A fact lives in exactly one home, chosen by who may act on it:
 *   seen[]         constraint  -> code (the gate rejects `already_seen`; never ranked; scoped to the search that
 *                                 produced it, applied for 90 days, evicted after 180)
 *   preferences[]  user opinion -> model (ranked into the first message; ends only by supersession)
 *   notes[]        episodic     -> model (ranked into the first message; expires)
 * Working memory (todo, caches) stays in the run state. Every item carries provenance and a stable id.
 */
/** Which search an entry came from. `planKey` is planSignature(plan); "legacy" marks entries that predate scoping. */
export type SeenSearch = { planKey: string; label: string; industry?: string };

export const LEGACY_PLAN_KEY = "legacy";
export const LEGACY_SEARCH: SeenSearch = { planKey: LEGACY_PLAN_KEY, label: "earlier searches" };

export type SeenItem = {
  id: string;
  /** The search that produced this entry; the gate only sees it for the same search (see recall.ts). */
  search: SeenSearch;
  /** Demo seed only: never expires, so the replay keeps its two recorded skips whatever the date. */
  pinned?: boolean;
  name: string;
  squashed: string;
  /** "accepted" (delivered) or "rejected" (turned down by a gate). */
  verdict: string;
  reason: string;
  runId: string;
  at: string;
  /** The signal page behind an accepted lead. */
  signalUrl?: string;
  /** Position of the lead in that run's results (0-based); absent for rejections. */
  leadIndex?: number;
};

export type Preference = {
  id: string;
  company: string;
  verdict: "up" | "down";
  reason: string;
  runId?: string;
  signalUrl?: string;
  at: string;
  /** Id of the later feedback on the same company that replaced this one. The item is kept, not deleted. */
  supersededBy?: string;
};

export type Note = {
  id: string;
  /** <= 240 chars. */
  text: string;
  /** Plan gate keys, signal types, industry words; lowercase, <= 6. */
  tags: string[];
  runId: string;
  at: string;
  expiresAt: string;
};

export type WorkspaceMemory = {
  version: 2;
  seen: SeenItem[];
  preferences: Preference[];
  notes: Note[];
  /** Compatibility getter (not serialised): active preferences rendered as the old "User rejected X: why" lines. */
  readonly preferenceNotes: string[];
};

/** The shape on disk before 2026-10-15; accepted by saveMemory and migrated on load. */
export type LegacyMemory = {
  seen: Array<Partial<SeenItem> & { name: string; squashed: string }>;
  preferenceNotes: string[];
};

export const NOTE_TEXT_LIMIT = 240;
export const NOTE_TAG_LIMIT = 6;
export const NOTES_CAP = 200;
export const NOTE_TTL_DAYS = 60;
export const NOTE_TTL_MS = NOTE_TTL_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A seen entry stops being a constraint this long after `at`; compact() evicts it after SEEN_EVICT_DAYS. */
export const SEEN_TTL_DAYS = 90;
export const SEEN_EVICT_DAYS = 180;
/** Pre-scoping entries ("legacy") still constrain any search, but only this recently. */
export const LEGACY_SEEN_DAYS = 30;

/* ---------- search scope ---------- */

type SignatureInput = { gateFields: Array<{ key: string }>; signalTypes: string[]; companySummaryQuery?: string };

const INDUSTRY_PHRASE = /Prefer industry:\s*([^.]+)\./i;

/** The explicit industry phrase a scope change adds to a plan; "" when the plan has none (plans carry no industry field). */
export function planIndustry(plan: Pick<SignatureInput, "companySummaryQuery">): string {
  return INDUSTRY_PHRASE.exec(plan.companySummaryQuery ?? "")?.[1]?.trim().toLowerCase() ?? "";
}

/**
 * Stable identity of "the same search": sha1 over the sorted gate keys, the sorted signal types and the
 * industry phrase, if any. Size, HQ, recency, label, queries and exclusions are not part of it, so
 * editing them keeps the key; a different industry (which a plan expresses through its gates) or gate set changes it.
 */
export function planSignature(plan: SignatureInput): string {
  const body = JSON.stringify({
    gates: [...plan.gateFields.map((g) => g.key)].sort(),
    industry: planIndustry(plan),
    signals: [...plan.signalTypes].sort(),
  });
  return `plan_${createHash("sha1").update(body).digest("hex").slice(0, 12)}`;
}

export function searchOf(plan: SignatureInput & { label: string }): SeenSearch {
  const industry = planIndustry(plan);
  return { planKey: planSignature(plan), label: plan.label, ...(industry ? { industry } : {}) };
}

/** Entries with no scope (read straight from an old file, or built by hand) are legacy. */
export function seenSearch(item: Pick<SeenItem, "search">): SeenSearch {
  return item.search ?? LEGACY_SEARCH;
}

/** Still a constraint at all: under 90 days old (or pinned). Scope is checked separately by seenApplies. */
export function isActiveSeen(item: Pick<SeenItem, "at" | "pinned">, now: Date): boolean {
  if (item.pinned) return true;
  const at = Date.parse(item.at);
  return !Number.isNaN(at) && now.getTime() - at < SEEN_TTL_DAYS * DAY_MS;
}

/** Does this entry go to the gate for a plan with this signature? Same search, or legacy and recent. */
export function seenApplies(item: Pick<SeenItem, "search" | "at" | "pinned">, planKey: string, now: Date): boolean {
  if (!isActiveSeen(item, now)) return false;
  const key = seenSearch(item).planKey;
  if (key === planKey) return true;
  if (key !== LEGACY_PLAN_KEY) return false;
  const at = Date.parse(item.at);
  return item.pinned === true || (!Number.isNaN(at) && now.getTime() - at <= LEGACY_SEEN_DAYS * DAY_MS);
}

/** One search's remembered companies, as the memory panel shows them. */
export type SeenGroup = {
  planKey: string;
  label: string;
  industry?: string;
  /** Unique companies in the group (can exceed items.length, which is capped). */
  count: number;
  /** Oldest and newest `at` in the group. */
  firstAt: string;
  lastAt: string;
  /** The search the user is on now: the group sent as `currentKey`, else the most recently touched one. */
  current: boolean;
  /** Newest first, at most SEEN_GROUP_ITEMS. */
  items: SeenItem[];
};

export const SEEN_GROUP_ITEMS = 50;

/** Live (under 90 days) seen entries grouped by search; the current group first, then newest-touched first. */
export function groupSeen(seen: SeenItem[], now: Date, currentKey?: string): SeenGroup[] {
  const byKey = new Map<string, Array<{ item: SeenItem; index: number }>>();
  seen.forEach((item, index) => {
    if (!isActiveSeen(item, now)) return;
    const key = seenSearch(item).planKey;
    byKey.set(key, [...(byKey.get(key) ?? []), { item, index }]);
  });
  const groups = [...byKey.entries()].map(([planKey, rows]) => {
    rows.sort((a, b) => b.item.at.localeCompare(a.item.at) || b.index - a.index);
    const newest = seenSearch(rows[0]!.item);
    const dates = rows.map((r) => r.item.at).sort();
    return {
      planKey,
      label: newest.label,
      ...(newest.industry ? { industry: newest.industry } : {}),
      count: new Set(rows.map((r) => r.item.squashed)).size,
      firstAt: dates[0]!,
      lastAt: dates[dates.length - 1]!,
      current: false as boolean,
      items: rows.slice(0, SEEN_GROUP_ITEMS).map((r) => r.item),
    } satisfies SeenGroup;
  });
  groups.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const current = groups.find((g) => g.planKey === currentKey) ?? groups[0];
  if (current) {
    current.current = true;
    groups.splice(groups.indexOf(current), 1);
    groups.unshift(current);
  }
  return groups;
}

/* ---------- rendering (shared by the compat getter and recall) ---------- */

export function renderPreference(p: Pick<Preference, "company" | "verdict" | "reason">): string {
  const verb = p.verdict === "down" ? "rejected" : "liked";
  return p.reason ? `User ${verb} ${p.company}: ${p.reason}` : `User ${verb} ${p.company}`;
}

export function isActivePreference(p: Preference): boolean {
  return p.supersededBy === undefined;
}

export function isActiveNote(n: Note, now: Date): boolean {
  const expires = Date.parse(n.expiresAt);
  return Number.isNaN(expires) ? false : expires > now.getTime();
}

function withCompat(memory: Omit<WorkspaceMemory, "preferenceNotes">): WorkspaceMemory {
  Object.defineProperty(memory, "preferenceNotes", {
    enumerable: false,
    configurable: true,
    get(this: WorkspaceMemory) {
      return this.preferences.filter(isActivePreference).map(renderPreference);
    },
  });
  return memory as WorkspaceMemory;
}

export function emptyMemory(): WorkspaceMemory {
  return withCompat({ version: 2, seen: [], preferences: [], notes: [] });
}

/* ---------- migration ---------- */

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function hashId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10)}`;
}

/** Deterministic ids for items that predate ids, so reloading an old file twice gives the same ids. */
function uniqueId(prefix: string, taken: Set<string>, ...parts: string[]): string {
  let id = hashId(prefix, ...parts);
  for (let n = 1; taken.has(id); n += 1) id = hashId(prefix, ...parts, String(n));
  taken.add(id);
  return id;
}

const LEGACY_PREFERENCE = /^User (rejected|liked) (.+?)(?:: ([\s\S]*))?$/;

/** Recompute `supersededBy`: within one company, only the newest feedback stays active. */
export function applySupersession(preferences: Preference[]): void {
  const byCompany = new Map<string, Preference[]>();
  for (const p of preferences) {
    const key = squashName(p.company);
    byCompany.set(key, [...(byCompany.get(key) ?? []), p]);
  }
  for (const group of byCompany.values()) {
    const ordered = [...group].sort((a, b) => a.at.localeCompare(b.at) || group.indexOf(a) - group.indexOf(b));
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const next = ordered[i + 1]!;
      if (ordered[i]!.supersededBy === undefined) ordered[i]!.supersededBy = next.id;
    }
  }
}

/**
 * Accepts the current shape, the pre-2026-10-15 shape ({seen, preferenceNotes}), or garbage, and
 * returns a valid memory. Never throws. `fallbackAt` dates legacy items that carried no timestamp.
 */
export function migrateMemory(raw: unknown, fallbackAt: string = new Date(0).toISOString()): WorkspaceMemory {
  const root = rec(raw);
  const taken = new Set<string>();
  const seen: SeenItem[] = [];
  for (const item of Array.isArray(root.seen) ? root.seen : []) {
    const r = rec(item);
    const name = str(r.name);
    if (!name) continue;
    const squashed = str(r.squashed) ?? squashName(name);
    const runId = str(r.runId) ?? "unknown";
    const at = str(r.at) ?? fallbackAt;
    const verdict = str(r.verdict) ?? "rejected";
    const given = str(r.id);
    const id = given && !taken.has(given) ? (taken.add(given), given) : uniqueId("seen", taken, squashed, runId, at, verdict);
    const rs = rec(r.search);
    const planKey = str(rs.planKey);
    seen.push({
      id,
      search: planKey
        ? { planKey, label: str(rs.label) ?? LEGACY_SEARCH.label, ...(str(rs.industry) ? { industry: str(rs.industry) } : {}) }
        : { ...LEGACY_SEARCH },
      ...(r.pinned === true ? { pinned: true } : {}),
      name,
      squashed,
      verdict,
      reason: str(r.reason) ?? verdict,
      runId,
      at,
      ...(str(r.signalUrl) ? { signalUrl: str(r.signalUrl) } : {}),
      ...(typeof r.leadIndex === "number" ? { leadIndex: r.leadIndex } : {}),
    });
  }

  const preferences: Preference[] = [];
  const notes: Note[] = [];
  for (const item of Array.isArray(root.preferences) ? root.preferences : []) {
    const r = rec(item);
    const company = str(r.company);
    if (!company || (r.verdict !== "up" && r.verdict !== "down")) continue;
    const at = str(r.at) ?? fallbackAt;
    const given = str(r.id);
    const id = given && !taken.has(given) ? (taken.add(given), given) : uniqueId("pref", taken, company, r.verdict, at);
    preferences.push({
      id,
      company,
      verdict: r.verdict,
      reason: typeof r.reason === "string" ? r.reason : "",
      ...(str(r.runId) ? { runId: str(r.runId) } : {}),
      ...(str(r.signalUrl) ? { signalUrl: str(r.signalUrl) } : {}),
      at,
      ...(str(r.supersededBy) ? { supersededBy: str(r.supersededBy) } : {}),
    });
  }
  // Pre-2026-10-15 files: preferenceNotes were strings. A string that is not one of our own formats
  // cannot be given a company or a verdict honestly, so it becomes an episodic note instead.
  for (const line of Array.isArray(root.preferenceNotes) ? root.preferenceNotes : []) {
    if (typeof line !== "string" || !line.trim()) continue;
    const m = LEGACY_PREFERENCE.exec(line.trim());
    if (m) {
      preferences.push({
        id: uniqueId("pref", taken, line, fallbackAt),
        company: m[2]!,
        verdict: m[1] === "rejected" ? "down" : "up",
        reason: m[3] ?? "",
        at: fallbackAt,
      });
    } else {
      notes.push({
        id: uniqueId("note", taken, line, fallbackAt),
        text: line.trim().slice(0, NOTE_TEXT_LIMIT),
        tags: [],
        runId: "legacy",
        at: fallbackAt,
        expiresAt: new Date(Date.parse(fallbackAt) + NOTE_TTL_MS).toISOString(),
      });
    }
  }
  for (const item of Array.isArray(root.notes) ? root.notes : []) {
    const r = rec(item);
    const text = str(r.text);
    if (!text) continue;
    const at = str(r.at) ?? fallbackAt;
    const given = str(r.id);
    const id = given && !taken.has(given) ? (taken.add(given), given) : uniqueId("note", taken, text, at);
    notes.push({
      id,
      text: text.slice(0, NOTE_TEXT_LIMIT),
      tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string").slice(0, NOTE_TAG_LIMIT) : [],
      runId: str(r.runId) ?? "unknown",
      at,
      expiresAt: str(r.expiresAt) ?? new Date(Date.parse(at) + NOTE_TTL_MS).toISOString(),
    });
  }
  applySupersession(preferences);
  return withCompat({ version: 2, seen, preferences, notes });
}

/* ---------- compaction ---------- */

/**
 * Called on every save. `seen` entries older than SEEN_EVICT_DAYS are dropped (recall stopped applying them at
 * SEEN_TTL_DAYS); preferences end only by supersession; notes past NOTES_CAP lose expired ones first
 * (oldest first), then the oldest. Reads already ignore expired items, so keeping them until then is harmless.
 */
export function compact(memory: WorkspaceMemory, now: Date): WorkspaceMemory {
  memory.seen = memory.seen.filter((s) => {
    if (s.pinned) return true;
    const at = Date.parse(s.at);
    return Number.isNaN(at) || now.getTime() - at <= SEEN_EVICT_DAYS * DAY_MS;
  });
  if (memory.notes.length <= NOTES_CAP) return memory;
  const excess = memory.notes.length - NOTES_CAP;
  const byAge = [...memory.notes].sort((a, b) => a.at.localeCompare(b.at));
  const expired = byAge.filter((n) => !isActiveNote(n, now));
  const live = byAge.filter((n) => isActiveNote(n, now));
  const evict = new Set([...expired, ...live].slice(0, excess).map((n) => n.id));
  memory.notes = memory.notes.filter((n) => !evict.has(n.id));
  return memory;
}

/* ---------- storage ---------- */

function memoryDir(workspaceId: string): string {
  return join(WORKSPACES_DIR, assertWorkspaceId(workspaceId));
}

function memoryPath(workspaceId: string): string {
  return join(memoryDir(workspaceId), "memory.json");
}

function lockPath(workspaceId: string): string {
  return join(memoryDir(workspaceId), ".memory.lock");
}

export async function loadMemory(workspaceId: string): Promise<WorkspaceMemory> {
  const path = memoryPath(workspaceId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyMemory();
  }
  let fallbackAt = new Date(0).toISOString();
  try {
    fallbackAt = (await stat(path)).mtime.toISOString();
  } catch {
    /* keep epoch */
  }
  try {
    return migrateMemory(JSON.parse(text), fallbackAt);
  } catch {
    return emptyMemory();
  }
}

function serialise(memory: WorkspaceMemory): string {
  const { version, seen, preferences, notes } = memory;
  return JSON.stringify({ version, seen, preferences, notes }, null, 2);
}

/** Write without taking the lock; the caller holds it. */
async function writeLocked(workspaceId: string, memory: WorkspaceMemory, now: Date): Promise<WorkspaceMemory> {
  const compacted = compact(memory, now);
  await writeFileAtomic(memoryPath(workspaceId), serialise(compacted));
  return compacted;
}

/** Replace the stored memory. Accepts the legacy shape (migrated first); compacts before writing. */
export async function saveMemory(workspaceId: string, memory: WorkspaceMemory | LegacyMemory, now: Date = new Date()): Promise<void> {
  const dir = memoryDir(workspaceId);
  await mkdir(dir, { recursive: true });
  await withFileLock(lockPath(workspaceId), async () => {
    await writeLocked(workspaceId, migrateMemory(memory, now.toISOString()), now);
  });
}

/** Locked read-modify-write: concurrent feedback, run-end and delete requests cannot lose each other's changes. */
export async function updateMemory(
  workspaceId: string,
  fn: (memory: WorkspaceMemory) => void | Promise<void>,
  now: Date = new Date(),
): Promise<WorkspaceMemory> {
  await mkdir(memoryDir(workspaceId), { recursive: true });
  return withFileLock(lockPath(workspaceId), async () => {
    const memory = await loadMemory(workspaceId);
    await fn(memory);
    return writeLocked(workspaceId, memory, now);
  });
}

export async function clearMemory(workspaceId: string): Promise<void> {
  const path = memoryPath(workspaceId);
  await mkdir(memoryDir(workspaceId), { recursive: true });
  await withFileLock(lockPath(workspaceId), async () => {
    await rm(path, { force: true });
  });
}

/** Remove exactly one item, by id, from whichever list holds it. Returns false when no item has that id. */
export async function deleteMemoryItem(workspaceId: string, itemId: string): Promise<boolean> {
  let found = false;
  await updateMemory(workspaceId, (memory) => {
    for (const key of ["seen", "preferences", "notes"] as const) {
      const list = memory[key] as Array<{ id: string }>;
      const index = list.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        list.splice(index, 1);
        found = true;
        return;
      }
    }
  });
  return found;
}

/** Forget every seen entry of one search; returns how many went. Preferences and notes are untouched. */
export async function deleteSeenGroup(workspaceId: string, planKey: string): Promise<number> {
  let removed = 0;
  await updateMemory(workspaceId, (memory) => {
    const keep = memory.seen.filter((s) => seenSearch(s).planKey !== planKey);
    removed = memory.seen.length - keep.length;
    memory.seen = keep;
  });
  return removed;
}

/**
 * Promote one finished run into memory: its leads and rejections become `seen` items, its
 * self-notes become `notes`. Idempotent per run (a company already recorded for this run, or a
 * note id already stored, is skipped), and a company already in `seen` is not recorded twice.
 */
export async function appendRunToMemory(state: RunState): Promise<void> {
  const now = new Date();
  const at = now.toISOString();
  // The run's own search: the plan it started from (scope changes made mid-run do not move its entries).
  const plan = state.initialContract ?? state.contract;
  const search: SeenSearch = plan && Array.isArray(plan.gateFields) && Array.isArray(plan.signalTypes) ? searchOf(plan) : { ...LEGACY_SEARCH };
  await updateMemory(state.workspaceId, (memory) => {
    // Dedupe only against live entries of this same search: a company seen under another search, or long ago, is recorded again here.
    const known = new Set(memory.seen.filter((s) => seenSearch(s).planKey === search.planKey && isActiveSeen(s, now)).map((s) => s.squashed));
    state.leads.forEach((lead, index) => {
      const squashed = squashName(lead.company);
      if (known.has(squashed)) return;
      known.add(squashed);
      memory.seen.push({
        id: randomUUID(),
        search,
        name: lead.company,
        squashed,
        verdict: "accepted",
        reason: "accepted",
        runId: state.id,
        at,
        signalUrl: lead.signal_url,
        leadIndex: index,
      });
    });
    for (const rejection of state.rejected) {
      const squashed = squashName(rejection.company);
      if (known.has(squashed)) continue;
      known.add(squashed);
      memory.seen.push({
        id: randomUUID(),
        search,
        name: rejection.company,
        squashed,
        verdict: "rejected",
        reason: `${rejection.code}: ${rejection.reason}`,
        runId: state.id,
        at,
      });
    }
    const haveNote = new Set(memory.notes.map((n) => n.id));
    for (const note of state.notes ?? []) {
      if (!haveNote.has(note.id)) memory.notes.push({ ...note });
    }
  });
}

/**
 * Per-lead feedback from the results table. It becomes a preference (provenance: run and signal
 * page when known) that the next run's recall may carry. A later feedback on the same company
 * supersedes the earlier one: the earlier item is kept with `supersededBy` set.
 */
export async function addFeedback(
  workspaceId: string,
  feedback: { company: string; verdict: "up" | "down"; reason?: string; runId?: string; signalUrl?: string },
): Promise<WorkspaceMemory> {
  const company = feedback.company.trim().slice(0, 120);
  const reason = feedback.reason?.trim().slice(0, 300) ?? "";
  return updateMemory(workspaceId, (memory) => {
    const item: Preference = {
      id: randomUUID(),
      company,
      verdict: feedback.verdict,
      reason,
      ...(feedback.runId ? { runId: feedback.runId } : {}),
      ...(feedback.signalUrl ? { signalUrl: feedback.signalUrl.slice(0, 500) } : {}),
      at: new Date().toISOString(),
    };
    const key = squashName(company);
    for (const earlier of memory.preferences) {
      if (earlier.supersededBy === undefined && squashName(earlier.company) === key) earlier.supersededBy = item.id;
    }
    memory.preferences.push(item);
  });
}
