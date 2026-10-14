/**
 * Import a stored eval set (default: the 2026-10-12 pilot) into Langfuse as experiment
 * runs on the `prospector-scenarios` dataset. $0: no model or Exa calls; Langfuse API only.
 *
 *   npx tsx eval/langfuse-import-pilot.ts [--set pilot-2026-10-12] [--skip-backfill]
 *
 * 1. Re-scores the cells with eval/harness/score.ts and refuses to import if the result
 *    differs from the committed report.json (the import must show the published numbers).
 * 2. Backfills each agent cell's events.jsonl under environment `eval` (eval/trace-backfill
 *    path, idempotent), so the experiment items' links to agent turn traces resolve.
 * 3. Writes one experiment run per arm × rep (`<set>:<arm>:r<rep>`), one item per scenario
 *    (OTel experiment attributes; Langfuse v4 has no run-create API), with scores on the
 *    item and per-lead judge verdicts on the agent's submit observations.
 * Re-running creates nothing new: item traces and backfilled observations are checked
 * first; scores upsert on deterministic ids.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical } from "./langfuse/sync";
import { createLangfuseClient, EVAL_ENVIRONMENT, projectId, uiLink } from "./langfuse/client";
import { planCells } from "./langfuse/cells";
import { recordCells, SCENARIOS_DATASET } from "./langfuse/experiment";
import { readCellRecords, type CellMetric } from "./harness/score";

function parseArgs(argv: string[]) {
  let set = "pilot-2026-10-12";
  let skipBackfill = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--set") set = argv[++i] ?? set;
    else if (argv[i] === "--skip-backfill") skipBackfill = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { set, skipBackfill };
}

async function main() {
  const { set, skipBackfill } = parseArgs(process.argv.slice(2));
  // Everything this script emits goes to the `eval` environment (read when the SDKs initialise, below).
  process.env.LANGFUSE_TRACING_ENVIRONMENT = EVAL_ENVIRONMENT;
  const cells = await readCellRecords("eval/results", set);
  if (cells.length === 0) throw new Error(`no cells under eval/results/${set}`);
  const planned = await planCells(set, cells, { log: console.log });

  // 1. The numbers must be the published ones.
  const report = JSON.parse(await readFile(join("eval/results", set, "report.json"), "utf8")) as { cells: CellMetric[] };
  for (const p of planned) {
    const r = p.cell.record;
    const published = report.cells.find((c) => c.scenarioId === r.scenarioId && c.arm === r.arm && c.rep === r.rep);
    if (!published || canonical(published) !== canonical(p.metric)) {
      throw new Error(`${r.scenarioId}/${r.arm}/${r.rep}: re-scored metrics differ from eval/results/${set}/report.json; run \`npm run eval:score -- --set ${set}\` and review the diff first`);
    }
  }
  console.log(`${planned.length} cells re-scored; identical to report.json`);

  // 2. Agent turn traces under `eval`.
  if (!skipBackfill) {
    const trace = await import("../src/agent/trace");
    for (const p of planned) {
      if (!p.events || !p.state) continue;
      const r = await trace.backfill(p.events, p.state);
      console.log(`backfill ${p.cell.record.scenarioId}/${p.cell.record.arm}/${p.cell.record.rep}: ${r.traces.length} turn traces, exported ${r.exported.observations} obs / ${r.exported.scores} scores, skipped ${r.skipped.observations} / ${r.skipped.scores}`);
    }
    const stats = trace.traceStats();
    if (stats.exportFailures || stats.emitErrors) throw new Error(`backfill: ${stats.exportFailures} export failures, ${stats.emitErrors} emit errors`);
  }

  // 3. Experiment runs.
  const client = await createLangfuseClient();
  const result = await recordCells(client as never, planned.map((p) => p.plan));
  const project = await projectId(client);
  const dataset = await client.api.datasets.get(SCENARIOS_DATASET);
  console.log(`experiment items: ${result.spans.exported} written, ${result.spans.existing} already there · scores sent (upsert): ${result.scores}`);
  console.log(`dataset: ${uiLink(project, `datasets/${dataset.id}`)}`);
  console.log(`experiments (select the runs, then Compare): ${uiLink(project, "experiments")}`);
  for (const run of result.runs) console.log(`  ${run.runName}  id ${run.experimentId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
