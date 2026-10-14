/**
 * CI experiment gate ($0): the workflow arm on every `prospector-scenarios` dataset item,
 * replayed from recorded Exa responses, scored with the cached judge verdicts and the code
 * graders, written to Langfuse as experiment `ci-<sha>` (run `ci-<sha>:A_workflow:r1`, the
 * same item/score shape as the pilot runs, eval/langfuse/experiment.ts), then gated by
 * eval/ci/gate.ts against eval/ci/approved-baseline.json.
 *
 *   npx tsx eval/ci/experiment-gate.ts [--sha <commit> | --experiment <name>] [--no-langfuse] [--out result.json]
 *   npx tsx eval/ci/experiment-gate.ts --record S1,S2 --i-accept-exa-spend   (PAID, see below)
 *
 * Why not `langfuse/experiment-action`: the action runs the SDK runner
 * (`context.runExperiment`), which calls the legacy dataset-run-items API (410 for this
 * org, SPEC-observability §4), forces environment `sdk-experiment` and picks random ids, so
 * a `ci-<sha>` run would not have the shape of the imported pilot runs it is compared with.
 * This runner follows the same release policy (Experiments in CI/CD docs): missing cases,
 * task failures and missing evaluator results fail the gate.
 *
 * What it cannot see: the agent arm. Replaying it at $0 would need recorded model responses,
 * which we do not keep; agent changes are gated only by `langfuse-prompts.ts diff` and the
 * mocked suite (ci.yml).
 *
 * Fixtures: one Exa recording per scenario (`fixture` in approved-baseline.json, with the
 * recorded cell as `cell.json`, whose `now` the replay reuses so request hashes match).
 * `--record` makes them with live Exa calls (≈ $0.75–0.90 per scenario at the pilot's
 * workflow spend) and writes the cell to eval/results/ci-fixtures/ for judging
 * (`npm run eval:judge -- --set ci-fixtures --scenario <id>`, ≈ $0.34 per unjudged lead).
 * Exit: 0 pass · 1 gate failure · 2 script error.
 */
import "dotenv/config";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDataset, type DatasetItem } from "../datasets";
import { gradeRun } from "../graders";
import { parseScenario, runCell } from "../harness/run-cell";
import { readRunFiles, scoreRecords, type CellRecord } from "../harness/score";
import type { RunRecord } from "../harness/types";
import { evaluateGate, gateMarkdown, type ApprovedBaseline, type GateResult, type ScenarioOutcome } from "./gate";

export const CI_ENVIRONMENT = "ci";
export const BASELINE_FILE = "eval/ci/approved-baseline.json";
const ARM = "A_workflow" as const;
const REP = 1;

export function readBaseline(file = BASELINE_FILE): ApprovedBaseline {
  return JSON.parse(readFileSync(file, "utf8")) as ApprovedBaseline;
}

export function fixtureFor(baseline: ApprovedBaseline, scenarioId: string): string {
  return baseline.scenarios[scenarioId]?.fixture ?? `eval/recordings/ci/${scenarioId}-workflow`;
}

/** `ci-<first 12 of the sha>`; the run is `<experiment>:A_workflow:r1`. */
export function experimentNameFor(sha: string): string {
  const clean = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(clean)) throw new Error(`not a commit sha: ${sha}`);
  return `ci-${clean.slice(0, 12)}`;
}

/** The scenario a dataset item runs: its input is `{scenarioId, label, targetLeads, maxCostDollars, plan}`. */
export function scenarioOf(item: DatasetItem) {
  const input = (item.input ?? {}) as Record<string, unknown>;
  return parseScenario({ ...input, id: input.scenarioId });
}

/** Run `fn` with EXA_REPLAY_DIR set (and recording off), restoring both after. */
async function withReplay<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = { replay: process.env.EXA_REPLAY_DIR, record: process.env.EXA_RECORD_DIR };
  process.env.EXA_REPLAY_DIR = dir;
  delete process.env.EXA_RECORD_DIR;
  try {
    return await fn();
  } finally {
    if (prev.replay === undefined) delete process.env.EXA_REPLAY_DIR;
    else process.env.EXA_REPLAY_DIR = prev.replay;
    if (prev.record !== undefined) process.env.EXA_RECORD_DIR = prev.record;
  }
}

export type GateRun = { result: GateResult; outcomes: ScenarioOutcome[]; cells: CellRecord[]; expected: string[] };

