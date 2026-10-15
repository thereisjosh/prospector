/**
 * Memory eval: does what the agent remembers from run A change what run B finds, and is the change good?
 *
 *   npx tsx eval/memory-eval.ts --set <id> --scenario S1 [--max-dollars 4] [--dry-run]
 *
 * Three agent cells (arm B = Opus agent), same scenario, run in this order:
 *   A   rep 1  workspace mem-eval-<set>-<scenario>            memory empty (cleared first)
 *   B   rep 2  workspace mem-eval-<set>-<scenario>            memory = what A left behind
 *   B'  rep 3  workspace mem-eval-<set>-<scenario>-control    memory empty (cleared first): B's fair baseline
 * B vs B' separates "memory helped" from "a second run on the same scenario is just different".
 * Each cell is Exa-recorded to eval/recordings/<set>/<rep> (EXA_RECORD_DIR, set per cell) and written as a
 * Langfuse experiment item named <set>. Cells land in eval/results/<set>/<scenario>/B_agent_opus/<rep>.
 * Afterwards the leads are pooled blind and judged (only leads without a verdict in eval/truth are paid
 * for: the judge reuses verdicts keyed by company + signal URL), and eval/results/<set>/report.md is written,
 * with the memory file after A and after B beside it (memory-after-A.json, memory-after-B.json).
 *
 * Cost guard: before each cell, if spend so far + that cell's cap (the scenario's maxCostDollars) would exceed
 * --max-dollars (default 4), the eval stops there and says so. The judge's spend is reported, not guarded.
 *
 * Safety: workspaces are mem-eval-* (run-cell refuses any id without an eval prefix), cleared at the start so a
 * re-run of the same set never inherits memory. They live in WORKSPACES_DIR (default ./workspaces, gitignored);
 * set WORKSPACES_DIR / RUNS_DIR to scratch directories to keep them out of ./workspaces and ./runs altogether.
 *
 * --dry-run: the real loop, recall and memory code run against a scripted model, canned Exa and a canned judge
 * (eval/harness/memory-eval-fakes.ts). Everything is written under a fresh temp directory (results, truth,
 * runs, workspaces), API keys and Langfuse keys are blanked, nothing is recorded anywhere. Zero spend.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { squashName } from "../src/gates";
import type { AgentEvent } from "../src/agent/events";
import { findVerdictFile } from "./harness/truth";
import type { MemorySnapshot, RunRecord, Scenario, Verdict } from "./harness/types";

/** Exa's company-lookup price, from src/exa.ts COST_ESTIMATE (list price, without the safety margin). */
export const LOOKUP_PRICE_DOLLARS = 0.009;

export const PASS_RULE = "PASS if B skipped >= 2 lookups AND every B lead is new vs A AND good(B) >= good(B') - 2 (pilot noise is +/-2); else FAIL.";

/* ------------------------------------------------------------------ metrics (pure) */

export type CellMetrics = {
  label: "A" | "B" | "B'";
  leads: number;
  good: number;
  unjudged: number;
  /** B and B' only: leads whose company A did not also deliver. */
  newVsA?: { newCount: number; repeated: string[] };
  lookupsSkipped: number;
  savedDollars: number;
  notesWritten: number;
  notesRecalled: number;
  searchQueries: string[];
  /** Queries that returned no accepted lead. */
  deadQueries: string[];
  /** B and B' only: how many of this cell's (normalised, distinct) queries are one of A's dead queries. */
  deadOverlap?: { count: number; of: number; queries: string[] };
  spend: number;
  costPerGood: number | undefined;
};

export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const toolCalls = (events: AgentEvent[], tool: string) => events.filter((e) => e.kind === "tool_call" && e.tool === tool);

/**
 * A search "found" an accepted lead when one of the run's accepted companies is named in its result line
 * ("3 results of 3: Acme, Beta, ..."). Companies are compared squashed, so punctuation in a name
 * ("Acme, Inc.") cannot split it.
 */
