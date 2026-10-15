import { existsSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Temp RUNS_DIR / WORKSPACES_DIR before any module reads them; never the real ./runs or ./workspaces.
const dirs = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "memory-eval-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  return { root, workspaces: join(root, "workspaces") };
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/agent/events";
import { loadMemory, saveMemory } from "../src/agent/memory";
import type { RunState } from "../src/agent/state";
import { squashName } from "../src/gates";
import type { SearchPlan } from "../src/plan";
import { assertEvalWorkspace, runCell } from "./harness/run-cell";
import type { RunRecord, Scenario, Verdict } from "./harness/types";
import { cellMetrics, memoryVerdict, renderReport, runMemoryEval, searchQueries, SpendGuardError, type CellMetrics } from "./memory-eval";

afterAll(() => rmSync(dirs.root, { recursive: true, force: true }));

const plan: SearchPlan = {
  label: "Memory eval scenario",
  months: 3,
  signalQueries: ["expansion"],
  signalSummaryQuery: "signal",
  companySummaryQuery: "company",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};
const scenario: Scenario = { id: "S1", label: plan.label, plan, targetLeads: 10, maxCostDollars: 1 };

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

const seedMemory = () => ({
  version: 2,
  seen: [{ id: "seen_1", name: "GoodCo", squashed: squashName("GoodCo"), verdict: "accepted", reason: "accepted", runId: "run-old", at: iso(-1), signalUrl: "https://news.example/goodco", leadIndex: 0 }],
  preferences: [{ id: "pref_1", company: "BigCo", verdict: "down", reason: "too large", at: iso(-1) }],
  notes: [{ id: "note_1", text: "Expansion news finds operators.", tags: ["expansion"], runId: "run-old", at: iso(-1), expiresAt: iso(30) }],
});

const cellDeps = (over: Record<string, unknown> = {}) => ({
  createClient: () => ({ messages: { create: vi.fn() } }) as never,
  checkLead: vi.fn() as never,
  ...over,
});

const finishing = (state: RunState) => {
  state.status = "done";
  state.stopReason = "finish";
  return state;
};

describe("run-cell --workspace", () => {
  let results: string;
  beforeEach(async () => {
    results = await mkdtemp(join(tmpdir(), "memory-eval-results-"));
  });

  it("loads the workspace's memory, recalls it into the run, and records memoryBefore and the recall summary in run.json", async () => {
    await saveMemory("mem-eval-t1-S1", seedMemory() as never);
    const before = await loadMemory("mem-eval-t1-S1");
    let seenInRun: RunState | undefined;
    const drive = vi.fn(async (state: RunState) => {
      seenInRun = JSON.parse(JSON.stringify(state)) as RunState;
      return finishing(state);
    });
    const record = await runCell(scenario, "B_agent_opus", 2, cellDeps({ driveRun: drive, workspaceId: "mem-eval-t1-S1", resultsRoot: results, runSetId: "t1" }));

    expect(seenInRun!.workspaceId).toBe("mem-eval-t1-S1");
    expect(seenInRun!.caches.seenKeys).toEqual([squashName("GoodCo")]);
    expect(seenInRun!.caches.seenInfo?.[squashName("GoodCo")]).toMatchObject({ name: "GoodCo", verdict: "accepted", runId: "run-old" });
    expect(seenInRun!.contract.preferenceNotes).toEqual(["User rejected BigCo: too large"]);
    expect(seenInRun!.contract.recalledNotes?.[0]).toContain("Expansion news finds operators.");

    expect(record.workspaceId).toBe("mem-eval-t1-S1");
    expect(record.memoryBefore).toEqual({ version: 2, seen: before.seen, preferences: before.preferences, notes: before.notes });
    expect(record.memoryRecalled).toEqual({
      seen: 1,
      preferences: { considered: 1, included: 1 },
      notes: { considered: 1, included: 1 },
      includedIds: expect.arrayContaining(["pref_1", "note_1"]),
    });
    const onDisk = JSON.parse(await readFile(join(results, "t1/S1/B_agent_opus/2/run.json"), "utf8")) as RunRecord;
    expect(onDisk.memoryBefore?.seen).toHaveLength(1);
    expect(onDisk.memoryRecalled?.notes.included).toBe(1);
  });

  it("without the flag a cell is memoryless, uses its own eval-* id, and writes no memory fields", async () => {
    await saveMemory("mem-eval-t2-S1", seedMemory() as never);
    let seenInRun: RunState | undefined;
    const drive = vi.fn(async (state: RunState) => {
      seenInRun = JSON.parse(JSON.stringify(state)) as RunState;
      return finishing(state);
    });
    const record = await runCell(scenario, "B_agent_opus", 1, cellDeps({ driveRun: drive, resultsRoot: results, runSetId: "t2" }));
    expect(seenInRun!.workspaceId).toBe("eval-S1-B_agent_opus-1");
    expect(seenInRun!.caches.seenKeys).toEqual([]);
    expect(seenInRun!.memoryRecall).toBeUndefined();
    expect(record).not.toHaveProperty("memoryBefore");
    expect(record).not.toHaveProperty("workspaceId");
  });

  it("refuses any workspace that is not eval-prefixed and creates nothing for it", async () => {
    const real = "3f2a9c1e-77aa-4c0e-9d11-0123456789ab";
    const drive = vi.fn(async (state: RunState) => finishing(state));
    await expect(runCell(scenario, "B_agent_opus", 1, cellDeps({ driveRun: drive, workspaceId: real, resultsRoot: results, runSetId: "t3" }))).rejects.toThrow(/refused/);
    expect(drive).not.toHaveBeenCalled();
    expect(existsSync(join(dirs.workspaces, real))).toBe(false);
    expect(() => assertEvalWorkspace("../mem-eval-x")).toThrow(/refused/);
    expect(() => assertEvalWorkspace("mem-eval-ok_1")).not.toThrow();
    await expect(runCell(scenario, "A_workflow", 1, cellDeps({ workspaceId: "mem-eval-t3-S1", resultsRoot: results, runSetId: "t3" }))).rejects.toThrow(/agent arm/);
  });
});

/* ---- metrics from fixture events ---- */

const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ ts: "2026-10-12T00:00:00.000Z", runId: "r", turn: 1, kind, promptVersion: "v", ...payload });
const search = (query: string, resultSummary: string) => ev("tool_call", { tool: "search_signals", input: { query }, is_error: false, resultSummary });
const lookup = (name: string, seen?: boolean) => ev("tool_call", { tool: "lookup_company", input: { name }, is_error: false, ...(seen ? { seen: { name, verdict: "accepted", at: "x", runId: "a" }, lookupSaved: true } : {}) });
const remember = (isError = false) => ev("tool_call", { tool: "remember", input: {}, is_error: isError });

