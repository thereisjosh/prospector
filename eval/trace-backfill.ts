/**
 * Backfill one recorded run into Langfuse ($0: no model or Exa calls).
 *
 *   npx tsx eval/trace-backfill.ts <recording-dir> [--environment eval]
 *
 * <recording-dir> holds events.jsonl + state.json (or an `agent/` subdir with them, as in
 * eval/recordings/agent-icp1-2026-10-12). Uses the same toObservations() as the live path.
 * Idempotent: it lists what Langfuse already has for the run's traces and sends only the
 * missing observations and scores, so a re-run creates no duplicates. --refresh-costs also re-sends
 * existing observations that lack the cost they now carry (tool Exa spend); Langfuse is append-only, so
 * that leaves a costless twin row per refreshed observation (totals correct, counts inflated). Off by default.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function parseArgs(argv: string[]): { dir: string; environment: string; concurrency: number; refreshCosts: boolean } {
  const args = [...argv];
  const refreshCosts = args.includes("--refresh-costs");
  if (refreshCosts) args.splice(args.indexOf("--refresh-costs"), 1);
  let environment = "eval";
  const envFlag = args.indexOf("--environment");
  if (envFlag >= 0) {
    environment = args[envFlag + 1] ?? "";
    args.splice(envFlag, 2);
  }
  let concurrency = 2;
  const cFlag = args.indexOf("--concurrency");
  if (cFlag >= 0) {
    concurrency = Number(args[cFlag + 1]);
    args.splice(cFlag, 2);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("--concurrency must be an integer 1-16");
  if (!/^(?!langfuse)[a-z0-9_-]{1,40}$/.test(environment)) throw new Error(`invalid environment "${environment}"`);
  const dir = args[0];
  if (!dir) throw new Error("usage: npx tsx eval/trace-backfill.ts <recording-dir> [--environment eval] [--concurrency 2] [--refresh-costs]");
  return { dir: resolve(dir), environment, concurrency, refreshCosts };
}

function runFiles(dir: string): { events: string; state: string } {
  for (const base of [dir, join(dir, "agent")]) {
    const events = join(base, "events.jsonl");
    const state = join(base, "state.json");
    if (existsSync(events) && existsSync(state)) return { events, state };
  }
  throw new Error(`no events.jsonl + state.json in ${dir} or ${join(dir, "agent")}`);
}

async function main() {
  const { dir, environment, concurrency, refreshCosts } = parseArgs(process.argv.slice(2));
  // Read by the span processor and the score client when they are created (lazily, below).
  process.env.LANGFUSE_TRACING_ENVIRONMENT = environment;
  const trace = await import("../src/agent/trace");
  if (!trace.enabled()) throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
  if (!process.env.TRACE_HMAC_SECRET) console.warn("TRACE_HMAC_SECRET is not set: traces will carry no userId");

  const files = runFiles(dir);
  const events = (await readFile(files.events, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as import("../src/agent/events").AgentEvent);
  const state = JSON.parse(await readFile(files.state, "utf8")) as { id?: string };
  const runId = events[0]?.runId ?? state.id;
  if (!runId) throw new Error("no runId in events or state");

  const result = await trace.backfill(events, state, {
    concurrency,
    refreshCosts,
    onProgress: ({ done, total, etaMs }) => console.log(`  checking existing: ${done}/${total}${etaMs !== undefined ? ` · ETA ${Math.ceil(etaMs / 1000)}s` : ""}`),
  });
  const stats = trace.traceStats();
  const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const project = await trace.projectId();
  const link = (path: string) => (project ? `${base}/project/${project}/${path}` : path);

  console.log(`run ${runId} · environment ${environment} · ${events.length} events → ${result.traces.length} traces`);
  console.log(`exported: ${result.exported.observations} observations, ${result.exported.scores} scores`);
  console.log(`already in Langfuse (skipped): ${result.skipped.observations} observations, ${result.skipped.scores} scores`);
  console.log(`export failures: ${stats.exportFailures} · emit errors: ${stats.emitErrors}`);
  console.log(`session: ${link(`sessions/${encodeURIComponent(runId)}`)}`);
  for (const t of result.traces) {
    console.log(
      `  turn ${String(t.turn).padStart(2)} · ${t.traceId} · obs ${t.newObservations}/${t.observations} new · scores ${t.newScores}/${t.scores} new · ${link(`traces/${t.traceId}`)}`,
    );
  }
  if (stats.exportFailures > 0 || stats.emitErrors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