export function searchQueries(events: AgentEvent[], acceptedCompanies: string[]): { all: string[]; dead: string[] } {
  const accepted = acceptedCompanies.map(squashName).filter(Boolean);
  const all: string[] = [];
  const dead: string[] = [];
  for (const e of toolCalls(events, "search_signals")) {
    const query = String((e.input as { query?: unknown } | undefined)?.query ?? "").trim();
    if (!query) continue;
    all.push(query);
    const line = squashName(String(e.resultSummary ?? ""));
    if (!accepted.some((c) => line.includes(c))) dead.push(query);
  }
  return { all, dead };
}

export function cellMetrics(options: {
  label: CellMetrics["label"];
  record: RunRecord;
  events: AgentEvent[];
  verdictFor: (company: string, signalUrl: string) => Verdict | undefined;
  lookupPrice?: number;
  /** For B and B': the A cell, for new-vs-A and dead-query overlap. */
  vs?: { record: RunRecord; deadQueries: string[] };
}): CellMetrics {
  const { record, events } = options;
  const price = options.lookupPrice ?? LOOKUP_PRICE_DOLLARS;
  let good = 0;
  let unjudged = 0;
  for (const lead of record.leads) {
    const v = options.verdictFor(lead.company, lead.signal_url);
    if (!v) unjudged += 1;
    else if (v.good) good += 1;
  }
  const lookupsSkipped = toolCalls(events, "lookup_company").filter((e) => Boolean(e.seen)).length;
  const recalled = events.find((e) => e.kind === "memory_recalled") as { notes?: { included?: number } } | undefined;
  const queries = searchQueries(events, record.leads.map((l) => l.company));

  let newVsA: CellMetrics["newVsA"];
  let deadOverlap: CellMetrics["deadOverlap"];
  if (options.vs) {
    const aCompanies = new Set(options.vs.record.leads.map((l) => squashName(l.company)));
    const repeated = record.leads.filter((l) => aCompanies.has(squashName(l.company))).map((l) => l.company);
    newVsA = { newCount: record.leads.length - repeated.length, repeated };
    const dead = new Set(options.vs.deadQueries.map(normalizeQuery));
    const distinct = [...new Set(queries.all.map(normalizeQuery))];
    const overlapping = distinct.filter((q) => dead.has(q));
    deadOverlap = { count: overlapping.length, of: distinct.length, queries: overlapping };
  }
  return {
    label: options.label,
    leads: record.leads.length,
    good,
    unjudged,
    ...(newVsA ? { newVsA } : {}),
    lookupsSkipped,
    savedDollars: lookupsSkipped * price,
    notesWritten: toolCalls(events, "remember").filter((e) => e.is_error !== true).length,
    notesRecalled: recalled?.notes?.included ?? 0,
    searchQueries: queries.all,
    deadQueries: queries.dead,
    ...(deadOverlap ? { deadOverlap } : {}),
    spend: record.spend.total,
    costPerGood: good > 0 ? record.spend.total / good : undefined,
  };
}

