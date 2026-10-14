import "dotenv/config";
import { judgeLeadFromState, normalizeJudgeLead } from "../../src/agent/judge-input";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_MODELS, RUNS_DIR } from "../../src/agent/config";
import { emptyJudgeEvidence, type JudgeEvidence } from "../../src/evidence";
import { checkLead } from "../../src/gates";
import { rowEvidenceKey } from "../../src/score";
import { validatePlan, type SearchPlan } from "../../src/plan";
import { runProspecting } from "../../src/pipeline";
import type { ProspectRow } from "../../src/types";
import { createRunState, type RunState } from "../../src/agent/state";
import { getV1Plan } from "../fixtures/v1-plans";
import { driveRun } from "../run-agent";
import { applyFirstHandbackSuggestion } from "./sim-user";
import type { Arm, LeadRecord, RunCellDeps, RunRecord, Scenario } from "./types";

const DEFAULT_RESULTS_ROOT = "eval/results";

/** A cell that crashed mid-run; carries whatever the run had spent so far. */
export class CellError extends Error {
  constructor(message: string, readonly runId?: string, readonly spend?: RunRecord["spend"]) {
    super(message);
    this.name = "CellError";
  }
}

export function normalizeArm(value: string): Arm {
  if (value === "A" || value === "A_workflow") return "A_workflow";
  if (value === "B" || value === "B_agent_opus") return "B_agent_opus";
  if (value === "C" || value === "C_agent_sonnet") return "C_agent_sonnet";
  throw new Error(`unknown arm ${value}`);
}

