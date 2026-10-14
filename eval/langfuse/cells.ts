/**
 * Shared by run-cell (`--langfuse-experiment`), score.ts and the pilot import: turn eval
 * cells on disk into Langfuse experiment items. One path, so a future paid eval lands in
 * Langfuse exactly as the imported pilot did.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentEvent } from "../../src/agent/events";
import { readDataset } from "../datasets";
import { gradeRun } from "../graders";
import { readRunFiles, scoreRecords, type CellMetric, type CellRecord } from "../harness/score";
import { findVerdictFile } from "../harness/truth";
import type { Verdict } from "../harness/types";
import { createLangfuseClient, EVAL_ENVIRONMENT } from "./client";
import { planCell, recordCells, scenarioItem, SCENARIOS_DATASET, type CellPlan, type RecordApi, type RecordResult } from "./experiment";

export type PlannedCell = { cell: CellRecord; metric?: CellMetric; plan: CellPlan; events?: AgentEvent[]; state?: unknown };

/** Metrics are withheld (undefined) for a cell with any unjudged lead, as score.ts withholds pass metrics. */
export async function planCells(
  experimentName: string,
  cells: CellRecord[],
  options: { truthRoot?: string; environment?: string; log?: (line: string) => void } = {},
): Promise<PlannedCell[]> {
  const truthRoot = options.truthRoot ?? "eval/truth";
  const { cells: metrics } = await scoreRecords(cells, { truthRoot });
  const items = readDataset(SCENARIOS_DATASET);
  const out: PlannedCell[] = [];
  for (const [i, cell] of cells.entries()) {
    const { record } = cell;
    const item = scenarioItem(record.scenarioId, items);
    if (!item) {
      options.log?.(`skip ${record.scenarioId}/${record.arm}/${record.rep}: scenario ${record.scenarioId} is not in eval/datasets/${SCENARIOS_DATASET}.jsonl`);
      continue;
    }
    const metric = metrics[i]!;
    const files = await readRunFiles(cell.dir);
    const verdictFor = (company: string, signalUrl: string): Verdict | undefined => {
      const file = findVerdictFile(join(truthRoot, record.scenarioId), company, signalUrl);
      return file ? (JSON.parse(readFileSync(file, "utf8")) as Verdict) : undefined;
    };
    const plan = planCell({
      experimentName,
      record,
      metric: metric.unjudged.count === 0 ? metric : undefined,
      grades: files ? gradeRun(files.state, files.events) : undefined,
      events: files?.events,
      verdictFor,
      datasetItem: item,
      sourceDir: cell.dir ? relative(process.cwd(), cell.dir) : undefined,
      environment: options.environment ?? EVAL_ENVIRONMENT,
    });
    out.push({ cell, metric, plan, ...(files ? { events: files.events, state: files.state } : {}) });
  }
  return out;
}

/**
 * Plan and write cells (run-cell `--langfuse-experiment`, score.ts `--langfuse-experiment`).
 * Agent turn traces are flushed first, so the item's session link resolves.
 */
export async function recordCellDirs(
  experimentName: string,
  cells: CellRecord[],
  options: { truthRoot?: string; log?: (line: string) => void } = {},
): Promise<RecordResult> {
  const environment = process.env.LANGFUSE_TRACING_ENVIRONMENT || EVAL_ENVIRONMENT;
  const planned = await planCells(experimentName, cells, { ...options, environment });
  const trace = await import("../../src/agent/trace");
  await trace.flush();
  const client = await createLangfuseClient();
  return recordCells(client as unknown as RecordApi, planned.map((p) => p.plan), { environment });
}