const lead = (company: string) => ({ company, signal_url: `https://news.example/${squashName(company)}`, why_now: "x", event_date: "2026-10-01", size_basis: "quoted" });
const rec = (companies: string[], total: number): RunRecord => ({
  scenarioId: "S1", arm: "B_agent_opus", rep: 1, leads: companies.map(lead),
  spend: { exa: total / 2, claude: total / 2, total }, activeMs: 1, stopReason: "finish",
  startedAt: "x", finishedAt: "x", maxCostDollars: 1, targetLeads: 10,
});
const verdictsOf = (goodCompanies: string[]) => (company: string): Verdict | undefined =>
  ({ good: goodCompanies.includes(company), company } as Verdict);

const eventsA = [
  search("Warehouse Expansion, new facility!", "2 results of 2: Alpha Co, Beta, Inc."),
  search("permit filings for docks", "0 results of 0"),
  search("hiring wave in ports", "3 results of 3: Zed, Yan, Xi"),
  lookup("Alpha Co"), lookup("Beta, Inc."), remember(),
];
const eventsB = [
  ev("memory_recalled", { seen: 2, preferences: { considered: 0, included: 0 }, notes: { considered: 2, included: 2 }, includedIds: ["n1", "n2"] }),
  search("Permit filings   for DOCKS", "0 results of 0"),
  search("new distribution centers", "2 results of 2: Gamma, Delta"),
  lookup("Alpha Co", true), lookup("Beta, Inc.", true), lookup("Gamma"), lookup("Delta"),
  remember(), remember(), remember(true),
];

describe("memory eval metrics", () => {
  it("attributes accepted leads to searches by company name, punctuation-proof", () => {
    const q = searchQueries(eventsA, ["Alpha Co", "Beta, Inc."]);
    expect(q.all).toHaveLength(3);
    expect(q.dead).toEqual(["permit filings for docks", "hiring wave in ports"]);
  });

  it("computes skips, saved dollars, new-vs-A, notes, dead-query overlap, cost per good from fixture events", () => {
    const a = cellMetrics({ label: "A", record: rec(["Alpha Co", "Beta, Inc."], 0.4), events: eventsA, verdictFor: verdictsOf(["Alpha Co"]) });
    expect(a).toMatchObject({ leads: 2, good: 1, unjudged: 0, lookupsSkipped: 0, savedDollars: 0, notesWritten: 1, notesRecalled: 0, spend: 0.4, costPerGood: 0.4 });
    expect(a.deadQueries).toEqual(["permit filings for docks", "hiring wave in ports"]);

    const b = cellMetrics({
      label: "B", record: rec(["Alpha Co", "Gamma", "Delta"], 0.3), events: eventsB, verdictFor: verdictsOf(["Gamma", "Delta"]),
      vs: { record: rec(["Alpha Co", "Beta, Inc."], 0.4), deadQueries: a.deadQueries },
    });
    expect(b.lookupsSkipped).toBe(2);
    expect(b.savedDollars).toBeCloseTo(0.018, 10);
    expect(b.newVsA).toEqual({ newCount: 2, repeated: ["Alpha Co"] });
    expect(b.notesWritten).toBe(2); // the errored remember does not count
    expect(b.notesRecalled).toBe(2);
    expect(b.deadOverlap).toEqual({ count: 1, of: 2, queries: ["permit filings for docks"] }); // normalised match, distinct
    expect(b.good).toBe(2);
    expect(b.costPerGood).toBeCloseTo(0.15, 10);
  });

  it("counts a lead with no verdict as unjudged, not as bad", () => {
    const m = cellMetrics({ label: "A", record: rec(["Alpha Co", "Beta, Inc."], 0.2), events: [], verdictFor: (c) => (c === "Alpha Co" ? ({ good: true } as Verdict) : undefined) });
    expect(m).toMatchObject({ leads: 2, good: 1, unjudged: 1 });
  });
});

