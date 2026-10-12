import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { squashName } from "../../src/gates";
import type { Arm, RunRecord, Verdict } from "./types";

type CellMetric = {
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
};

type ArmSummary = {
  scenarioId: string;
  arm: Arm;
  n: number;
  pass_at_1: number;
  pass_3: number;
  mean_good_leads: number;
  mean_precision: number;
  mean_cost_per_good_lead: number | "Infinity";
  p50_latency: number;
  p95_latency: number;
  workflow_shaped_share: number;
};

async function readCells(root: string, setId: string): Promise<RunRecord[]> {
  const setDir = join(root, setId);
  if (!existsSync(setDir)) return [];
  const records: RunRecord[] = [];
  for (const scenario of await readdir(setDir)) {
    const scenarioDir = join(setDir, scenario);
    if (scenario === "report.md" || scenario === "report.json") continue;
    for (const arm of await readdir(scenarioDir).catch(() => [])) {
      const armDir = join(scenarioDir, arm);
      for (const rep of await readdir(armDir).catch(() => [])) {
        const file = join(armDir, rep, "run.json");
        if (existsSync(file)) records.push(JSON.parse(await readFile(file, "utf8")) as RunRecord);
      }
    }
  }
  return records;
}

async function readTruth(truthRoot: string, scenarioId: string, company: string): Promise<Verdict | undefined> {
  const file = join(truthRoot, scenarioId, `${squashName(company)}.json`);
  if (!existsSync(file)) return undefined;
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

function leadGood(verdict: Verdict | undefined, q2CannotUsed: { value: boolean }): boolean {
  if (!verdict) return false;
  if (verdict.q1 !== "yes" || verdict.q3 !== "yes") return false;
  if (verdict.q2 === "yes") return true;
  if (verdict.q2 === "no") return false;
  if (!q2CannotUsed.value) {
    q2CannotUsed.value = true;
    return true;
  }
  return false;
}

export async function scoreSet(options: {
  setId: string;
  resultsRoot?: string;
  truthRoot?: string;
  records?: RunRecord[];
}): Promise<{ cells: CellMetric[]; summaries: ArmSummary[] }> {
  const root = options.resultsRoot ?? "eval/results";
  const truthRoot = options.truthRoot ?? "eval/truth";
  const records = options.records ?? await readCells(root, options.setId);
  const cells: CellMetric[] = [];
  for (const record of records) {
    const q2CannotUsed = { value: false };
    let good = 0;
    for (const lead of record.leads) {
      const verdict = await readTruth(truthRoot, record.scenarioId, lead.company);
      if (leadGood(verdict, q2CannotUsed)) good += 1;
    }
    const accepted = record.leads.length;
    const precision = accepted === 0 ? 0 : good / accepted;
    const cap = (record as RunRecord & { maxCostDollars?: number }).maxCostDollars ?? 1;
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
    });
  }

  const keys = new Set(cells.map((c) => `${c.scenarioId}\t${c.arm}`));
  const summaries: ArmSummary[] = [];
  for (const key of [...keys].sort()) {
    const [scenarioId, arm] = key.split("\t") as [string, Arm];
    const group = cells.filter((c) => c.scenarioId === scenarioId && c.arm === arm);
    const finiteCosts = group.map((c) => c.cost_per_good_lead).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    summaries.push({
      scenarioId,
      arm,
      n: group.length,
      pass_at_1: group.length === 0 ? 0 : group.filter((c) => c.pass).length / 3,
      pass_3: group.length === 3 && group.every((c) => c.pass) ? 1 : 0,
      mean_good_leads: mean(group.map((c) => c.good_leads)),
      mean_precision: mean(group.map((c) => c.precision)),
      mean_cost_per_good_lead: finiteCosts.length === group.length ? mean(finiteCosts) : "Infinity",
      p50_latency: percentile(group.map((c) => c.latency), 50),
      p95_latency: percentile(group.map((c) => c.latency), 95),
      workflow_shaped_share: group.length === 0 ? 0 : group.filter((c) => c.workflow_shaped).length / group.length,
    });
  }

  await writeReport(root, options.setId, cells, summaries);
  return { cells, summaries };
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
    ...summaries.map((s) => `| ${s.scenarioId} | ${s.arm} | ${s.n} | ${s.pass_at_1.toFixed(2)} | ${s.pass_3} | ${s.mean_good_leads.toFixed(2)} | ${s.mean_precision.toFixed(2)} | ${typeof s.mean_cost_per_good_lead === "number" ? s.mean_cost_per_good_lead.toFixed(4) : "Infinity"} | ${Math.round(s.p50_latency)} | ${Math.round(s.p95_latency)} | ${s.workflow_shaped_share.toFixed(2)} |`),
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
