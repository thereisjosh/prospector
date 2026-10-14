import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "../../src/agent/events";
import { gradeRun, type GradeReport, type GraderState } from "../graders";
import { findVerdictFile } from "./truth";
import type { Arm, RunRecord, Verdict } from "./types";

export type CellMetric = {
  scenarioId: string;
  arm: Arm;
  rep: number;
  n: number;
  good_leads: number;
  precision: number;
  cost_per_good_lead: number | "Infinity";
  latency: number;
  stop_reason: string;
  adaptive_actions: number;
  workflow_shaped: boolean;
  pass: boolean;
  /** The one Q2 cannot_verify lead tolerated as a pass in this run, and any later ones scored as no. */
  q2_tolerated?: string;
  q2_scored_no?: string[];
  /** Leads with no verdict file. They count as not good, so a cell with any is incomplete. */
  unjudged: { count: number; companies: string[]; signal_urls: string[] };
  /** Handback re-run: good leads in this cell vs. in the re-run with suggestion #1 applied (judged, same counting). */
  handback_rerun?: { good_leads_before: number; after: number };
  /** Code graders (eval/graders) over the cell's state.json + events.jsonl; agent cells only. */
  graders?: { must_pass: boolean; failed: string[] };
};

export type ArmSummary = {
  scenarioId: string;
  arm: Arm;
  n: number;
  /** null when any cell in the group has unjudged leads (see `incomplete`). */
  pass_at_1: number | null;
  /** 1 only when the group has exactly 3 runs and all pass; null otherwise (see n). */
  pass_3: number | null;
  /** Set when the group cannot be scored: "incomplete: N unjudged". */
  incomplete?: string;
  mean_good_leads: number;
  mean_precision: number;
  mean_cost_per_good_lead: number | "Infinity";
  p50_latency: number;
  p95_latency: number;
  workflow_shaped_share: number;
};

/** A cell's run.json, plus the directory it was read from (state.json + events.jsonl live next to it). */
export type CellRecord = { record: RunRecord; dir?: string };

export async function readCellRecords(root: string, setId: string): Promise<CellRecord[]> {
  const setDir = join(root, setId);
  if (!existsSync(setDir)) return [];
  const cells: CellRecord[] = [];
  for (const scenario of await readdir(setDir)) {
    const scenarioDir = join(setDir, scenario);
    if (scenario === "report.md" || scenario === "report.json") continue;
    for (const arm of await readdir(scenarioDir).catch(() => [])) {
      const armDir = join(scenarioDir, arm);
      for (const rep of await readdir(armDir).catch(() => [])) {
        const dir = join(armDir, rep);
        const file = join(dir, "run.json");
        if (existsSync(file)) cells.push({ record: JSON.parse(await readFile(file, "utf8")) as RunRecord, dir });
      }
    }
  }
  return cells;
}

async function readCells(root: string, setId: string): Promise<RunRecord[]> {
  return (await readCellRecords(root, setId)).map((c) => c.record);
}