describe("memory eval pass rule", () => {
  const m = (over: Partial<CellMetrics>): CellMetrics => ({
    label: "B", leads: 5, good: 4, unjudged: 0, newVsA: { newCount: 5, repeated: [] }, lookupsSkipped: 3, savedDollars: 0.027,
    notesWritten: 1, notesRecalled: 1, searchQueries: [], deadQueries: [], spend: 0.5, costPerGood: 0.125, ...over,
  });

  it("PASS: skipped >= 2, every B lead new, good(B) >= good(B') - 2", () => {
    expect(memoryVerdict(m({ good: 3 }), m({ label: "B'", good: 5 }))).toEqual({ pass: true, reasons: [] });
  });

  it("FAIL, with the reason, on each clause", () => {
    const bp = m({ label: "B'", good: 5 });
    expect(memoryVerdict(m({ lookupsSkipped: 1 }), bp).reasons[0]).toMatch(/skipped 1 lookups/);
    expect(memoryVerdict(m({ newVsA: { newCount: 4, repeated: ["Alpha Co"] } }), bp).reasons[0]).toMatch(/already delivered by A \(Alpha Co\)/);
    expect(memoryVerdict(m({ good: 2 }), bp).reasons[0]).toMatch(/good\(B\) = 2 is more than 2 below good\(B'\) = 5/);
    expect(memoryVerdict(m({ leads: 0, good: 0, newVsA: { newCount: 0, repeated: [] } }), m({ label: "B'", good: 1 })).reasons[0]).toMatch(/no leads/);
    expect(memoryVerdict(m({ unjudged: 1 }), bp).reasons[0]).toMatch(/no verdict/);
    expect(memoryVerdict(m({ good: 3, lookupsSkipped: 0 }), bp).pass).toBe(false);
  });

  it("the report carries the table, the verdict line and the reason", () => {
    const a = m({ label: "A", newVsA: undefined, lookupsSkipped: 0, savedDollars: 0 });
    const out = renderReport({ setId: "s", scenarioId: "S1", dryRun: false, cells: [a, m({ lookupsSkipped: 0 }), m({ label: "B'" })], workspaces: { main: "mem-eval-s-S1", control: "mem-eval-s-S1-control" }, judgeDollars: 0.5, maxDollars: 4, generatedAt: "2026-10-15T00:00:00.000Z" });
    expect(out.markdown).toContain("| run | leads | good (judged) | new vs A | lookups skipped | Exa $ saved | notes written | notes recalled | dead-query overlap | spend | $ / good lead |");
    expect(out.markdown).toMatch(/\*\*Verdict: FAIL\*\*: B skipped 0 lookups/);
    expect(out.verdict.pass).toBe(false);
  });
});

/* ---- end to end with the fake loop ---- */

describe("memory-eval --dry-run, end to end", () => {
  const scratch = async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-eval-e2e-"));
    return { root, resultsRoot: join(root, "results"), truthRoot: join(root, "truth"), recordingsRoot: join(root, "recordings") };
  };

  it("runs A, B, B' on the real loop with fakes, writes memory files and the report, and passes", async () => {
    const s = await scratch();
    const log = vi.fn();
    const out = await runMemoryEval({ setId: "e2e", scenarioId: "S1", dryRun: true, ...s, now: new Date("2026-10-12T00:00:00.000Z"), log });
    const [a, b, bp] = out.metrics;

    expect(out.verdict).toEqual({ pass: true, reasons: [] });
    expect(a).toMatchObject({ leads: 2, lookupsSkipped: 0, notesWritten: 1, notesRecalled: 0 });
    expect(b).toMatchObject({ leads: 2, lookupsSkipped: 2, notesWritten: 1, notesRecalled: 1 });
    expect(b.newVsA).toEqual({ newCount: 2, repeated: [] });
    expect(b.savedDollars).toBeCloseTo(0.018, 10);
    expect(bp).toMatchObject({ lookupsSkipped: 0 });
    expect(bp.newVsA?.repeated.sort()).toEqual(["GoodCo", "SecondCo"]); // the control re-finds A's leads: memory is what made B different
    expect(b.deadOverlap?.count).toBe(0);
    expect(bp.deadOverlap?.count).toBe(1);
    expect(a.deadQueries).toEqual(["obscure shipping dock permit filings"]);
    expect(out.totalSpend).toBeGreaterThan(0);
    expect(out.totalSpend).toBeLessThan(1);

    // B really was handed A's memory.
    expect(out.records[1].memoryBefore?.seen.map((x) => (x as { name: string }).name).sort()).toEqual(["GoodCo", "SecondCo"]);
    expect(out.records[0].memoryBefore?.seen).toEqual([]);
    expect(out.records[2].memoryBefore?.seen).toEqual([]);
    expect(out.records.map((r) => r.workspaceId)).toEqual(["mem-eval-e2e-S1", "mem-eval-e2e-S1", "mem-eval-e2e-S1-control"]);

    const setDir = join(s.resultsRoot, "e2e");
    const afterA = JSON.parse(await readFile(join(setDir, "memory-after-A.json"), "utf8")) as { seen: unknown[]; notes: unknown[] };
    const afterB = JSON.parse(await readFile(join(setDir, "memory-after-B.json"), "utf8")) as { seen: unknown[]; notes: unknown[] };
    expect(afterA.seen).toHaveLength(2);
    expect(afterA.notes).toHaveLength(1);
    expect(afterB.seen).toHaveLength(4);
    expect(afterB.notes).toHaveLength(2);

    const report = await readFile(join(setDir, "report.md"), "utf8");
    expect(report).toContain("DRY RUN");
    expect(report).toContain("**Verdict: PASS**");
    expect(report).toMatch(/\| B \| 2 \| 2 \| 2\/2 \| 2 \| \$0\.0180 \| 1 \| 1 \| 0\/1 \|/);
    expect(existsSync(join(setDir, "S1/B_agent_opus/2/events.jsonl"))).toBe(true);
    // Judged ONLY once per distinct (company, signal): GoodCo and SecondCo are shared by A and B'.
    expect(log.mock.calls.map((c) => String(c[0]))).toContain("judging: 4 distinct (company, signal) leads, 0 already have a verdict, 4 to judge");

    // The dry run touched no real tree: its truth dir is the scratch one.
    expect(existsSync(join(s.truthRoot, "S1"))).toBe(true);
    expect(existsSync(join("eval/results", "e2e"))).toBe(false);
    expect(existsSync(join("eval/truth/S1", "goodco__x"))).toBe(false);
  });

  it("a second eval over an existing verdict set judges only the leads without a verdict", async () => {
    const s = await scratch();
    const first = await runMemoryEval({ setId: "e2e-a", scenarioId: "S1", dryRun: true, ...s, now: new Date("2026-10-12T00:00:00.000Z"), log: () => undefined });
    expect(first.verdict.pass).toBe(true);
    const log = vi.fn();
    await runMemoryEval({ setId: "e2e-b", scenarioId: "S1", dryRun: true, ...s, now: new Date("2026-10-12T00:00:00.000Z"), log });
    expect(log.mock.calls.map((c) => String(c[0]))).toContain("judging: 4 distinct (company, signal) leads, 4 already have a verdict, 0 to judge");
  });

  it("the cost guard stops before a cell that could pass --max-dollars, and writes no report", async () => {
    const s = await scratch();
    // Each cell may spend up to S1's $1 cap: $1 admits A, then A's spend + $1 passes the cap before B.
    const run = runMemoryEval({ setId: "guard", scenarioId: "S1", dryRun: true, maxDollars: 1, ...s, now: new Date("2026-10-12T00:00:00.000Z"), log: () => undefined });
    await expect(run).rejects.toBeInstanceOf(SpendGuardError);
    await expect(run).rejects.toThrow(/stopping before B \(rep 2\).*--max-dollars 1.*no report written/);
    expect(existsSync(join(s.resultsRoot, "guard", "report.md"))).toBe(false);
    expect(existsSync(join(s.resultsRoot, "guard", "S1/B_agent_opus/1/run.json"))).toBe(true);
    expect(existsSync(join(s.resultsRoot, "guard", "S1/B_agent_opus/2/run.json"))).toBe(false);
  });

  it("refuses a set id that could escape the workspace namespace", async () => {
    const s = await scratch();
    await expect(runMemoryEval({ setId: "../x", scenarioId: "S1", dryRun: true, ...s, log: () => undefined })).rejects.toThrow(/must be 1-40/);
  });
});
