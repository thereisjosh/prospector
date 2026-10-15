import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Temp RUNS_DIR / WORKSPACES_DIR before any module reads them; never the real ./runs or ./workspaces.
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(j(tmpdir(), "memory-test-"));
  process.env.RUNS_DIR = j(root, "runs");
  process.env.WORKSPACES_DIR = j(root, "workspaces");
  process.env.ANTHROPIC_API_KEY ??= "test-key";
  process.env.EXA_API_KEY ??= "test-key";
  delete process.env.DEMO_MODE;
  return { root, runs: j(root, "runs"), workspaces: j(root, "workspaces") };
});

// The demo replay pauses 750 ms per turn; the test steps through all of them.
vi.mock("../src/demo/mode", async (original) => ({ ...(await original<typeof import("../src/demo/mode")>()), demoDelay: async () => undefined }));

import { MemoryPanel } from "../app/ui/Memory";
import { eventLine, seenWhen, screenedFrom } from "../app/ui/copy";
import type { MemoryView } from "../app/ui/types";
import { GET as memoryGET } from "../app/api/workspaces/[id]/memory/route";
import { DELETE as itemDELETE } from "../app/api/workspaces/[id]/memory/items/[itemId]/route";
import { POST as feedbackPOST } from "../app/api/workspaces/[id]/feedback/route";
import { readLastEvents } from "../src/agent/events";
import { step, type LoopDeps } from "../src/agent/loop";
import {
  NOTES_CAP,
  NOTE_TTL_MS,
  addFeedback,
  appendRunToMemory,
  clearMemory,
  compact,
  deleteMemoryItem,
  loadMemory,
  migrateMemory,
  saveMemory,
  squashName,
  type Note,
  type Preference,
  type SeenItem,
  type WorkspaceMemory,
} from "../src/agent/memory";
import { RECALL_BUDGET_TOKENS, recall } from "../src/agent/recall";
import { createRunState, type RunState } from "../src/agent/state";
import { agentTools, executeTool, validateNote, type ToolDeps } from "../src/agent/tools";
import { CostGuard } from "../src/exa";
import type { SearchPlan } from "../src/plan";
import { createDemoRun, demoSnapshot, demoStep } from "../src/demo/replay";
import { seedDemoMemory } from "../src/demo/memory";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const plan = (over: Partial<SearchPlan> = {}): SearchPlan => ({
  label: "Logistics ops scaling now",
  months: 3,
  signalQueries: ["new warehouse opening"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_third_party_logistics", question: "Is it a 3PL?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["new_facility", "ops_hiring_wave"],
  ...over,
});

let counter = 0;
const ws = () => `mem-test-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

const note = (over: Partial<Note> = {}): Note => ({
  id: `n${++counter}`,
  text: "a note",
  tags: [],
  runId: "r1",
  at: iso(NOW.getTime() - DAY),
  expiresAt: iso(NOW.getTime() + 30 * DAY),
  ...over,
});
const pref = (over: Partial<Preference> = {}): Preference => ({
  id: `p${++counter}`,
  company: "Acme",
  verdict: "down",
  reason: "not a 3pl",
  at: iso(NOW.getTime() - DAY),
  ...over,
});
const seenItem = (name: string, over: Partial<SeenItem> = {}): SeenItem => ({
  id: `s${++counter}`,
  name,
  squashed: squashName(name),
  verdict: "accepted",
  reason: "accepted",
  runId: "run-0",
  at: iso(NOW.getTime() - 3 * DAY),
  ...over,
});
const mem = (parts: Partial<Pick<WorkspaceMemory, "seen" | "preferences" | "notes">>) => ({ seen: [], preferences: [], notes: [], ...parts });

async function writeRaw(workspaceId: string, raw: unknown) {
  await mkdir(join(tmp.workspaces, workspaceId), { recursive: true });
  await writeFile(join(tmp.workspaces, workspaceId, "memory.json"), typeof raw === "string" ? raw : JSON.stringify(raw), "utf8");
}

describe("memory schema and migration", () => {
  it("migrates the old shape on load: ids, parsed preferences, free text becomes a note; never crashes", async () => {
    const w = ws();
    await writeRaw(w, {
      seen: [
        { name: "OldCo LLC", squashed: "oldco", verdict: "accepted", reason: "accepted", runId: "r0", at: "2026-10-01T00:00:00.000Z" },
        { name: "OldCo LLC", squashed: "oldco", verdict: "accepted", reason: "accepted", runId: "r0", at: "2026-10-01T00:00:00.000Z" },
      ],
      preferenceNotes: ["User rejected Acme Freight: runs its own trucks", "User liked Beta Co", "avoid captive shippers"],
    });
    const m = await loadMemory(w);
    expect(m.version).toBe(2);
    expect(m.seen).toHaveLength(2);
    expect(new Set(m.seen.map((s) => s.id)).size).toBe(2); // identical old items still get distinct ids
    expect(m.seen.every((s) => s.id.startsWith("seen_"))).toBe(true);
    expect(m.preferences.map((p) => [p.company, p.verdict, p.reason])).toEqual([
      ["Acme Freight", "down", "runs its own trucks"],
      ["Beta Co", "up", ""],
    ]);
    expect(m.notes.map((n) => n.text)).toEqual(["avoid captive shippers"]);
    expect(m.notes[0]!.runId).toBe("legacy");
    // compatibility getter: active preferences in the old line format
    expect(m.preferenceNotes).toEqual(["User rejected Acme Freight: runs its own trucks", "User liked Beta Co"]);
    // stable: loading twice gives the same ids
    const again = await loadMemory(w);
    expect(again.seen.map((s) => s.id)).toEqual(m.seen.map((s) => s.id));
    expect(again.preferences.map((p) => p.id)).toEqual(m.preferences.map((p) => p.id));
    // saving writes the new shape, without the getter
    await saveMemory(w, m);
    const onDisk = JSON.parse(await readFile(join(tmp.workspaces, w, "memory.json"), "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["notes", "preferences", "seen", "version"]);
  });

  it("survives garbage, missing and wrong-typed files", async () => {
    const w = ws();
    await writeRaw(w, "{not json");
    expect(await loadMemory(w)).toMatchObject({ seen: [], preferences: [], notes: [] });
    for (const raw of [null, 7, "x", [], { seen: "no", preferenceNotes: 3, preferences: [null, 1, { company: 5 }], notes: [{}, { text: 5 }] }]) {
      expect(migrateMemory(raw)).toMatchObject({ version: 2, seen: [], preferences: [], notes: [] });
    }
    expect(await loadMemory(ws())).toMatchObject({ seen: [], preferences: [], notes: [] });
  });

  it("a later feedback on the same company supersedes the earlier one without deleting it", async () => {
    const w = ws();
    await addFeedback(w, { company: "Acme Corp", verdict: "down", reason: "too big", runId: crypto.randomUUID(), signalUrl: "https://n.example/a" });
    await new Promise((r) => setTimeout(r, 5));
    const after = await addFeedback(w, { company: "ACME corp.", verdict: "up", reason: "actually fine" });
    expect(after.preferences).toHaveLength(2);
    const [first, second] = after.preferences;
    expect(first!.supersededBy).toBe(second!.id);
    expect(second!.supersededBy).toBeUndefined();
    expect(first!.signalUrl).toBe("https://n.example/a"); // provenance kept
    expect(after.preferenceNotes).toEqual(["User liked ACME corp.: actually fine"]);
    await addFeedback(w, { company: "Other", verdict: "down" });
    expect((await loadMemory(w)).preferenceNotes).toHaveLength(2);
  });

  it("appendRunToMemory records provenance, is idempotent per company, and promotes the run's notes", async () => {
    const w = ws();
    const s = createRunState({ id: crypto.randomUUID(), workspaceId: w, plan: plan() });
    s.leads.push({ company: "GoodCo", signal_url: "https://n.example/good", why_now: "x", summary: { company_name: "GoodCo", signal_type: "new_facility", signal_summary: "x", signal_date: "2026-10-01" }, details: {}, turn: 1 });
    s.rejected.push({ company: "BadCo", code: "size", reason: "too big", turn: 2 });
    s.notes = [note({ id: `note_${s.id}_1`, runId: s.id })];
    await appendRunToMemory(s);
    await appendRunToMemory(s);
    const m = await loadMemory(w);
    expect(m.seen.map((x) => [x.name, x.verdict, x.runId, x.signalUrl, x.leadIndex])).toEqual([
      ["GoodCo", "accepted", s.id, "https://n.example/good", 0],
      ["BadCo", "rejected", s.id, undefined, undefined],
    ]);
    expect(new Set(m.seen.map((x) => x.id)).size).toBe(2);
    expect(m.notes).toHaveLength(1);
  });

  it("clear-all still works", async () => {
    const w = ws();
    await addFeedback(w, { company: "X", verdict: "down" });
    await clearMemory(w);
    expect(await loadMemory(w)).toMatchObject({ preferences: [] });
  });
});

describe("recall", () => {
  const p = plan();

  it("constraints bypass ranking: every seen key, always, with provenance", () => {
    const seen = Array.from({ length: 300 }, (_, i) => seenItem(`Company ${i}`));
    const r = recall(mem({ seen }), p, { budgetTokens: 1, now: NOW });
    expect(r.constraints.seenKeys).toHaveLength(300);
    expect(r.constraints.seenInfo[squashName("Company 7")]).toMatchObject({ name: "Company 7", verdict: "accepted", runId: "run-0" });
    expect(r.log).toEqual([]); // seen items are constraints, not ranked
  });

  it("overlap beats recency", () => {
    const fresh = note({ id: "fresh", text: "unrelated", tags: ["cafes"], at: iso(NOW.getTime() - 1000) });
    const old = note({ id: "old", text: "related", tags: ["new_facility"], at: iso(NOW.getTime() - 50 * DAY) });
    const r = recall(mem({ notes: [fresh, old] }), p, { budgetTokens: RECALL_BUDGET_TOKENS, now: NOW });
    expect(r.prompt.notes.map((n) => n.id)).toEqual(["old", "fresh"]);
    const scores = Object.fromEntries(r.log.map((e) => [e.id, e.score]));
    expect(scores.old!).toBeGreaterThan(scores.fresh!);
    expect(scores.fresh!).toBeLessThan(0.9 + 1e-9); // recency alone can never reach one shared word
  });

  it("recency breaks ties between equal overlap", () => {
    const a = note({ id: "a", tags: ["warehouse"], at: iso(NOW.getTime() - 40 * DAY) });
    const b = note({ id: "b", tags: ["warehouse"], at: iso(NOW.getTime() - 2 * DAY) });
    expect(recall(mem({ notes: [a, b] }), p, { budgetTokens: 999, now: NOW }).prompt.notes.map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("expired notes score 0 and are excluded; superseded preferences too", () => {
    const live = note({ id: "live", tags: ["new_facility"] });
    const dead = note({ id: "dead", tags: ["new_facility"], expiresAt: iso(NOW.getTime() - 1) });
    const old = pref({ id: "old", supersededBy: "new" });
    const current = pref({ id: "new" });
    const r = recall(mem({ notes: [live, dead], preferences: [old, current] }), p, { budgetTokens: 999, now: NOW });
    expect(r.prompt.notes.map((n) => n.id)).toEqual(["live"]);
    expect(r.prompt.preferences.map((x) => x.id)).toEqual(["new"]);
    expect(r.log.find((e) => e.id === "dead")).toEqual({ id: "dead", kind: "note", score: 0, included: false });
    expect(r.log.find((e) => e.id === "old")).toEqual({ id: "old", kind: "preference", score: 0, included: false });
  });

  it("respects the token budget (4 chars per token) and keeps the best items", () => {
    const notes = Array.from({ length: 10 }, (_, i) => note({ id: `n${i}`, text: "x".repeat(88), tags: i === 7 ? ["new_facility"] : [] }));
    // each rendered note is "2026-10-14: " + 88 chars = 100 chars = 25 tokens
    const r = recall(mem({ notes }), p, { budgetTokens: 60, now: NOW });
    expect(r.prompt.notes).toHaveLength(2);
    expect(r.prompt.notes[0]!.id).toBe("n7"); // the overlapping one is first
    expect(r.log.filter((e) => e.included)).toHaveLength(2);
    expect(r.log).toHaveLength(10); // every candidate is logged with its score
  });

  it("never returns nothing when items exist, even if the top item alone exceeds the budget", () => {
    const big = note({ id: "big", text: "y".repeat(240), tags: ["new_facility"] });
    const r = recall(mem({ notes: [big] }), p, { budgetTokens: 5, now: NOW });
    expect(r.prompt.notes.map((n) => n.id)).toEqual(["big"]);
    expect(recall(mem({}), p, { budgetTokens: 5, now: NOW }).prompt).toEqual({ preferences: [], notes: [] });
  });

  it("user feedback outranks a self-note on equal score", () => {
    const n = note({ id: "n", tags: [] });
    const pr = pref({ id: "p", reason: "", company: "Zed" });
    const r = recall(mem({ notes: [n], preferences: [pr] }), p, { budgetTokens: 999, now: NOW });
    expect(r.log.map((e) => e.id)).toEqual(["p", "n"]);
  });
});

describe("compact", () => {
  it("seen and preferences never expire; notes past the cap evict expired first, then oldest", () => {
    const expired = (i: number) => note({ id: `e${i}`, at: iso(NOW.getTime() - (400 - i) * DAY), expiresAt: iso(NOW.getTime() - DAY) });
    const live = (i: number) => note({ id: `l${i}`, at: iso(NOW.getTime() - (300 - i) * DAY), expiresAt: iso(NOW.getTime() + DAY) });
    // 195 live + 10 expired = 205: the 5 oldest expired go, every live note stays
    const m = migrateMemory({
      seen: [seenItem("Ancient", { at: "2020-01-01T00:00:00.000Z" })],
      preferences: [pref({ at: "2020-01-01T00:00:00.000Z" })],
      notes: [...Array.from({ length: 195 }, (_, i) => live(i)), ...Array.from({ length: 10 }, (_, i) => expired(i))],
    });
    compact(m, NOW);
    expect(m.notes).toHaveLength(NOTES_CAP);
    expect(m.notes.filter((n) => n.id.startsWith("l"))).toHaveLength(195);
    expect(m.notes.filter((n) => n.id.startsWith("e")).map((n) => n.id)).toEqual(["e5", "e6", "e7", "e8", "e9"]);
    expect(m.seen).toHaveLength(1);
    expect(m.preferences).toHaveLength(1);

    // with no expired notes, the oldest live ones go
    const all = migrateMemory({ notes: Array.from({ length: 203 }, (_, i) => live(i)) });
    compact(all, NOW);
    expect(all.notes).toHaveLength(NOTES_CAP);
    expect(all.notes.map((n) => n.id)).not.toContain("l0");
    expect(all.notes.map((n) => n.id)).not.toContain("l2");
    expect(all.notes.map((n) => n.id)).toContain("l3");
  });

  it("is applied on save", async () => {
    const w = ws();
    await saveMemory(w, mem({ notes: Array.from({ length: NOTES_CAP + 7 }, (_, i) => note({ id: `s${i}`, at: iso(NOW.getTime() - (400 - i) * DAY) })) }) as WorkspaceMemory, NOW);
    expect((await loadMemory(w)).notes).toHaveLength(NOTES_CAP);
  });
});

describe("remember tool", () => {
  const schemaOf = () => agentTools().find((t) => t.name === "remember")!;

  const runState = (over: Partial<RunState> = {}) => {
    const s = createRunState({ id: crypto.randomUUID(), workspaceId: ws(), plan: plan(), createdAt: NOW.toISOString() });
    s.strategyApproved = true;
    return Object.assign(s, over);
  };
  const withLead = (s: RunState) => {
    s.leads.push({ company: "GoodCo", signal_url: "https://n.example/good", why_now: "x", summary: { company_name: "GoodCo", signal_type: "new_facility", signal_summary: "x", signal_date: "2026-10-01" }, details: {}, turn: 1 });
    return s;
  };
  const deps = { checkLead: () => ({ ok: true }) as never, now: NOW } as ToolDeps;
  const call = (s: RunState, name: string, input: unknown) => executeTool(s, { id: crypto.randomUUID(), name, input }, deps, { guard: new CostGuard(1) });

  it("has a strict schema with no min/max keywords and no empty object", () => {
    const t = schemaOf();
    expect(t.strict).toBe(true);
    expect(JSON.stringify(t.input_schema)).not.toMatch(/minimum|maximum|minItems|maxItems|minLength|maxLength|"\{\}"/);
    expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false, required: ["text", "tags"] });
  });

  it("is refused until the run has a lead or a handback", async () => {
    const s = runState();
    const r = await call(s, "remember", { text: "x", tags: [] });
    expect(r.result.is_error).toBe(true);
    expect(String(r.result.content)).toMatch(/accepted lead or a handback/);
    expect(s.notes ?? []).toHaveLength(0);
    s.handback = { shortfall: "0 of 10", top_reasons: [], suggestions: [] };
    expect((await call(s, "remember", { text: "Hiring-wave searches returned mostly staffing firms.", tags: ["ops_hiring_wave"] })).result.is_error).not.toBe(true);
  });

  it("stores a validated note with provenance and a 60-day expiry, lowercased tags, and confirms", async () => {
    const s = withLead(runState());
    const r = await call(s, "remember", { text: "  New-warehouse news surfaced mid-size operators.  ", tags: ["New_Facility", " 3PL ", "new_facility"] });
    expect(r.result.is_error).not.toBe(true);
    expect(String(r.result.content)).toMatch(/^saved \(1 of 3\)/);
    expect(s.notes).toHaveLength(1);
    expect(s.notes![0]).toMatchObject({
      text: "New-warehouse news surfaced mid-size operators.",
      tags: ["new_facility", "3pl"],
      runId: s.id,
      at: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + NOTE_TTL_MS).toISOString(),
    });
    expect(NOTE_TTL_MS).toBe(60 * DAY);
  });

  it("validates length, tag count, URLs and undecided company names", async () => {
    const s = withLead(runState());
    s.caches.candidateCompanies.push("Initech Logistics, Inc.", "GoodCo");
    s.rejected.push({ company: "Rejecto LLC", code: "size", reason: "x", turn: 1 });
    const bad = async (input: Record<string, unknown>, pattern: RegExp) => {
      const r = await call(s, "remember", input);
      expect(r.result.is_error, JSON.stringify(input)).toBe(true);
      expect(String(r.result.content)).toMatch(pattern);
    };
    await bad({ text: "x".repeat(241), tags: [] }, /241 characters; the limit is 240/);
    await bad({ text: "", tags: [] }, /empty/);
    await bad({ text: "ok", tags: ["a", "b", "c", "d", "e", "f", "g"] }, /7 tags; the limit is 6/);
    await bad({ text: "see https://example.com/page", tags: [] }, /URL/);
    await bad({ text: "see example.com", tags: [] }, /URL/);
    await bad({ text: "ok", tags: ["www.thing.org"] }, /URL/);
    await bad({ text: "Initech Logistics was a dead end.", tags: [] }, /Initech Logistics/);
    await bad({ text: "ok", tags: ["initech logistics"] }, /Initech Logistics/);
    // decided companies (accepted or rejected) are allowed
    expect((await call(s, "remember", { text: "GoodCo-style regional operators fit.", tags: [] })).result.is_error).not.toBe(true);
    expect((await call(s, "remember", { text: "Rejecto LLC showed that big groups fail on size.", tags: [] })).result.is_error).not.toBe(true);
    expect(s.notes).toHaveLength(2); // the failed calls stored nothing
  });

  it("allows at most 3 per run", async () => {
    const s = withLead(runState());
    for (let i = 1; i <= 3; i += 1) expect((await call(s, "remember", { text: `lesson ${i}`, tags: [] })).result.is_error).not.toBe(true);
    const fourth = await call(s, "remember", { text: "lesson 4", tags: [] });
    expect(fourth.result.is_error).toBe(true);
    expect(String(fourth.result.content)).toMatch(/at most 3/);
    expect(s.notes).toHaveLength(3);
  });

  it("finish is held back once when a lead exists and no note was written; the second finish ends the run", async () => {
    const s = withLead(runState());
    const first = await call(s, "finish", { summary: "found one" });
    expect(first.finish).toBeFalsy();
    expect(String(first.result.content)).toMatch(/Not finished yet/);
    expect(s.rememberNudged).toBe(true);
    expect(s.summary).toBe("found one");
    const second = await call(s, "finish", { summary: "found one" });
    expect(second.finish).toBe(true);
    // a run that already wrote a note is not nudged
    const t = withLead(runState());
    await call(t, "remember", { text: "lesson", tags: [] });
    expect((await call(t, "finish", { summary: "x" })).finish).toBe(true);
    // nothing to remember from a run with no lead and no handback
    expect((await call(runState(), "finish", { summary: "declined" })).finish).toBe(true);
  });

  it("validateNote rejects non-array tags", () => {
    const s = withLead(runState());
    expect(validateNote(s, { text: "ok", tags: "a,b" })).toMatchObject({ ok: false });
  });
});

describe("memory_recalled event and state.memoryRecall", () => {
  it("is written once on the first turn with counts and included ids; the log is on the run state", async () => {
    const w = ws();
    const memory = mem({
      seen: [seenItem("OldCo")],
      preferences: [pref({ id: "p-in" })],
      notes: [note({ id: "n-in", tags: ["new_facility"] }), note({ id: "n-dead", expiresAt: iso(NOW.getTime() - 1) })],
    });
    const recalled = recall(memory, plan(), { budgetTokens: RECALL_BUDGET_TOKENS, now: NOW });
    const s = createRunState({ id: crypto.randomUUID(), workspaceId: w, plan: plan(), recalled, createdAt: NOW.toISOString() });
    expect(s.memoryRecall).toEqual(recalled.log);
    expect(s.caches.seenKeys).toEqual([squashName("OldCo")]);
    expect(s.contract.preferenceNotes).toEqual(["User rejected Acme: not a 3pl"]);
    expect(s.contract.recalledNotes).toEqual(["2026-10-14: a note"]);
    const first = String(s.messages[0]!.content);
    expect(first).toContain("## From earlier runs in this workspace");
    expect(first).toContain("- 2026-10-14: a note");

    const create = vi.fn(async () => ({
      id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "t1", name: "update_todo", input: { markdown: "x" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const loopDeps = { client: { messages: { create } } as never, checkLead: (() => ({ ok: true })) as never, now: NOW } as LoopDeps;
    s.strategyApproved = true;
    const result = await step(s, loopDeps);
    const recalledEvents = result.events.filter((e) => e.kind === "memory_recalled");
    expect(recalledEvents).toHaveLength(1);
    expect(recalledEvents[0]).toMatchObject({
      seen: 1,
      preferences: { considered: 1, included: 1 },
      notes: { considered: 2, included: 1 },
      includedIds: expect.arrayContaining(["p-in", "n-in"]),
    });
    expect(recalledEvents[0]!.includedIds).not.toContain("n-dead");
    await step(s, loopDeps);
    const all = await readLastEvents(s.id, 1000);
    expect(all.filter((e) => e.kind === "memory_recalled")).toHaveLength(1); // not repeated on turn 2
  });

  it("a run built without recall (legacy callers) emits no memory_recalled event", () => {
    const s = createRunState({ id: crypto.randomUUID(), workspaceId: ws(), plan: plan() });
    expect(s.memoryRecall).toBeUndefined();
  });
});

describe("already_seen provenance", () => {
  const seenRun = () => {
    const recalled = recall(mem({ seen: [seenItem("Acme Corp", { at: "2026-10-12T09:00:00.000Z" })] }), plan(), { budgetTokens: 100, now: NOW });
    const s = createRunState({ id: crypto.randomUUID(), workspaceId: ws(), plan: plan(), recalled, createdAt: NOW.toISOString() });
    s.strategyApproved = true;
    return s;
  };

  it("lookup_company skips the paid lookup for a seen company and says why, with its provenance", async () => {
    const s = seenRun();
    const lookup = vi.fn();
    const r = await executeTool(s, { id: "l1", name: "lookup_company", input: { name: "ACME Corp." } }, { checkLead: (() => ({ ok: true })) as never, now: NOW, lookupCompany: lookup as never }, { guard: new CostGuard(1) });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.exaCost).toBe(0);
    expect(r.seen).toEqual({ name: "Acme Corp", verdict: "accepted", at: "2026-10-12T09:00:00.000Z", runId: "run-0" });
    expect(String(r.result.content)).toContain("delivered on 2026-10-12 in an earlier run");
    expect(s.screened?.map((x) => [x.company, x.code])).toEqual([["ACME Corp.", "already_seen"]]);
  });

  it("the live feed says Skipped ..., delivered 12 Oct in an earlier run, lookup saved", () => {
    const skipped = eventLine({
      ts: "", runId: "r", turn: 3, kind: "tool_call", promptVersion: "x", tool: "lookup_company", is_error: false,
      input: { name: "Acme Corp" }, seen: { name: "Acme Corp", verdict: "accepted", at: "2026-10-12T09:00:00.000Z", runId: "run-0" }, lookupSaved: true,
    });
    expect(skipped).toEqual({ text: "Skipped Acme Corp, delivered 12 Oct in an earlier run, lookup saved", tone: "info" });
    const atSubmit = eventLine({
      ts: "", runId: "r", turn: 3, kind: "submit_verdict", promptVersion: "x", company: "Acme Corp", ok: false, code: "already_seen",
      reason: "company was delivered or rejected in an earlier run", seen: { name: "Acme Corp", verdict: "rejected", at: "2026-10-03T00:00:00.000Z", runId: "run-0" },
    });
    expect(atSubmit!.text).toBe("Skipped Acme Corp, turned down 3 Oct in an earlier run");
    // without provenance (older runs) the old wording stays
    expect(eventLine({ ts: "", runId: "r", turn: 3, kind: "submit_verdict", promptVersion: "x", company: "Acme Corp", ok: false, code: "already_seen", reason: "" })!.text).toMatch(/^Turned down Acme Corp/);
    expect(seenWhen({ verdict: "accepted", at: "not a date" })).toBe("delivered");
    expect(screenedFrom([{ ts: "", runId: "r", turn: 1, kind: "tool_call", promptVersion: "x", tool: "lookup_company", input: { name: "Acme Corp" }, seen: { verdict: "accepted" } }])).toEqual({ skipped: ["Acme Corp"], lookedUp: [] });
  });
});

describe("memory API", () => {
  const params = (id: string, itemId?: string) => ({ params: { id, ...(itemId ? { itemId } : {}) } }) as never;

  it("GET returns the lists with provenance (active only, seen bounded to the last 50); DELETE removes one item and nothing else", async () => {
    const w = ws();
    const seen = Array.from({ length: 60 }, (_, i) => seenItem(`Co ${i}`, { id: `seen-${i}`, at: iso(NOW.getTime() - (100 - i) * 1000), signalUrl: i === 59 ? "https://n.example/59" : undefined }));
    await saveMemory(w, mem({
      seen,
      preferences: [pref({ id: "p-old", company: "Acme", supersededBy: "p-new" }), pref({ id: "p-new", company: "Acme", verdict: "up", runId: "run-9" })],
      notes: [note({ id: "n-live", text: "live note", expiresAt: iso(Date.now() + DAY) }), note({ id: "n-old", expiresAt: iso(Date.now() - DAY) })],
    }) as WorkspaceMemory);

    const res = await memoryGET(new Request("http://x"), params(w));
    const body = await res.json();
    expect(body.seenCount).toBe(60);
    expect(body.seen).toHaveLength(50);
    expect(body.seen[0]).toMatchObject({ id: "seen-59", name: "Co 59", signalUrl: "https://n.example/59", runId: "run-0", verdict: "accepted" });
    expect(body.preferences.map((p: Preference) => p.id)).toEqual(["p-new"]);
    expect(body.preferences[0]).toMatchObject({ company: "Acme", verdict: "up", runId: "run-9" });
    expect(body.notes.map((n: Note) => n.id)).toEqual(["n-live"]);
    expect(body.preferenceNotes).toEqual(["User liked Acme: not a 3pl"]);

    const del = await itemDELETE(new Request("http://x", { method: "DELETE" }), params(w, "seen-3"));
    expect(del.status).toBe(200);
    const after = await loadMemory(w);
    expect(after.seen).toHaveLength(59);
    expect(after.seen.map((s) => s.id)).not.toContain("seen-3");
    expect(after.preferences).toHaveLength(2);
    expect(after.notes).toHaveLength(2);

    expect((await itemDELETE(new Request("http://x", { method: "DELETE" }), params(w, "seen-3"))).status).toBe(404);
    expect((await itemDELETE(new Request("http://x", { method: "DELETE" }), params(w, "bad id!"))).status).toBe(400);
    expect((await itemDELETE(new Request("http://x", { method: "DELETE" }), params("../x", "p-new"))).status).toBe(400);
    expect(await deleteMemoryItem(w, "n-live")).toBe(true);
    expect((await loadMemory(w)).notes.map((n) => n.id)).toEqual(["n-old"]);
    expect((await loadMemory(w)).preferences).toHaveLength(2);
  });

  it("feedback keeps run and signal provenance and supersedes an earlier vote", async () => {
    const w = ws();
    const runId = crypto.randomUUID();
    const post = (b: unknown) => feedbackPOST(new Request("http://x", { method: "POST", body: JSON.stringify(b) }), params(w));
    expect((await post({ company: "Acme", verdict: "down", reason: "no", runId, signal_url: "https://n.example/a" })).status).toBe(200);
    expect((await post({ company: "Acme", verdict: "up" })).status).toBe(200);
    const m = await loadMemory(w);
    expect(m.preferences[0]).toMatchObject({ runId, signalUrl: "https://n.example/a", supersededBy: m.preferences[1]!.id });
    expect(m.preferenceNotes).toEqual(["User liked Acme"]);
  });
});

describe("MemoryPanel", () => {
  const view: MemoryView = {
    seenCount: 2,
    seen: [
      { id: "s1", name: "Acme Corp", squashed: "acmecorp", verdict: "accepted", reason: "accepted", runId: "r1", at: "2026-10-12T09:00:00.000Z" },
      { id: "s2", name: "Bolt Ltd", squashed: "boltltd", verdict: "rejected", reason: "size: x", runId: "r1", at: "2026-10-03T09:00:00.000Z" },
    ],
    preferences: [{ id: "p1", company: "Acme Corp", verdict: "down", reason: "runs its own fleet", at: "2026-10-13T09:00:00.000Z" }],
    notes: [{ id: "n1", text: "New-warehouse news worked.", tags: ["new_facility"], runId: "r1", at: "2026-10-12T09:00:00.000Z", expiresAt: "2026-12-11T09:00:00.000Z" }],
    preferenceNotes: [],
  };
  const html = (v: MemoryView | null, over: Partial<{ error: boolean; disabled: boolean }> = {}) =>
    renderToStaticMarkup(createElement(MemoryPanel, { memory: v, error: over.error ?? false, onClear: () => undefined, onForget: () => undefined, disabled: over.disabled ?? false }));

  it("renders the three groups with provenance and a forget button per item, plus clear-all", () => {
    const out = html(view);
    expect(out).toContain("Companies already seen");
    expect(out).toContain("Your feedback");
    expect(out).toContain("What the agent learned");
    expect(out).toContain("Acme Corp");
    expect(out).toContain("delivered 12 Oct");
    expect(out).toContain("turned down 3 Oct");
    expect(out).toContain("Rejected 13 Oct");
    expect(out).toContain("runs its own fleet");
    expect(out).toContain("New-warehouse news worked.");
    expect(out).toContain("12 Oct · expires 11 Dec");
    expect(out.match(/class="memory-forget"/g)).toHaveLength(4);
    expect(out).toContain('aria-label="Forget Acme Corp"');
    expect(out).toContain("Clear memory");
  });

  it("omits empty groups, shows the empty and error states, and disables forgetting during a run", () => {
    const onlyNotes = html({ ...view, seen: [], seenCount: 0, preferences: [] });
    expect(onlyNotes).toContain("What the agent learned");
    expect(onlyNotes).not.toContain("Companies already seen");
    expect(onlyNotes).not.toContain("Your feedback");
    expect(html({ ...view, seen: [], seenCount: 0, preferences: [], notes: [] })).toContain("Nothing yet.");
    expect(html(null, { error: true })).toContain("Couldn&#x27;t load memory.");
    expect(html(view, { disabled: true })).toMatch(/class="memory-forget"[^>]*disabled=""/);
  });
});

describe("demo: second workspace state and the skipped line", () => {
  it("DEMO_MODE=1: GET /memory shows the seeded workspace, with provenance", async () => {
    const w = ws();
    process.env.DEMO_MODE = "1";
    try {
      const body = await (await memoryGET(new Request("http://x"), { params: { id: w } } as never)).json();
      expect(body.seen).toHaveLength(2);
      expect(body.seen[0]).toMatchObject({ verdict: "accepted", runId: expect.any(String), signalUrl: expect.stringMatching(/^https:/) });
      expect(body.notes).toHaveLength(1);
    } finally {
      delete process.env.DEMO_MODE;
    }
  });

  it("seeds from the recording only, once; the recorded run skips the seeded companies and the feed says so", async () => {
    const w = ws();
    const rec = JSON.parse(await readFile(join(process.cwd(), "eval", "demo", "run", "state.json"), "utf8"));
    await seedDemoMemory(w);
    const seeded = await loadMemory(w);
    // only the recording's own leads, with its run id and date; one self-note with an expiry
    expect(seeded.seen.map((s) => s.name)).toEqual([rec.leads[0].company, rec.leads[rec.leads.length - 1].company]);
    expect(seeded.seen.every((s) => s.runId === rec.id && s.at === rec.createdAt && rec.leads.some((l: { signal_url: string }) => l.signal_url === s.signalUrl))).toBe(true);
    expect(seeded.notes).toHaveLength(1);
    expect(Date.parse(seeded.notes[0]!.expiresAt)).toBeGreaterThan(Date.now());
    // seeding is once per workspace: after "Clear memory" it stays cleared
    await clearMemory(w);
    await seedDemoMemory(w);
    expect((await loadMemory(w)).seen).toEqual([]);

    // a second workspace: run the demo to the end
    const w2 = ws();
    const { id } = await createDemoRun(w2);
    const feed: Array<string | undefined> = [];
    let status = "running";
    for (let i = 0; i < 60 && (status === "running" || status === "awaiting_approval"); i += 1) {
      const out = await demoStep(id);
      status = out.status;
      for (const e of out.events) feed.push(eventLine(e)?.text);
      if (status === "awaiting_approval") {
        const { demoDecide } = await import("../src/demo/replay");
        await demoDecide(id, { approve: true });
        status = "running";
      }
    }
    expect(status).not.toBe("running");
    const skippedLines = feed.filter((t) => t?.startsWith("Skipped "));
    expect(skippedLines).toHaveLength(2);
    expect(skippedLines[0]).toMatch(new RegExp(`^Skipped ${rec.leads[0].company}, delivered 12 Oct in an earlier run, lookup saved$`));
    const snap = await demoSnapshot(id);
    expect(snap.leads.map((l) => l.company)).toEqual(rec.leads.slice(1, -1).map((l: { company: string }) => l.company));
    expect(snap.leads).toHaveLength(rec.leads.length - 2);
    expect(snap.screened?.find((s) => s.code === "already_seen")?.count).toBe(2);
    expect(snap.handback?.shortfall).toBe(`${rec.leads.length - 2} of ${rec.contract.targetLeads}`);
    expect(snap.spend.total).toBeLessThan(rec.spend.total);
    // the finished demo run is written to memory without re-adding the skipped companies
    const after = await loadMemory(w2);
    expect(after.seen).toHaveLength(rec.leads.length);
    expect(new Set(after.seen.map((s) => s.squashed)).size).toBe(rec.leads.length);
  });
});