export function defaultScenario(id: string): Scenario {
  if (id === "S1") {
    const plan = getV1Plan(1);
    return { id, label: plan.label, plan, targetLeads: 10, maxCostDollars: 1 };
  }
  if (id === "S2") {
    const plan = getV1Plan(3);
    return { id, label: plan.label, plan, targetLeads: 10, maxCostDollars: 1 };
  }
  const file = existsSync(join("eval/truth", `${id}.json`))
    ? join("eval/truth", `${id}.json`)
    : join("eval/truth", "scenarios.json");
  if (!existsSync(file)) throw new Error(`no built-in scenario ${id}; add eval/truth/${id}.json or eval/truth/scenarios.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const candidate = Array.isArray(raw) ? raw.find((s) => (s as { id?: unknown }).id === id) : raw;
  if (!candidate || typeof candidate !== "object") throw new Error(`scenario ${id} not found in ${file}`);
  return parseScenario(candidate);
}

export function parseScenario(input: unknown): Scenario {
  if (!input || typeof input !== "object") throw new Error("scenario must be an object");
  const rec = input as Record<string, unknown>;
  const id = String(rec.id ?? "");
  const targetLeads = Number(rec.targetLeads ?? 10);
  const maxCostDollars = Number(rec.maxCostDollars ?? 1);
  const validation = validatePlan(rec.plan);
  if (!id) throw new Error("scenario.id is required");
  if (!validation.ok) throw new Error(`invalid scenario plan:\n  ${validation.errors.join("\n  ")}`);
  if (!Number.isFinite(targetLeads) || targetLeads <= 0) throw new Error("scenario.targetLeads must be positive");
  if (!Number.isFinite(maxCostDollars) || maxCostDollars <= 0) throw new Error("scenario.maxCostDollars must be positive");
  return {
    id,
    label: String(rec.label ?? validation.plan.label),
    plan: validation.plan,
    targetLeads,
    maxCostDollars,
  };
}

/** Both arms emit the same normalised fields: why_now <= 200 chars, size_basis "quoted" | "unverified" (src/agent/judge-input.ts). */
const normalizeLead = (fields: LeadRecord): LeadRecord => normalizeJudgeLead(fields);

/**
 * Workflow rows carry no structured details, only the fit_reason sentence the
 * shared gate wrote; "(quoted)" appears in it exactly when details.size_basis
 * was "quoted". The sentence itself is not recorded (it would reveal the arm).
 * The evidence comes from the run's per-row evidence map (score.ts toRow), built
 * by the same src/evidence.ts builder the agent's submit path uses.
 */
function rowToLead(row: ProspectRow, evidence?: Record<string, JudgeEvidence>): LeadRecord {
  return normalizeLead({
    company: row.company,
    signal_url: row.signal_source_url,
    why_now: row.why_now_signal,
    event_date: row.signal_date,
    size_basis: /\(quoted\)/.test(row.fit_reason) ? "quoted" : "unverified",
    evidence: evidence?.[rowEvidenceKey(row.company, row.signal_source_url)] ?? emptyJudgeEvidence(),
  });
}

function stateLeadToLead(lead: RunState["leads"][number]): LeadRecord {
  return judgeLeadFromState(lead);
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyAgentArtifacts(state: RunState, outDir: string, deps: RunCellDeps) {
  const runsDir = deps.runsDir ?? RUNS_DIR;
  await copyFile(join(runsDir, state.id, "state.json"), join(outDir, "state.json")).catch(async () => {
    await writeJson(join(outDir, "state.json"), state);
  });
  await copyFile(join(runsDir, state.id, "events.jsonl"), join(outDir, "events.jsonl")).catch(async () => {
    await writeFile(join(outDir, "events.jsonl"), "", "utf8");
  });
}

function outputDir(scenario: Scenario, arm: Arm, rep: number, deps: RunCellDeps): string {
  return join(deps.resultsRoot ?? DEFAULT_RESULTS_ROOT, deps.runSetId ?? "local", scenario.id, arm, String(rep));
}

/**
 * Run the handback re-run cell (suggestion #1 applied). It is only recorded here,
 * tagged with `rerunOf`; scoring computes good-lead counts after judging.
 */
async function runHandbackRerun(record: RunRecord, scenario: Scenario, arm: Arm, rep: number, deps: RunCellDeps, setId: string): Promise<RunRecord | undefined> {
  if (!record.handback) return undefined;
  const rerunScenario = applyFirstHandbackSuggestion(scenario, record);
  return runCell(rerunScenario, arm, rep, { ...deps, runSetId: `${setId}-handback`, rerunOf: `${scenario.id}/${arm}/${rep}` });
}

function cellFields(scenario: Scenario, now: Date, deps: RunCellDeps) {
  return {
    maxCostDollars: scenario.maxCostDollars,
    targetLeads: scenario.targetLeads,
    now: now.toISOString(),
    ...(deps.rerunOf ? { rerunOf: deps.rerunOf } : {}),
  };
}

export async function runCell(scenario: Scenario, arm: Arm, rep: number, deps: RunCellDeps = {}): Promise<RunRecord> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const outDir = outputDir(scenario, arm, rep, deps);
  const now = deps.now ?? new Date();
  let record: RunRecord;

  if (arm === "A_workflow") {
    let run: { rows: ProspectRow[]; totalCostDollars: number; funnel: unknown; evidence?: Record<string, JudgeEvidence> } & Record<string, unknown>;
    try {
    run = deps.workflowRows
      ? { rows: deps.workflowRows, totalCostDollars: 0, funnel: {}, rejected: [], enriched: [], enrichmentQueue: [], plan: scenario.plan, startPublishedDate: "" }
      : await (deps.runProspecting ?? runProspecting)(scenario.plan, {
        type: "auto",
        numResults: 25,
        maxCostDollars: scenario.maxCostDollars,
        now,
      });
    } catch (error) {
      // The pipeline attaches what it had spent; record that, not zero.
      const spendDollars = (error as { spendDollars?: unknown } | null)?.spendDollars;
      const spent = typeof spendDollars === "number" ? spendDollars : 0;
      throw new CellError(error instanceof Error ? error.message : String(error), undefined, { exa: spent, claude: 0, total: spent });
    }
    const spend = Number(run.totalCostDollars ?? 0);
    record = {
      scenarioId: scenario.id,
      arm,
      rep,
      leads: run.rows.slice(0, scenario.targetLeads).map((row) => rowToLead(row, run.evidence)),
      spend: { exa: spend, claude: 0, total: spend },
      activeMs: Date.now() - started,
      stopReason: (run.funnel as { budgetStoppedAt?: unknown } | undefined)?.budgetStoppedAt ? "budget" : run.rows.length >= scenario.targetLeads ? "target" : "finish",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...cellFields(scenario, now, deps),
    };
  } else {
    const state = createRunState({
      id: randomUUID(),
      workspaceId: `eval-${scenario.id}-${arm}-${rep}`,
      plan: scenario.plan,
      model: arm === "B_agent_opus" ? AGENT_MODELS.opus : AGENT_MODELS.sonnet,
      targetLeads: scenario.targetLeads,
      maxCostDollars: scenario.maxCostDollars,
      preferenceNotes: [],
      seenKeys: [],
      createdAt: startedAt,
    });
    let final: RunState;
    try {
      final = await (deps.driveRun ?? driveRun)(
        state,
        {
          client: deps.createClient ? deps.createClient() : new Anthropic(),
          checkLead: deps.checkLead ?? checkLead,
          now,
        },
        deps.approvePolicy ?? "auto",
        { log: deps.log ?? (() => undefined), maxIterations: deps.maxIterations },
      );
    } catch (error) {
      // The state object is updated in place by the driver, so its spend is what was incurred before the crash.
      throw new CellError(error instanceof Error ? error.message : String(error), state.id, { ...state.spend });
    }
    record = {
      scenarioId: scenario.id,
      arm,
      rep,
      runId: final.id,
      leads: final.leads.map(stateLeadToLead),
      spend: final.spend,
      activeMs: final.counters.activeMs,
      stopReason: final.stopReason ?? final.status,
      adaptive: final.adaptive,
      handback: final.handback,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...cellFields(scenario, now, deps),
    };
    await mkdir(outDir, { recursive: true });
    await copyAgentArtifacts(final, outDir, deps);
  }

  await writeJson(join(outDir, "run.json"), record);
  if (deps.langfuseExperiment) await recordInLangfuse(deps.langfuseExperiment, { record, dir: outDir }, deps);
  return record;
}

/**
 * `--langfuse-experiment`: the cell becomes an item of run `<name>:<arm>:r<rep>` on the
 * prospector-scenarios dataset, with its scores (eval/langfuse/experiment.ts). Outcome
 * scores need verdicts; until the leads are judged only stop_reason and the code graders
 * are written, and `npm run eval:score -- --set <id> --langfuse-experiment <name>` adds the
 * rest after judging. A Langfuse failure never loses the paid cell: run.json is already
 * written; it is logged and the exit code is set.
 */
async function recordInLangfuse(name: string, cell: { record: RunRecord; dir: string }, deps: RunCellDeps): Promise<void> {
  const log = deps.log ?? (() => undefined);
  try {
    if (deps.recordExperiment) await deps.recordExperiment(name, cell);
    else {
      const { recordCellDirs } = await import("../langfuse/cells");
      await recordCellDirs(name, [cell], { log });
    }
    log(`langfuse: recorded ${cell.record.scenarioId}/${cell.record.arm}/${cell.record.rep} in ${name}:${cell.record.arm}:r${cell.record.rep}`);
  } catch (error) {
    log(`langfuse: recording ${cell.record.scenarioId}/${cell.record.arm}/${cell.record.rep} FAILED (run.json kept): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export type MatrixOptions = {
  setId: string;
  scenarios: Scenario[];
  arms: Arm[];
  reps: number;
  maxTotalDollars?: number;
  handback?: boolean;
  deps?: RunCellDeps;
  /** Test seam: replaces runCell. */
  cell?: typeof runCell;
};

function errorRecord(scenario: Scenario, arm: Arm, rep: number, error: unknown, deps: RunCellDeps): RunRecord {
  const message = error instanceof Error ? error.message : String(error);
  const spend = error instanceof CellError && error.spend ? error.spend : { exa: 0, claude: 0, total: 0 };
  const at = new Date().toISOString();
  return {
    scenarioId: scenario.id,
    arm,
    rep,
    ...(error instanceof CellError && error.runId ? { runId: error.runId } : {}),
    leads: [],
    spend,
    activeMs: 0,
    stopReason: "error",
    error: message,
    startedAt: at,
    finishedAt: at,
    ...cellFields(scenario, deps.now ?? new Date(), deps),
  };
}

export type MatrixResult = { records: RunRecord[]; total: number; stopped: boolean; ok: number; errors: number };

export async function runMatrix(options: MatrixOptions): Promise<MatrixResult> {
  const records: RunRecord[] = [];
  let total = 0;
  let ok = 0;
  let errors = 0;
  const deps = { ...(options.deps ?? {}), runSetId: options.setId };
  const cell = options.cell ?? runCell;
  const finish = (stopped: boolean): MatrixResult => {
    deps.log?.(`cells ok/error: ${ok}/${errors}`);
    return { records, total, stopped, ok, errors };
  };
  for (const scenario of options.scenarios) {
    for (const arm of options.arms) {
      for (let rep = 1; rep <= options.reps; rep += 1) {
        // Worst case for this cell (and its handback re-run) must still fit under the total cap.
        const worstCase = scenario.maxCostDollars * (options.handback ? 2 : 1);
        if (options.maxTotalDollars !== undefined && total + worstCase > options.maxTotalDollars) {
          return finish(true);
        }
        let record: RunRecord;
        try {
          record = await cell(scenario, arm, rep, deps);
          ok += 1;
        } catch (error) {
          // One crashed cell (e.g. an Exa 429 that outlived the retries) must not end the matrix.
          record = errorRecord(scenario, arm, rep, error, deps);
          errors += 1;
          deps.log?.(`cell ${scenario.id}/${arm}/${rep} FAILED: ${record.error}`);
          await writeJson(join(outputDir(scenario, arm, rep, deps), "run.json"), record);
        }
        records.push(record);
        total += record.spend.total;
        deps.log?.(`running total $${total.toFixed(4)} after ${scenario.id}/${arm}/${rep}`);
        if (options.handback && record.handback) {
          try {
            const rerun = await runHandbackRerun(record, scenario, arm, rep, deps, options.setId);
            if (rerun) total += rerun.spend.total;
          } catch (error) {
            errors += 1;
            deps.log?.(`handback re-run ${scenario.id}/${arm}/${rep} FAILED: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }
  return finish(false);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "handback") out[key] = true;
    else out[key] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const setId = String(args.set ?? "");
  if (!setId) throw new Error("pass --set <id>");
  const langfuseExperiment = args["langfuse-experiment"] ? String(args["langfuse-experiment"]) : undefined;
  // Live agent traces and the experiment items of an eval go to the `eval` environment
  // unless the caller chose one (read lazily when tracing first initialises).
  if (langfuseExperiment) process.env.LANGFUSE_TRACING_ENVIRONMENT ||= "eval";
  const maxTotalDollars = args["max-total-dollars"] === undefined ? undefined : Number(args["max-total-dollars"]);
  const log = (line: string) => console.log(line);

  if (args.matrix) {
    const scenarios = String(args.matrix).split(",").filter(Boolean).map(defaultScenario);
    const arms = String(args.arms ?? "A,B,C").split(",").filter(Boolean).map(normalizeArm);
    const reps = Number(args.reps ?? 3);
    const result = await runMatrix({ setId, scenarios, arms, reps, maxTotalDollars, handback: !!args.handback, deps: { log, langfuseExperiment } });
    console.log(`matrix ${result.stopped ? "stopped" : "finished"}: ${result.records.length} cells, total $${result.total.toFixed(4)}; cells ok/error: ${result.ok}/${result.errors}`);
    if (result.errors > 0) process.exitCode = 1;
    return;
  }

  const scenarioId = String(args.scenario ?? "");
  const armArg = String(args.arm ?? "");
  const rep = Number(args.rep ?? 1);
  if (!scenarioId || !armArg) throw new Error("pass --scenario <id> --arm <A|B|C> --rep <n>, or --matrix");
  const scenario = defaultScenario(scenarioId);
  const arm = normalizeArm(armArg);
  const deps: RunCellDeps = { runSetId: setId, log, langfuseExperiment };
  const record = await runCell(scenario, arm, rep, deps);
  if (args.handback) await runHandbackRerun(record, scenario, arm, rep, deps, setId);
  console.log(`cell wrote ${scenarioId}/${record.arm}/${rep}; spend $${record.spend.total.toFixed(4)}; leads ${record.leads.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