/** state.json + events.jsonl of an agent cell, or undefined when the cell has none (workflow arm, crashed cell). */
export async function readRunFiles(dir: string | undefined): Promise<{ state: GraderState; events: AgentEvent[] } | undefined> {
  if (!dir || !existsSync(join(dir, "state.json")) || !existsSync(join(dir, "events.jsonl"))) return undefined;
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as GraderState;
  const events = (await readFile(join(dir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentEvent);
  return { state, events };
}

/** Code-grader report for a cell directory, or undefined without state/events. */
export async function gradeCellDir(dir: string | undefined): Promise<GradeReport | undefined> {
  const files = await readRunFiles(dir);
  return files ? gradeRun(files.state, files.events) : undefined;
}

async function readTruth(truthRoot: string, scenarioId: string, company: string, signalUrl: string): Promise<Verdict | undefined> {
  const file = findVerdictFile(join(truthRoot, scenarioId), company, signalUrl);
  if (!file) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as Verdict;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type Q2State = { value: boolean; tolerated?: string; scoredNo: string[]; unjudged: Array<{ company: string; signal_url: string }> };

function leadGood(verdict: Verdict | undefined, q2: Q2State, company: string): boolean {
  if (!verdict) return false;
  if (verdict.q1 !== "yes" || verdict.q3 !== "yes") return false;
  if (verdict.q2 === "yes") return true;
  if (verdict.q2 === "no") return false;
  // Q2 cannot_verify is tolerated once per run (RUBRIC section 1); a second one scores as no.
  if (!q2.value) {
    q2.value = true;
    q2.tolerated = company;
    return true;
  }
  q2.scoredNo.push(company);
  return false;
}

export async function scoreSet(options: {
  setId: string;
  resultsRoot?: string;
  truthRoot?: string;
  records?: RunRecord[];
  reruns?: RunRecord[];
}): Promise<{ cells: CellMetric[]; summaries: ArmSummary[] }> {
  const root = options.resultsRoot ?? "eval/results";
  const cellRecords: CellRecord[] = options.records ? options.records.map((record) => ({ record })) : await readCellRecords(root, options.setId);
  const reruns = options.reruns ?? (options.records ? [] : await readCells(root, `${options.setId}-handback`));
  const result = await scoreRecords(cellRecords, { truthRoot: options.truthRoot, reruns });
  await writeReport(root, options.setId, result.cells, result.summaries);
  return result;
}

/**
 * Score cells against the cached verdicts (no I/O besides reading eval/truth and the
 * cells' state/events). The single scoring path: scoreSet, run-cell's Langfuse recording
 * and the pilot import all use it, so a metric means the same thing everywhere.
 */
export async function scoreRecords(
  cellRecords: CellRecord[],
  options: { truthRoot?: string; reruns?: RunRecord[] } = {},
): Promise<{ cells: CellMetric[]; summaries: ArmSummary[] }> {
  const truthRoot = options.truthRoot ?? "eval/truth";
  const reruns = options.reruns ?? [];
  const records = cellRecords.map((c) => c.record);
  const cells: CellMetric[] = [];
  const countDetailed = async (record: RunRecord): Promise<{ good: number; q2: Q2State }> => {
    const q2: Q2State = { value: false, scoredNo: [], unjudged: [] };
    let good = 0;
    for (const lead of record.leads) {
      const verdict = await readTruth(truthRoot, record.scenarioId, lead.company, lead.signal_url);
      if (!verdict) q2.unjudged.push({ company: lead.company, signal_url: lead.signal_url });
      if (leadGood(verdict, q2, lead.company)) good += 1;
    }
    return { good, q2 };
  };
  const countGood = async (record: RunRecord): Promise<number> => (await countDetailed(record)).good;
  for (const [index, record] of records.entries()) {
    if (typeof record.maxCostDollars !== "number" || !(record.maxCostDollars > 0)) {
      throw new Error(`run record ${record.scenarioId}/${record.arm}/${record.rep} has no maxCostDollars; cannot apply the cost cap`);
    }
    const { good, q2 } = await countDetailed(record);
    const accepted = record.leads.length;
    const precision = accepted === 0 ? 0 : good / accepted;
    const cap = record.maxCostDollars;
    const rerun = reruns.find((r) => r.rerunOf === `${record.scenarioId}/${record.arm}/${record.rep}`);
    const adaptive = record.adaptive
      ? record.adaptive.queryRewrites + record.adaptive.lookupsSkipped + record.adaptive.verificationReads
      : 0;
    cells.push({
      scenarioId: record.scenarioId,
      arm: record.arm,
      rep: record.rep,
      n: accepted,
      good_leads: good,
      precision,
      cost_per_good_lead: good === 0 ? "Infinity" : record.spend.total / good,
      latency: record.activeMs,
      stop_reason: record.stopReason,
      adaptive_actions: adaptive,
      workflow_shaped: record.arm !== "A_workflow" && adaptive === 0,
      pass: good >= 6 && precision >= 0.8 && record.spend.total <= cap,
      unjudged: { count: q2.unjudged.length, companies: q2.unjudged.map((u) => u.company), signal_urls: q2.unjudged.map((u) => u.signal_url) },
      ...(q2.tolerated ? { q2_tolerated: q2.tolerated } : {}),
      ...(q2.scoredNo.length > 0 ? { q2_scored_no: q2.scoredNo } : {}),
      ...(record.handback && rerun ? { handback_rerun: { good_leads_before: good, after: await countGood(rerun) } } : {}),
      ...(await gradersField(cellRecords[index]!.dir)),
    });
  }

  const keys = new Set(cells.map((c) => `${c.scenarioId}\t${c.arm}`));
  const summaries: ArmSummary[] = [];
  for (const key of [...keys].sort()) {
    const [scenarioId, arm] = key.split("\t") as [string, Arm];
    const group = cells.filter((c) => c.scenarioId === scenarioId && c.arm === arm);
    const unjudged = group.reduce((sum, c) => sum + c.unjudged.count, 0);
    const incomplete = unjudged > 0 ? `incomplete: ${unjudged} unjudged` : undefined;
    const finiteCosts = group.map((c) => c.cost_per_good_lead).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    summaries.push({
      scenarioId,
      arm,
      n: group.length,
      pass_at_1: incomplete ? null : group.length === 0 ? 0 : group.filter((c) => c.pass).length / group.length,
      pass_3: incomplete ? null : group.length === 3 ? (group.every((c) => c.pass) ? 1 : 0) : null,
      ...(incomplete ? { incomplete } : {}),
      mean_good_leads: mean(group.map((c) => c.good_leads)),
      mean_precision: mean(group.map((c) => c.precision)),
      mean_cost_per_good_lead: finiteCosts.length === group.length ? mean(finiteCosts) : "Infinity",
      p50_latency: percentile(group.map((c) => c.latency), 50),
      p95_latency: percentile(group.map((c) => c.latency), 95),
      workflow_shaped_share: group.length === 0 ? 0 : group.filter((c) => c.workflow_shaped).length / group.length,
    });
  }

  return { cells, summaries };
}

async function gradersField(dir: string | undefined): Promise<Pick<CellMetric, "graders">> {
  const report = await gradeCellDir(dir);
  return report ? { graders: { must_pass: report.pass, failed: report.failed } } : {};
}

/** One line naming every unjudged lead, or undefined when the set is fully judged. */
export function unjudgedMessage(cells: CellMetric[]): string | undefined {
  const parts = cells.flatMap((c) => c.unjudged.companies.map((company) => `${c.scenarioId}/${c.arm}/${c.rep}: ${company}`));
  return parts.length === 0 ? undefined : `incomplete: ${parts.length} unjudged lead(s) (${parts.join("; ")}); pass metrics withheld`;
}

/** 2 when any lead is unjudged (the pass metrics are withheld), else 0. */
export function scoreExitCode(cells: CellMetric[]): 0 | 2 {
  return unjudgedMessage(cells) ? 2 : 0;
}

async function writeReport(root: string, setId: string, cells: CellMetric[], summaries: ArmSummary[]) {
  const dir = join(root, setId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify({ cells, summaries }, null, 2)}\n`, "utf8");
  const lines = [
    "# Eval Report",
    "",
    "## Scenario x Arm",
    "",
    "| Scenario | Arm | n | pass@1 | pass^3 | mean good | mean precision | mean cost/good | p50 ms | p95 ms | workflow-shaped |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summaries.map((s) => `| ${s.scenarioId} | ${s.arm} | ${s.n} | ${s.pass_at_1 === null ? `n/a (${s.incomplete})` : s.pass_at_1.toFixed(2)} | ${s.incomplete ? `n/a (${s.incomplete})` : s.pass_3 === null ? `n/a (n=${s.n})` : s.pass_3} | ${s.mean_good_leads.toFixed(2)} | ${s.mean_precision.toFixed(2)} | ${typeof s.mean_cost_per_good_lead === "number" ? s.mean_cost_per_good_lead.toFixed(4) : "Infinity"} | ${Math.round(s.p50_latency)} | ${Math.round(s.p95_latency)} | ${s.workflow_shaped_share.toFixed(2)} |`),
    "",
    "## Cells",
    "",
    "| Scenario | Arm | Rep | good | precision | spend/good | latency ms | stop | adaptive | workflow-shaped | pass |",
    "|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|",
    ...cells.map((c) => `| ${c.scenarioId} | ${c.arm} | ${c.rep} | ${c.good_leads} | ${c.precision.toFixed(2)} | ${typeof c.cost_per_good_lead === "number" ? c.cost_per_good_lead.toFixed(4) : "Infinity"} | ${Math.round(c.latency)} | ${c.stop_reason} | ${c.adaptive_actions} | ${c.workflow_shaped ? "yes" : "no"} | ${c.pass ? "yes" : "no"} |`),
    "",
  ];
  await writeFile(join(dir, "report.md"), lines.join("\n"), "utf8");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.set) throw new Error("pass --set <id>");
  const report = await scoreSet({ setId: args.set });
  console.log(`scored ${report.cells.length} cells; wrote eval/results/${args.set}/report.md`);
  console.log("\nScenario x Arm");
  for (const s of report.summaries) {
    console.log(`${s.scenarioId} ${s.arm}: n=${s.n} pass@1=${s.pass_at_1 === null ? "n/a" : s.pass_at_1.toFixed(2)} pass^3=${s.pass_3 === null ? "n/a" : s.pass_3}${s.incomplete ? ` (${s.incomplete})` : ""} mean good=${s.mean_good_leads.toFixed(2)} precision=${s.mean_precision.toFixed(2)}`);
  }
  console.log("\nPer rep (good leads, Q2 cannot_verify tolerance)");
  for (const c of report.cells) {
    console.log(`${c.scenarioId} ${c.arm} rep ${c.rep}: good ${c.good_leads}/${c.n}; q2 tolerated: ${c.q2_tolerated ?? "none"}; q2 scored as no: ${c.q2_scored_no?.join(", ") ?? "none"}`);
  }
  const incomplete = unjudgedMessage(report.cells);
  if (incomplete) {
    console.error(incomplete);
    process.exitCode = scoreExitCode(report.cells);
  }
  if (args["langfuse-experiment"]) {
    // Judged scores for the set's cells, on the items run-cell created (same deterministic ids; scores upsert).
    process.env.LANGFUSE_TRACING_ENVIRONMENT ||= "eval";
    const { recordCellDirs } = await import("../langfuse/cells");
    const r = await recordCellDirs(args["langfuse-experiment"], await readCellRecords("eval/results", args.set), { log: console.log });
    console.log(`langfuse: experiment items ${r.spans.exported} written / ${r.spans.existing} already there; ${r.scores} scores upserted`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