/** Replay + score every dataset item. No network: replay never falls through to Exa, and nothing here calls a model. */
export async function runReplay(options: {
  experiment: string;
  items?: DatasetItem[];
  baseline?: ApprovedBaseline;
  resultsRoot?: string;
  truthRoot?: string;
  cell?: typeof runCell;
  log?: (line: string) => void;
}): Promise<GateRun> {
  const items = options.items ?? readDataset("prospector-scenarios");
  const baseline = options.baseline ?? readBaseline();
  const resultsRoot = options.resultsRoot ?? mkdtempSync(join(tmpdir(), "experiment-gate-"));
  const cell = options.cell ?? runCell;
  const log = options.log ?? (() => undefined);
  const outcomes: ScenarioOutcome[] = [];
  const cells: CellRecord[] = [];
  const expected: string[] = [];
  for (const item of items) {
    const scenario = scenarioOf(item);
    expected.push(scenario.id);
    const fixture = fixtureFor(baseline, scenario.id);
    const cellFile = join(fixture, "cell.json");
    if (!existsSync(cellFile)) {
      outcomes.push({ scenarioId: scenario.id, status: "missing_fixture", fixture });
      log(`${scenario.id}: no fixture at ${fixture}`);
      continue;
    }
    const recorded = JSON.parse(readFileSync(cellFile, "utf8")) as RunRecord;
    if (!recorded.now) {
      outcomes.push({ scenarioId: scenario.id, status: "error", error: `${cellFile} has no "now"; the replay cannot reproduce its request hashes` });
      continue;
    }
    let record: RunRecord;
    try {
      record = await withReplay(fixture, () => cell(scenario, ARM, REP, { now: new Date(recorded.now!), resultsRoot, runSetId: options.experiment, log }));
    } catch (error) {
      outcomes.push({ scenarioId: scenario.id, status: "error", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const dir = join(resultsRoot, options.experiment, scenario.id, ARM, String(REP));
    cells.push({ record, dir });
    const { cells: metrics } = await scoreRecords([{ record, dir }], { truthRoot: options.truthRoot });
    const metric = metrics[0]!;
    const files = await readRunFiles(dir);
    outcomes.push({
      scenarioId: scenario.id,
      status: "ran",
      accepted: metric.n,
      good: metric.good_leads,
      precision: metric.precision,
      unjudged: metric.unjudged.companies,
      ...(files ? { graders: gradeRun(files.state, files.events) } : {}),
    });
    log(`${scenario.id}: ${metric.n} accepted, ${metric.good_leads} good, precision ${metric.precision.toFixed(3)}, unjudged ${metric.unjudged.count}`);
  }
  return { result: evaluateGate(expected, outcomes, baseline), outcomes, cells, expected };
}

/** Post the replayed cells as experiment items in environment `ci`; never writes the dataset. */
async function postToLangfuse(experiment: string, cells: CellRecord[], log: (line: string) => void): Promise<{ runName?: string; link?: string }> {
  if (cells.length === 0) return {};
  const { planCells } = await import("../langfuse/cells");
  const { recordCells } = await import("../langfuse/experiment");
  const { createLangfuseClient, projectId, uiLink } = await import("../langfuse/client");
  const planned = await planCells(experiment, cells, { environment: CI_ENVIRONMENT, log });
  const client = await createLangfuseClient();
  const result = await recordCells(client as never, planned.map((p) => p.plan), { environment: CI_ENVIRONMENT, syncDataset: false });
  log(`langfuse: items ${result.spans.exported} written, ${result.spans.existing} already there; ${result.scores} scores (upsert)`);
  const project = await projectId(client);
  return { runName: result.runs[0]?.runName, link: uiLink(project, "experiments") };
}

/** PAID: record the Exa fixture for each scenario with live calls (the gate never does this). */
async function recordFixtures(scenarioIds: string[], log: (line: string) => void): Promise<void> {
  const baseline = readBaseline();
  for (const item of readDataset("prospector-scenarios")) {
    const scenario = scenarioOf(item);
    if (!scenarioIds.includes(scenario.id)) continue;
    const fixture = fixtureFor(baseline, scenario.id);
    if (existsSync(join(fixture, "cell.json"))) throw new Error(`${fixture}/cell.json exists; delete the directory to re-record`);
    await mkdir(fixture, { recursive: true });
    process.env.EXA_RECORD_DIR = fixture;
    delete process.env.EXA_REPLAY_DIR;
    const record = await runCell(scenario, ARM, REP, { runSetId: "ci-fixtures", log });
    delete process.env.EXA_RECORD_DIR;
    await copyFile(join("eval/results/ci-fixtures", scenario.id, ARM, String(REP), "run.json"), join(fixture, "cell.json"));
    log(`${scenario.id}: recorded ${fixture} ($${record.spend.total.toFixed(4)} Exa, ${record.leads.length} leads). Next: npm run eval:judge -- --set ci-fixtures --scenario ${scenario.id}, then review approved-baseline.json`);
  }
}

function parseArgs(argv: string[]) {
  const out: { experiment?: string; sha?: string; langfuse: boolean; out?: string; record?: string[]; acceptSpend: boolean } = { langfuse: true, acceptSpend: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--experiment") out.experiment = argv[++i];
    else if (a === "--sha") out.sha = argv[++i];
    else if (a === "--no-langfuse") out.langfuse = false;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--record") out.record = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--i-accept-exa-spend") out.acceptSpend = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);
  if (args.record) {
    if (!args.acceptSpend) throw new Error("--record makes live Exa calls (≈ $0.75–0.90 per scenario); add --i-accept-exa-spend");
    await recordFixtures(args.record, log);
    return 0;
  }
  // Everything this run emits goes to environment `ci` (read when the SDK initialises).
  process.env.LANGFUSE_TRACING_ENVIRONMENT = CI_ENVIRONMENT;
  const sha = args.sha ?? process.env.GITHUB_SHA;
  const experiment = args.experiment ?? (sha ? experimentNameFor(sha) : "ci-local");
  const run = await runReplay({ experiment, log });
  let posted: { runName?: string; link?: string } = {};
  if (args.langfuse) posted = await postToLangfuse(experiment, run.cells, log);
  const markdown = gateMarkdown(run.result, { experiment, ...posted });
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });
  if (args.out) await writeFile(args.out, `${JSON.stringify({ experiment, ...posted, ...run.result }, null, 2)}\n`);
  return run.result.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    },
  );
}
