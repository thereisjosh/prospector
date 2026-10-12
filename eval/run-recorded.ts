/**
 * Record or replay a full engine run against Exa.
 *
 *   tsx eval/run-recorded.ts --icp 1 --num 25 --max 15 --max-cost 0.6 --record <dir>
 *   tsx eval/run-recorded.ts --icp 1 --num 25 --max 15 --replay <dir> [--now <iso>]
 *
 * Flags: --no-prescreen (don't add pre-screen fields to the signal request, so
 * hashes match recordings made before pre-screening existed), --replay-lenient
 * (replay only: a missing company-lookup recording counts as `replayMiss` and
 * "no enrichment"; signal-search misses still throw).
 *
 * Record: every Exa request/response is saved under <dir>, and `now` is saved
 * in <dir>/run.json. Replay: no network; `now` defaults to the recorded value
 * so request hashes (which include startPublishedDate) match.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSearchType } from "../src/config";
import { runProspecting } from "../src/pipeline";
import type { IcpId } from "../src/types";
import { getV1Plan } from "./fixtures/v1-plans";

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-prescreen" || arg === "--replay-lenient") a[arg.slice(2)] = "true";
    else if (arg.startsWith("--")) a[arg.slice(2)] = argv[++i] ?? "";
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const icp = Number(args.icp ?? "1");
  if (icp !== 1 && icp !== 2 && icp !== 3) throw new Error("--icp must be 1, 2 or 3");
  if (!!args.record === !!args.replay) throw new Error("pass exactly one of --record <dir> or --replay <dir>");

  const dir = (args.record ?? args.replay)!;
  const replaying = !!args.replay;
  let nowIso = args.now;
  if (replaying && !nowIso) {
    const prior = join(dir, "run.json");
    if (!existsSync(prior)) throw new Error("--now required (no recorded run.json found)");
    nowIso = (JSON.parse(readFileSync(prior, "utf8")) as { now: string }).now;
  }
  const now = nowIso ? new Date(nowIso) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`invalid --now: ${nowIso}`);

  if (replaying) process.env.EXA_REPLAY_DIR = dir;
  else process.env.EXA_RECORD_DIR = dir;

  const num = Number(args.num ?? "25");
  const max = args.max ? Number(args.max) : undefined;
  const maxCost = args["max-cost"] ? Number(args["max-cost"]) : undefined;
  if (args["replay-lenient"] && !replaying) throw new Error("--replay-lenient requires --replay");
  const run = await runProspecting(getV1Plan(icp as IcpId), {
    type: parseSearchType(args.type),
    numResults: num,
    maxCandidates: max,
    maxCostDollars: maxCost,
    preScreen: !args["no-prescreen"],
    lenientReplay: !!args["replay-lenient"],
    now,
  });

  mkdirSync(dir, { recursive: true });
  // Replay must not clobber the recording's run.json; write run.replay.json instead.
  const outFile = join(dir, replaying ? "run.replay.json" : "run.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        now: now.toISOString(),
        args: { ...args, icp, num, max, maxCost },
        costDollars: run.totalCostDollars,
        funnel: run.funnel,
        rejected: run.rejected,
        enriched: run.enriched,
        enrichmentQueue: run.enrichmentQueue,
        rows: run.rows,
      },
      null,
      2,
    ),
  );

  const { rejections, ...stages } = run.funnel;
  console.log("enriched (rank order):", run.enriched.join(" | "));
  console.table({ ...stages, ...Object.fromEntries(Object.entries(rejections).map(([k, v]) => [`reject:${k}`, v])) });
  console.log(`costDollars: ${run.totalCostDollars.toFixed(3)}  rows: ${run.rows.length}  wrote ${outFile}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
