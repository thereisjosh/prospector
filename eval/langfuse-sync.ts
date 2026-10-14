/**
 * Mirror the in-repo datasets (eval/datasets/*.jsonl, the source of truth) to Langfuse
 * Datasets. $0: Langfuse API calls only.
 *
 *   npx tsx eval/langfuse-sync.ts [--dataset prospector-cases] [--dry-run] [--archive-missing]
 *
 * Idempotent on item ids: unchanged items are not re-sent, so a second run reports
 * "0 created, 0 updated" and creates no new dataset version.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { countByKind, DATASETS, readDataset, validateDataset, type DatasetName } from "./datasets";
import { createLangfuseClient, projectId, uiLink } from "./langfuse/client";
import { syncDataset } from "./langfuse/sync";

function parseArgs(argv: string[]) {
  const names: DatasetName[] = [];
  let dryRun = false;
  let archiveMissing = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--archive-missing") archiveMissing = true;
    else if (arg === "--dataset") {
      const name = argv[++i] ?? "";
      if (!(name in DATASETS)) throw new Error(`unknown dataset "${name}" (known: ${Object.keys(DATASETS).join(", ")})`);
      names.push(name as DatasetName);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return { names: names.length ? names : (Object.keys(DATASETS) as DatasetName[]), dryRun, archiveMissing };
}

async function main() {
  const { names, dryRun, archiveMissing } = parseArgs(process.argv.slice(2));
  const client = await createLangfuseClient();
  const project = await projectId(client);
  for (const name of names) {
    const items = readDataset(name);
    const problems = validateDataset(name, items);
    if (problems.length) throw new Error(`${name} is invalid; nothing synced:\n  ${problems.join("\n  ")}`);
    const r = await syncDataset(client.api, name, items, { dryRun, archiveMissing });
    const kinds = Object.entries(countByKind(items)).map(([k, n]) => `${k} ${n}`).join(", ");
    console.log(`${dryRun ? "[dry-run] " : ""}${name}: ${items.length} items (${kinds})`);
    console.log(`  dataset ${r.createdDataset ? "created" : "exists"} · created ${r.created.length} · updated ${r.updated.length} · unchanged ${r.unchanged.length} · orphans ${r.orphans.length}${archiveMissing ? ` · archived ${r.archived.length}` : ""}`);
    if (r.orphans.length && !archiveMissing) console.log(`  orphans (in Langfuse, not in the file; pass --archive-missing to archive): ${r.orphans.join(", ")}`);
    if (!dryRun) console.log(`  ${uiLink(project, `datasets/${r.datasetId}`)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
