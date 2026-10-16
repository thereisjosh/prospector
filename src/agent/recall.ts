import type { SearchPlan } from "../plan";
import { isActiveNote, isActivePreference, planSignature, renderPreference, seenApplies, squashName, type Note, type Preference, type WorkspaceMemory } from "./memory";

/**
 * The only way a run reads long-term memory. Constraints bypass ranking (the gate needs every seen
 * key that applies to this search, see seenApplies); preferences and notes are ranked against the plan and cut to a token budget.
 * Pure: same memory, plan and clock give the same answer.
 */

/** Prompt budget for recalled preferences + notes (estimated at 4 chars per token). */
export const RECALL_BUDGET_TOKENS = 800;

export type SeenInfo = { name: string; verdict: string; at: string; runId: string };

export type RecallLogEntry = { id: string; kind: "preference" | "note"; score: number; included: boolean };

export type RecallResult = {
  constraints: {
    seenKeys: string[];
    /** Provenance per key, so a skipped company can be explained ("delivered 12 Oct in an earlier run"). */
    seenInfo: Record<string, SeenInfo>;
  };
  prompt: { preferences: Preference[]; notes: Note[] };
  log: RecallLogEntry[];
};

const RECENCY_WEIGHT = 0.9; // < 1: a single shared word always beats any amount of recency
const RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have", "had", "its", "their",
  "not", "but", "you", "your", "who", "what", "which", "into", "than", "then", "also", "any", "all", "can", "will",
  "new", "user", "liked", "rejected", "company", "companies", "event", "events", "signal", "signals", "summarize",
  "summary", "find", "recent", "latest", "about", "such", "each", "more", "most", "only", "over", "per",
]);

/** Lowercased words (and the whole snake_case key) of some text; light plural stemming; short and stop words dropped. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

function tagWords(tag: string): Set<string> {
  const out = words(tag);
  const whole = tag.toLowerCase().trim();
  if (whole) out.add(whole);
  return out;
}

/** Plan vocabulary: gate keys, signal types, label, query and summary words. */
export function planWords(plan: SearchPlan): Set<string> {
  const out = new Set<string>();
  const add = (set: Set<string>) => set.forEach((w) => out.add(w));
  for (const gate of plan.gateFields) add(tagWords(gate.key));
  for (const type of plan.signalTypes) add(tagWords(type));
  add(words(plan.label));
  for (const q of plan.signalQueries) add(words(q));
  add(words(plan.signalSummaryQuery));
  add(words(plan.companySummaryQuery));
  return out;
}

function overlap(item: Set<string>, plan: Set<string>): number {
  let n = 0;
  for (const w of item) if (plan.has(w)) n += 1;
  return n;
}

function recencyBonus(at: string, now: Date): number {
  const age = Math.max(0, now.getTime() - Date.parse(at));
  if (Number.isNaN(age)) return 0;
  return RECENCY_WEIGHT * Math.pow(0.5, age / DAY_MS / RECENCY_HALF_LIFE_DAYS);
}

/** "2026-10-12: text" */
export function renderNote(n: Pick<Note, "text" | "at">): string {
  return `${n.at.slice(0, 10)}: ${n.text}`;
}

const tokens = (text: string) => Math.ceil(text.length / 4);

type Candidate =
  | { kind: "preference"; item: Preference; score: number; cost: number }
  | { kind: "note"; item: Note; score: number; cost: number };

export function recall(
  memory: Pick<WorkspaceMemory, "seen" | "preferences" | "notes">,
  plan: SearchPlan,
  opts: { budgetTokens: number; now: Date },
): RecallResult {
  const { now } = opts;

  // Constraints are scoped: only entries from this same search (or recent legacy ones) reach the gate.
  // The rest stay in memory but are not passed on. Still no ranking.
  const planKey = planSignature(plan);
  const seenInfo: Record<string, SeenInfo> = {};
  for (const s of memory.seen) {
    if (!seenApplies(s, planKey, now)) continue;
    const key = s.squashed || squashName(s.name);
    // The first record of a company is the provenance ("delivered on ...").
    seenInfo[key] ??= { name: s.name, verdict: s.verdict, at: s.at, runId: s.runId };
  }

  const vocab = planWords(plan);
  const candidates: Candidate[] = [];
  const log: RecallLogEntry[] = [];

  for (const p of memory.preferences) {
    if (!isActivePreference(p)) {
      log.push({ id: p.id, kind: "preference", score: 0, included: false });
      continue;
    }
    const itemWords = new Set([...words(p.company), ...words(p.reason)]);
    const score = overlap(itemWords, vocab) + recencyBonus(p.at, now);
    candidates.push({ kind: "preference", item: p, score, cost: tokens(renderPreference(p)) });
  }
  for (const n of memory.notes) {
    if (!isActiveNote(n, now)) {
      log.push({ id: n.id, kind: "note", score: 0, included: false });
      continue;
    }
    const itemWords = new Set<string>();
    for (const tag of n.tags) tagWords(tag).forEach((w) => itemWords.add(w));
    const score = overlap(itemWords, vocab) + recencyBonus(n.at, now);
    candidates.push({ kind: "note", item: n, score, cost: tokens(renderNote(n)) });
  }

  // Highest score first; on a tie the user's own feedback outranks a self-note, then the newer item.
  candidates.sort((a, b) =>
    b.score - a.score ||
    (a.kind === b.kind ? 0 : a.kind === "preference" ? -1 : 1) ||
    b.item.at.localeCompare(a.item.at),
  );

  const preferences: Preference[] = [];
  const notes: Note[] = [];
  let spent = 0;
  let full = false;
  for (const c of candidates) {
    // Never return nothing when items exist: the top item goes in even if it alone exceeds the budget.
    const fits = spent + c.cost <= opts.budgetTokens || spent === 0;
    const included = !full && fits;
    if (!included) full = true;
    if (included) {
      spent += c.cost;
      if (c.kind === "preference") preferences.push(c.item);
      else notes.push(c.item);
    }
    log.push({ id: c.item.id, kind: c.kind, score: Math.round(c.score * 1000) / 1000, included });
  }

  return {
    constraints: { seenKeys: Object.keys(seenInfo), seenInfo },
    prompt: { preferences, notes },
    log,
  };
}