export function memoryVerdict(b: CellMetrics, bPrime: CellMetrics): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (b.unjudged > 0 || bPrime.unjudged > 0) {
    reasons.push(`${b.unjudged + bPrime.unjudged} B/B' leads have no verdict, so good() cannot be compared`);
  }
  if (b.leads === 0) reasons.push("B delivered no leads, so nothing can be new or good");
  if (b.lookupsSkipped < 2) reasons.push(`B skipped ${b.lookupsSkipped} lookups (need >= 2)`);
  const repeated = b.newVsA?.repeated ?? [];
  if (repeated.length > 0) reasons.push(`${repeated.length} of B's ${b.leads} leads were already delivered by A (${repeated.join(", ")})`);
  if (b.good < bPrime.good - 2) reasons.push(`good(B) = ${b.good} is more than 2 below good(B') = ${bPrime.good}`);
  return { pass: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ report */

const money = (n: number) => `$${n.toFixed(4)}`;

export type NoteText = { text: string; tags: string[]; at: string };

export function renderReport(options: {
  setId: string;
  scenarioId: string;
  dryRun: boolean;
  cells: [CellMetrics, CellMetrics, CellMetrics];
  workspaces: { main: string; control: string };
  judgeDollars: number;
  maxDollars: number;
  memoryAfterA?: { seen: number; preferences: number; notes: NoteText[] };
  generatedAt: string;
}): { markdown: string; verdict: { pass: boolean; reasons: string[] } } {
  const [a, b, bp] = options.cells;
  const verdict = memoryVerdict(b, bp);
  const cell = (v: string | number | undefined) => (v === undefined ? "-" : String(v));
  const rows = [a, b, bp].map((m) => [
    m.label === "B'" ? "B' (control)" : m.label,
    m.leads,
    m.unjudged > 0 ? `${m.good} (+${m.unjudged} unjudged)` : m.good,
    m.newVsA && m.label === "B" ? `${m.newVsA.newCount}/${m.leads}` : m.newVsA ? `${m.newVsA.newCount}/${m.leads} (info)` : "-",
    m.lookupsSkipped,
    money(m.savedDollars),
    m.notesWritten,
    m.notesRecalled,
    m.deadOverlap ? `${m.deadOverlap.count}/${m.deadOverlap.of}` : "-",
    money(m.spend),
    m.costPerGood === undefined ? "-" : money(m.costPerGood),
  ].map(cell));
  const header = ["run", "leads", "good (judged)", "new vs A", "lookups skipped", "Exa $ saved", "notes written", "notes recalled", "dead-query overlap", "spend", "$ / good lead"];
  const table = [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");

  const lines: string[] = [
    `# Memory eval: ${options.setId} / ${options.scenarioId}${options.dryRun ? " (DRY RUN: fake loop, fake Exa, fake judge)" : ""}`,
    "",
    `Generated ${options.generatedAt}. A = first run in an empty workspace (\`${options.workspaces.main}\`); B = second run in the same workspace, with A's memory; B' = control, a first run in a separate empty workspace (\`${options.workspaces.control}\`).`,
    "",
    table,
    "",
    `**Verdict: ${verdict.pass ? "PASS" : "FAIL"}**${verdict.pass ? ` (B skipped ${b.lookupsSkipped} lookups, ${b.newVsA?.newCount ?? 0}/${b.leads} B leads are new vs A, good(B) ${b.good} vs good(B') ${bp.good})` : `: ${verdict.reasons.join("; ")}`}`,
    "",
    `Rule: ${PASS_RULE}`,
    "",
    "## Definitions",
    "",
    "- leads / good: leads delivered / of those, judged good (rubric Q1 and Q3 yes, Q2 not no), from the judge's verdict per company + signal URL.",
    "- new vs A: B leads whose company A did not also deliver. Shown for B' for information only.",
    `- lookups skipped: \`lookup_company\` events carrying \`seen\` (a company remembered from an earlier run, no paid lookup). Exa $ saved = skipped x ${money(LOOKUP_PRICE_DOLLARS)} (src/exa.ts COST_ESTIMATE.companyLookup, list price).`,
    "- notes written: `remember` calls that succeeded. notes recalled: notes in the `memory_recalled` event's included set.",
    "- dead-query overlap: distinct (normalised: lowercase, punctuation stripped) search queries of the run that equal a query of A that returned no accepted lead; a query counts as having returned a lead when an accepted company is named in its result line.",
    `- spend: cell spend (Claude + Exa) from run.json; cost per good lead = spend / good. Judge spend ${money(options.judgeDollars)} is separate and not in the table. Guard: --max-dollars ${options.maxDollars}.`,
    "",
    "## Detail",
    "",
  ];
  for (const m of [a, b, bp]) {
    lines.push(`### ${m.label}`, "", `- search queries (${m.searchQueries.length}): ${m.searchQueries.map((q) => `"${q}"`).join(", ") || "none"}`);
    lines.push(`- dead queries (${m.deadQueries.length}): ${m.deadQueries.map((q) => `"${q}"`).join(", ") || "none"}`);
    if (m.newVsA?.repeated.length) lines.push(`- repeated from A: ${m.newVsA.repeated.join(", ")}`);
    if (m.deadOverlap?.queries.length) lines.push(`- re-ran A's dead queries: ${m.deadOverlap.queries.map((q) => `"${q}"`).join(", ")}`);
    lines.push("");
  }
  if (options.memoryAfterA) {
    lines.push("### Memory after A", "", `${options.memoryAfterA.seen} seen, ${options.memoryAfterA.preferences} preferences, ${options.memoryAfterA.notes.length} notes (full files: memory-after-A.json, memory-after-B.json).`, "");
    for (const n of options.memoryAfterA.notes) lines.push(`- ${n.at.slice(0, 10)} [${n.tags.join(", ")}] ${n.text}`);
    lines.push("");
  }
  return { markdown: `${lines.join("\n")}\n`, verdict };
}

/* ------------------------------------------------------------------ orchestration */

export class SpendGuardError extends Error {
  constructor(message: string, readonly spentSoFar: number) {
    super(message);
    this.name = "SpendGuardError";
  }
}

export type MemoryEvalOptions = {
  setId: string;
  scenarioId: string;
  maxDollars?: number;
  dryRun?: boolean;
  /** Defaults: eval/results, eval/truth, eval/recordings. A dry run needs all of these pointed at scratch space. */
  resultsRoot?: string;
  truthRoot?: string;
  recordingsRoot?: string;
  runsDir?: string;
  now?: Date;
  log?: (line: string) => void;
};

export type MemoryEvalResult = {
  report: string;
  reportPath: string;
  verdict: { pass: boolean; reasons: string[] };
  metrics: [CellMetrics, CellMetrics, CellMetrics];
  records: [RunRecord, RunRecord, RunRecord];
  totalSpend: number;
  judgeDollars: number;
};

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readEvents(dir: string): Promise<AgentEvent[]> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
}

export async function runMemoryEval(options: MemoryEvalOptions): Promise<MemoryEvalResult> {
  const { setId, scenarioId } = options;
  const dryRun = options.dryRun === true;
  const maxDollars = options.maxDollars ?? 4;
  const log = options.log ?? ((line: string) => console.log(line));
  const resultsRoot = options.resultsRoot ?? "eval/results";
  const truthRoot = options.truthRoot ?? "eval/truth";
  const recordingsRoot = options.recordingsRoot ?? "eval/recordings";
  const now = options.now ?? new Date();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(setId)) throw new Error(`--set "${setId}" must be 1-40 letters, digits, - or _ (it becomes part of a workspace id)`);

  // Dynamic imports: the CLI sets RUNS_DIR / WORKSPACES_DIR (dry run) before anything reads src/agent/config.ts.
  const { assertEvalWorkspace, defaultScenario, normalizeArm, runCell, CellError } = await import("./harness/run-cell");
  const { clearMemory, loadMemory } = await import("../src/agent/memory");
  const { createBlindPool } = await import("./harness/blind");
  const { judgeBlind } = await import("./harness/judge");
  const fakes = dryRun ? await import("./harness/memory-eval-fakes") : undefined;

  const scenario: Scenario = defaultScenario(scenarioId);
  const arm = normalizeArm("B");
  const main = assertEvalWorkspace(`mem-eval-${setId}-${scenarioId}`);
  const control = assertEvalWorkspace(`mem-eval-${setId}-${scenarioId}-control`);
  const setDir = join(resultsRoot, setId);

  if (!dryRun && process.env.EXA_REPLAY_DIR) throw new Error("EXA_REPLAY_DIR is set: Exa would be replayed, not recorded. Unset it for the paid eval.");
  if (!dryRun) process.env.LANGFUSE_TRACING_ENVIRONMENT ||= "eval";

  // A re-run of the same set must not inherit memory. Both ids are eval-prefixed, so this cannot touch a real workspace.
  await clearMemory(main);
  await clearMemory(control);

  const plan: Array<{ label: "A" | "B" | "B'"; rep: number; workspaceId: string }> = [
    { label: "A", rep: 1, workspaceId: main },
    { label: "B", rep: 2, workspaceId: main },
    { label: "B'", rep: 3, workspaceId: control },
  ];
  const records: RunRecord[] = [];
  let spent = 0;
  const priorRecord = process.env.EXA_RECORD_DIR;
  const experimentCalls: string[] = [];
  try {
    for (const step of plan) {
      if (spent + scenario.maxCostDollars > maxDollars) {
        throw new SpendGuardError(
          `stopping before ${step.label} (rep ${step.rep}): spent $${spent.toFixed(4)} so far and this cell may spend up to $${scenario.maxCostDollars.toFixed(2)}, which would pass --max-dollars ${maxDollars}. ${records.length} cell(s) are on disk under ${setDir}; no report written.`,
          spent,
        );
      }
      if (!dryRun) process.env.EXA_RECORD_DIR = join(recordingsRoot, setId, String(step.rep));
      log(`--- ${step.label}: ${scenarioId} arm B rep ${step.rep} in workspace ${step.workspaceId}${dryRun ? " (dry run)" : ` (Exa recorded to ${process.env.EXA_RECORD_DIR})`}`);
      try {
        const record = await runCell(scenario, arm, step.rep, {
          workspaceId: step.workspaceId,
          runSetId: setId,
          resultsRoot,
          now,
          log,
          ...(options.runsDir ? { runsDir: options.runsDir } : {}),
          langfuseExperiment: setId,
          ...(dryRun
            ? {
              driveRun: fakes!.fakeDriveRun,
              checkLead: fakes!.fakeCheckLead,
              recordExperiment: async (name: string, cell: { record: RunRecord }) => { experimentCalls.push(`${name}:${cell.record.arm}:r${cell.record.rep}`); },
            }
            : {}),
        });
        records.push(record);
        spent += record.spend.total;
        log(`${step.label}: ${record.leads.length} leads, spend $${record.spend.total.toFixed(4)}, running total $${spent.toFixed(4)} of $${maxDollars}`);
        if (record.stopReason === "error") throw new Error(`${step.label} ended in error`);
      } catch (error) {
        if (error instanceof CellError && error.spend) spent += error.spend.total;
        throw new Error(`${step.label} failed after $${spent.toFixed(4)} total spend: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The memory file after A and after B, for the record and for diffing.
      if (step.label === "A" || step.label === "B") {
        const after = await loadMemory(step.workspaceId);
        await writeJson(join(setDir, `memory-after-${step.label}.json`), { version: after.version, seen: after.seen, preferences: after.preferences, notes: after.notes });
      }
    }
  } finally {
    if (priorRecord === undefined) delete process.env.EXA_RECORD_DIR;
    else process.env.EXA_RECORD_DIR = priorRecord;
  }
  const [recA, recB, recBp] = records as [RunRecord, RunRecord, RunRecord];

  // Judge: only leads with no verdict in truthRoot are paid for (judgeLead reuses by company + signal URL).
  const { blind } = await createBlindPool({ setId, scenarioId, resultsRoot, records, scenario });
  const missing = blind.filter((l) => !findVerdictFile(join(truthRoot, scenarioId), l.company, l.signal_url));
  log(`judging: ${blind.length} distinct (company, signal) leads, ${blind.length - missing.length} already have a verdict, ${missing.length} to judge`);
  const verdicts = await judgeBlind({ setId, scenarioId, resultsRoot, truthRoot, now, ...(dryRun ? { client: fakes!.fakeJudgeClient } : {}) });
  const judgeDollars = verdicts.reduce((sum, v) => sum + (v.costDollars ?? 0), 0);

  const verdictFor = (company: string, signalUrl: string): Verdict | undefined => {
    const file = findVerdictFile(join(truthRoot, scenarioId), company, signalUrl);
    return file ? (JSON.parse(readFileSync(file, "utf8")) as Verdict) : undefined;
  };
  const cellDir = (rep: number) => join(setDir, scenarioId, arm, String(rep));
  const eventsA = await readEvents(cellDir(1));
  const base = { verdictFor };
  const mA = cellMetrics({ label: "A", record: recA, events: eventsA, ...base });
  const vs = { record: recA, deadQueries: mA.deadQueries };
  const mB = cellMetrics({ label: "B", record: recB, events: await readEvents(cellDir(2)), vs, ...base });
  const mBp = cellMetrics({ label: "B'", record: recBp, events: await readEvents(cellDir(3)), vs, ...base });

  const afterA = recB.memoryBefore as MemorySnapshot | undefined;
  const { markdown, verdict } = renderReport({
    setId,
    scenarioId,
    dryRun,
    cells: [mA, mB, mBp],
    workspaces: { main, control },
    judgeDollars,
    maxDollars,
    generatedAt: new Date().toISOString(),
    ...(afterA
      ? {
        memoryAfterA: {
          seen: afterA.seen.length,
          preferences: afterA.preferences.length,
          notes: (afterA.notes as NoteText[]).map((n) => ({ text: n.text, tags: n.tags, at: n.at })),
        },
      }
      : {}),
  });
  const reportPath = join(setDir, "report.md");
  await mkdir(setDir, { recursive: true });
  await writeFile(reportPath, markdown, "utf8");
  if (dryRun) log(`dry run recorded ${experimentCalls.length} Langfuse experiment item(s) through the fake recorder: ${experimentCalls.join(", ")}`);
  return { report: markdown, reportPath, verdict, metrics: [mA, mB, mBp], records: [recA, recB, recBp], totalSpend: spent, judgeDollars };
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "dry-run") out[key] = true;
    else out[key] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const setId = String(args.set ?? "");
  const scenarioId = String(args.scenario ?? "");
  if (!setId || !scenarioId) throw new Error("pass --set <id> --scenario S1 [--max-dollars 4] [--dry-run]");
  const maxDollars = args["max-dollars"] === undefined ? 4 : Number(args["max-dollars"]);
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) throw new Error("--max-dollars must be a positive number");

  if (args["dry-run"]) {
    // Scratch everything, and make real calls impossible, before any module reads its env.
    const scratch = await mkdtemp(join(tmpdir(), "memory-eval-dry-"));
    process.env.RUNS_DIR = join(scratch, "runs");
    process.env.WORKSPACES_DIR = join(scratch, "workspaces");
    for (const key of ["ANTHROPIC_API_KEY", "EXA_API_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) process.env[key] = "";
    process.env.LANGFUSE_PROMPTS = "off";
    delete process.env.EXA_REPLAY_DIR;
    delete process.env.EXA_RECORD_DIR;
    console.log(`dry run: all output under ${scratch} (nothing in eval/results, eval/truth or ./workspaces); no API keys loaded`);
    const result = await runMemoryEval({
      setId, scenarioId, maxDollars, dryRun: true,
      resultsRoot: join(scratch, "results"), truthRoot: join(scratch, "truth"), recordingsRoot: join(scratch, "recordings"),
      now: new Date("2026-10-12T00:00:00.000Z"),
    });
    console.log(`\n${result.report}`);
    console.log(`report: ${result.reportPath}`);
    return;
  }

  const result = await runMemoryEval({ setId, scenarioId, maxDollars });
  console.log(`\n${result.report}`);
  console.log(`report: ${result.reportPath}; cells $${result.totalSpend.toFixed(4)} + judge $${result.judgeDollars.toFixed(4)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof SpendGuardError ? 2 : 1;
  });
}
