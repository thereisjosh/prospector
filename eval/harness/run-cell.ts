import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_MODELS, RUNS_DIR } from "../../src/agent/config";
import { checkLead, squashName } from "../../src/gates";
import { validatePlan, type SearchPlan } from "../../src/plan";
import { runProspecting } from "../../src/pipeline";
import type { ProspectRow } from "../../src/types";
import { createRunState, type RunState } from "../../src/agent/state";
import { getV1Plan } from "../fixtures/v1-plans";
import { driveRun } from "../run-agent";
import { applyFirstHandbackSuggestion } from "./sim-user";
import type { Arm, LeadRecord, RunCellDeps, RunRecord, Scenario } from "./types";

const DEFAULT_RESULTS_ROOT = "eval/results";

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

function rowToLead(row: ProspectRow): LeadRecord {
  return {
    company: row.company,
    signal_url: row.signal_source_url,
    why_now: row.why_now_signal,
    event_date: row.signal_date,
    size_basis: row.fit_reason,
  };
}

function stateLeadToLead(lead: RunState["leads"][number]): LeadRecord {
  const details = lead.details as { event_date?: unknown; size_basis?: unknown };
  return {
    company: lead.company,
    signal_url: lead.signal_url,
    why_now: lead.why_now,
    event_date: typeof details.event_date === "string" ? details.event_date : "",
    size_basis: typeof details.size_basis === "string" ? details.size_basis : "",
  };
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

function countGoodLeads(record: RunRecord, truthRoot = "eval/truth"): number {
  let q2CannotUsed = false;
  let good = 0;
  for (const lead of record.leads) {
    const file = join(truthRoot, record.scenarioId, `${squashName(lead.company)}.json`);
    if (!existsSync(file)) continue;
    const verdict = JSON.parse(readFileSync(file, "utf8")) as { q1?: string; q2?: string; q3?: string };
    if (verdict.q1 !== "yes" || verdict.q3 !== "yes") continue;
    if (verdict.q2 === "yes") good += 1;
    else if (verdict.q2 === "cannot_verify" && !q2CannotUsed) {
      q2CannotUsed = true;
      good += 1;
    }
  }
  return good;
}

async function runHandbackRerun(record: RunRecord, scenario: Scenario, arm: Arm, rep: number, deps: RunCellDeps, setId: string) {
  if (!record.handback) return;
  const rerunScenario = applyFirstHandbackSuggestion(scenario, record);
  const rerun = await runCell(rerunScenario, arm, rep, { ...deps, runSetId: `${setId}-handback` });
  record.handback_rerun = {
    good_leads_before: countGoodLeads(record),
    after: countGoodLeads(rerun),
  };
  await writeJson(join(outputDir(scenario, arm, rep, deps), "run.json"), record);
}

export async function runCell(scenario: Scenario, arm: Arm, rep: number, deps: RunCellDeps = {}): Promise<RunRecord> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const outDir = outputDir(scenario, arm, rep, deps);
  const now = deps.now ?? new Date();
  let record: RunRecord;

  if (arm === "A_workflow") {
    const run = deps.workflowRows
      ? { rows: deps.workflowRows, totalCostDollars: 0, funnel: {}, rejected: [], enriched: [], enrichmentQueue: [], plan: scenario.plan, startPublishedDate: "" }
      : await (deps.runProspecting ?? runProspecting)(scenario.plan, {
        type: "auto",
        numResults: 25,
        maxCostDollars: scenario.maxCostDollars,
        now,
      });
    const spend = Number(run.totalCostDollars ?? 0);
    record = {
      scenarioId: scenario.id,
      arm,
      rep,
      leads: run.rows.map(rowToLead),
      spend: { exa: spend, claude: 0, total: spend },
      activeMs: Date.now() - started,
      stopReason: (run.funnel as { budgetStoppedAt?: unknown }).budgetStoppedAt ? "budget" : run.rows.length >= scenario.targetLeads ? "target" : "finish",
      startedAt,
      finishedAt: new Date().toISOString(),
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
    const final = await (deps.driveRun ?? driveRun)(
      state,
      {
        client: deps.createClient ? deps.createClient() : new Anthropic(),
        checkLead: deps.checkLead ?? checkLead,
        now,
      },
      deps.approvePolicy ?? "auto",
      { log: deps.log ?? (() => undefined), maxIterations: deps.maxIterations },
    );
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
    };
    await mkdir(outDir, { recursive: true });
    await copyAgentArtifacts(final, outDir, deps);
  }

  await writeJson(join(outDir, "run.json"), record);
  return record;
}

export type MatrixOptions = {
  setId: string;
  scenarios: Scenario[];
  arms: Arm[];
  reps: number;
  maxTotalDollars?: number;
  handback?: boolean;
  deps?: RunCellDeps;
};

export async function runMatrix(options: MatrixOptions): Promise<{ records: RunRecord[]; total: number; stopped: boolean }> {
  const records: RunRecord[] = [];
  let total = 0;
  const deps = { ...(options.deps ?? {}), runSetId: options.setId };
  for (const scenario of options.scenarios) {
    for (const arm of options.arms) {
      for (let rep = 1; rep <= options.reps; rep += 1) {
        if (options.maxTotalDollars !== undefined && total >= options.maxTotalDollars) {
          return { records, total, stopped: true };
        }
        const record = await runCell(scenario, arm, rep, deps);
        records.push(record);
        total += record.spend.total;
        deps.log?.(`running total $${total.toFixed(4)} after ${scenario.id}/${arm}/${rep}`);
        if (options.handback && record.handback) {
          await runHandbackRerun(record, scenario, arm, rep, deps, options.setId);
          const rerunFile = join(deps.resultsRoot ?? DEFAULT_RESULTS_ROOT, `${options.setId}-handback`, scenario.id, arm, String(rep), "run.json");
          if (existsSync(rerunFile)) {
            const rerun = JSON.parse(readFileSync(rerunFile, "utf8")) as RunRecord;
            total += rerun.spend.total;
          }
        }
      }
    }
  }
  return { records, total, stopped: false };
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
  const maxTotalDollars = args["max-total-dollars"] === undefined ? undefined : Number(args["max-total-dollars"]);
  const log = (line: string) => console.log(line);

  if (args.matrix) {
    const scenarios = String(args.matrix).split(",").filter(Boolean).map(defaultScenario);
    const arms = String(args.arms ?? "A,B,C").split(",").filter(Boolean).map(normalizeArm);
    const reps = Number(args.reps ?? 3);
    const result = await runMatrix({ setId, scenarios, arms, reps, maxTotalDollars, handback: !!args.handback, deps: { log } });
    console.log(`matrix ${result.stopped ? "stopped" : "finished"}: ${result.records.length} cells, total $${result.total.toFixed(4)}`);
    return;
  }

  const scenarioId = String(args.scenario ?? "");
  const armArg = String(args.arm ?? "");
  const rep = Number(args.rep ?? 1);
  if (!scenarioId || !armArg) throw new Error("pass --scenario <id> --arm <A|B|C> --rep <n>, or --matrix");
  const scenario = defaultScenario(scenarioId);
  const arm = normalizeArm(armArg);
  const deps: RunCellDeps = { runSetId: setId, log };
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
