import { getIcpConfig, ICP_CONFIGS, parseSearchType } from "./config.js";
import { runProspecting, type EnrichmentCache } from "./pipeline.js";
import type { IcpId, ProspectRow } from "./types.js";

type Args = {
  icp: string;
  type?: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const searchType = parseSearchType(args.type);
  const icps = parseIcpSelection(args.icp);
  const enrichmentCache: EnrichmentCache = new Map();

  for (const icp of icps) {
    const run = await runProspecting(icp, {
      type: searchType,
      enrichmentCache,
    });
    const rows = run.rows.slice(0, 15);
    console.log(`\nICP ${icp.id}: ${icp.name}`);
    printTable(rows.slice(0, Math.max(10, Math.min(15, rows.length))));
    console.log(`costDollars.icp${icp.id}: ${run.totalCostDollars.toFixed(3)}`);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { icp: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--icp") args.icp = argv[++i] ?? "";
    if (arg === "--type") args.type = argv[++i];
  }
  return args;
}

function parseIcpSelection(value: string) {
  if (value === "all") return [...ICP_CONFIGS];
  const id = Number(value);
  if (id === 1 || id === 2 || id === 3) return [getIcpConfig(id as IcpId)];
  throw new Error("Run with --icp 1, --icp 2, --icp 3, or --icp all.");
}

function printTable(rows: ProspectRow[]) {
  const tableRows = rows.map((row) => ({
    company: row.company,
    why_now_signal: row.why_now_signal,
    signal_strength: row.signal_strength,
    signal_date: row.signal_date,
    source_url: row.signal_source_url,
    confidence: row.confidence_score,
    freshness: row.freshness_score,
    net_new: row.net_new,
  }));
  console.table(tableRows);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
