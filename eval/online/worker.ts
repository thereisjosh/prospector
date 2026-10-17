import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gradeRun } from "../graders/index";
import type { GraderEvent, GraderState } from "../graders/types";
import { runEndScores } from "../../src/agent/online-eval";
import { REVIEW_QUEUE_NAME } from "../../src/agent/trace";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type LogLike = Pick<Console, "log" | "warn" | "error">;
type LangfuseScore = { create(body: Record<string, unknown>): unknown; flush(): Promise<unknown> };
type LangfuseLike = {
  score: LangfuseScore;
  api: {
    scoresV3: { getManyV3(req?: Record<string, unknown>): Promise<unknown> };
    annotationQueues: {
      listQueues(req?: Record<string, unknown>): Promise<unknown>;
      listQueueItems(queueId: string, req?: Record<string, unknown>): Promise<unknown>;
      createQueueItem(queueId: string, body: Record<string, unknown>): Promise<unknown>;
    };
    projects: { get(): Promise<unknown> };
  };
};

export type WorkerDeps = {
  fetch: FetchLike;
  langfuse: LangfuseLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  log?: LogLike;
  since?: string;
  dryRun?: boolean;
};

export type WorkerSummary = {
  runs: number;
  graded: number;
  scoresPosted: number;
  mustPassFailures: number;
  issuesOpened: number;
  dayCost: number;
  paused: boolean;
  judgeGoodPosted: number;
  queued: number;
};

const JUDGE_SCORE_NAMES = ["judge_q1", "judge_q2", "judge_q3"] as const;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const finished = (status: unknown): boolean => status === "done" || status === "stopped" || status === "error";

function baseUrl(env: Record<string, string | undefined>): string {
  const value = env.APP_URL;
  if (!value) throw new Error("APP_URL is required");
  return value.replace(/\/+$/, "");
}

function bearer(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return `Bearer ${value}`;
}

function dailyCap(env: Record<string, string | undefined>): number {
  const cap = Number(env.DAILY_SPEND_CAP_DOLLARS ?? 10);
  return Number.isFinite(cap) ? Math.max(0, cap) : 10;
}

/**
 * Runs updated in the last GRADE_WINDOW_MS are (re-)graded and their scores upserted. The app
 * already posts them at run end, so this is a repair pass; a short window keeps each run to
 * ~3 re-posts (Langfuse counts every score write as a billable unit) while tolerating a
 * skipped or late hourly Actions run. An explicit --since grades everything exported.
 */
export const GRADE_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Export from the start of the UTC day (the day cost needs every run active today) or the grade window, whichever is earlier. */
function defaultSince(now: Date): string {
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(Math.min(startToday, now.getTime() - GRADE_WINDOW_MS)).toISOString();
}

function parseArgs(argv: string[]): { since?: string; dryRun: boolean } {
  const out = { since: undefined as string | undefined, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--since") out.since = argv[++i];
    else if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
  }
  return out;
}

async function getJson(fetcher: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetcher(url, init);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json() as Promise<unknown>;
}

function scoreValue(score: Record<string, unknown>): string | undefined {
  return str(score.stringValue) ?? (typeof score.value === "string" ? score.value : undefined);
}

function scoreSubject(score: Record<string, unknown>): { observationId?: string; traceId?: string } {
  const subject = rec(score.subject);
  if (subject.kind === "observation") return { observationId: str(subject.id), traceId: str(subject.traceId) };
  return { observationId: str(score.observationId), traceId: str(score.traceId) };
}

function projectIdOf(value: unknown): string {
  const root = rec(value);
  return str(root.id) ?? str(rec(arr(root.data)[0]).id) ?? "unknown";
}

function issueTitleHasRun(title: unknown, runId: string): boolean {
  return typeof title === "string" && title.includes(runId);
}

async function openIssues(fetcher: FetchLike, env: Record<string, string | undefined>, label: string): Promise<Array<Record<string, unknown>>> {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const url = `https://api.github.com/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`;
  const data = await getJson(fetcher, url, { headers: { authorization: bearer(env, "GITHUB_TOKEN"), accept: "application/vnd.github+json" } });
  return arr(data).map(rec);
}

async function createIssue(
  fetcher: FetchLike,
  env: Record<string, string | undefined>,
  body: { title: string; body: string; labels: string[] },
  dryRun: boolean,
  log: LogLike,
): Promise<boolean> {
  if (dryRun) {
    log.log(`[dry-run] issue ${body.title}`);
    return false;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const res = await fetcher(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { authorization: bearer(env, "GITHUB_TOKEN"), accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`open issue failed: ${res.status}`);
  const created = rec(await res.json());
  log.log(`opened issue ${num(created.number) || str(created.html_url) || body.title}`);
  return true;
}

function traceUrl(env: Record<string, string | undefined>, projectId: string, traceId: string): string {
  const root = (env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
  return `${root}/project/${projectId}/traces/${traceId}`;
}

function failedBody(runId: string, stopReason: unknown, failures: Array<{ name: string; comment?: string }>, link: string): string {
  return [`Run: ${runId}`, `Stop reason: ${str(stopReason) ?? "unknown"}`, `Trace: ${link}`, "", "Failed graders:", ...failures.map((f) => `- ${f.name}: ${f.comment ?? ""}`)].join("\n");
}

function eventCostOnDate(events: unknown[], day: string): number {
  let total = 0;
  for (const event of events.map(rec)) {
    const ts = str(event.ts);
    if (!ts || ts.slice(0, 10) !== day) continue;
    total += num(event.claudeCost) + num(event.exaCost);
  }
  return total;
}

async function pauseApp(fetcher: FetchLike, env: Record<string, string | undefined>, reason: string, dryRun: boolean, log: LogLike): Promise<boolean> {
  if (dryRun) {
    log.log(`[dry-run] pause ${reason}`);
    return false;
  }
  const res = await fetcher(`${baseUrl(env)}/api/admin/pause`, {
    method: "POST",
    headers: { authorization: bearer(env, "ADMIN_TOKEN"), "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`pause failed: ${res.status}`);
  return true;
}

async function listAllQueueItems(langfuse: LangfuseLike, queueId: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page += 1) {
    const data = rec(await langfuse.api.annotationQueues.listQueueItems(queueId, { page, limit: 100 }));
    out.push(...arr(data.data).map(rec));
    const meta = rec(data.meta);
    if (num(meta.totalPages) <= page || arr(data.data).length === 0) break;
  }
  return out;
}

async function reviewQueueId(langfuse: LangfuseLike): Promise<string | undefined> {
  for (let page = 1; ; page += 1) {
    const data = rec(await langfuse.api.annotationQueues.listQueues({ page, limit: 100 }));
    const found = arr(data.data).map(rec).find((q) => str(q.name) === REVIEW_QUEUE_NAME);
    if (found) return str(found.id);
    const meta = rec(data.meta);
    if (num(meta.totalPages) <= page || arr(data.data).length === 0) return undefined;
  }
}

async function processJudgeScores(deps: Required<Pick<WorkerDeps, "langfuse" | "log">> & { since: string; dryRun: boolean }): Promise<{ posted: number; queued: number }> {
  const grouped = new Map<string, { traceId?: string; answers: Partial<Record<(typeof JUDGE_SCORE_NAMES)[number], string>> }>();
  for (const name of JUDGE_SCORE_NAMES) {
    for (let cursor: string | undefined; ; ) {
      const page = rec(
        await deps.langfuse.api.scoresV3.getManyV3({
          name,
          // The online verdicts only: the in-process Jev judge writes source API (EVAL is reserved
          // for Langfuse's own evaluators and cannot be created through the API) and the managed
          // evaluators, when run for comparison, write EVAL. Human labels in review-queue are
          // ANNOTATION and share these names, so they are excluded.
          source: "EVAL,API",
          environment: "production",
          fromTimestamp: deps.since,
          limit: 100,
          fields: "subject",
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const item of arr(page.data).map(rec)) {
        const subject = scoreSubject(item);
        if (!subject.observationId) continue;
        const value = scoreValue(item);
        if (value !== "yes" && value !== "no" && value !== "cannot_verify") continue;
        const existing = grouped.get(subject.observationId) ?? { traceId: subject.traceId, answers: {} };
        existing.traceId ??= subject.traceId;
        existing.answers[name] = value;
        grouped.set(subject.observationId, existing);
      }
      cursor = str(rec(page.meta).cursor);
      if (!cursor) break;
    }
  }

  let posted = 0;
  const noTraceIds = new Set<string>();
  for (const [observationId, group] of grouped) {
    const answers = group.answers;
    if (Object.values(answers).includes("no") && group.traceId) noTraceIds.add(group.traceId);
    const q1 = answers.judge_q1;
    const q2 = answers.judge_q2;
    const q3 = answers.judge_q3;
    if (!q1 || !q2 || !q3) continue;
    const value = q1 === "no" || q2 === "no" || q3 === "no" ? 0 : q1 === "yes" && q3 === "yes" && q2 !== "no" ? 1 : undefined;
    if (value === undefined || !group.traceId) continue;
    const body = {
      id: sha256(`online|production|${observationId}|judge_good`).slice(0, 32),
      traceId: group.traceId,
      observationId,
      name: "judge_good",
      value,
      dataType: "BOOLEAN",
      environment: "production",
      comment: `online judge: q1=${q1} q2=${q2} q3=${q3}`,
    };
    if (deps.dryRun) deps.log.log(`[dry-run] score judge_good ${observationId}`);
    else deps.langfuse.score.create(body);
    posted += 1;
  }

  const queueId = await reviewQueueId(deps.langfuse);
  if (!queueId) {
    if (noTraceIds.size) deps.log.warn(`review queue ${REVIEW_QUEUE_NAME} not found; skipped ${noTraceIds.size}`);
    return { posted, queued: 0 };
  }
  const existing = new Set((await listAllQueueItems(deps.langfuse, queueId)).map((item) => str(item.objectId)).filter((v): v is string => Boolean(v)));
  let queued = 0;
  for (const traceId of noTraceIds) {
    if (existing.has(traceId)) continue;
    if (deps.dryRun) deps.log.log(`[dry-run] queue ${traceId}`);
    else await deps.langfuse.api.annotationQueues.createQueueItem(queueId, { objectId: traceId, objectType: "TRACE", status: "PENDING" });
    queued += 1;
  }
  return { posted, queued };
}

export async function runWorker(deps: WorkerDeps): Promise<WorkerSummary> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console;
  const now = deps.now?.() ?? new Date();
  const since = deps.since ?? defaultSince(now);
  const gradeFrom = deps.since ? Date.parse(deps.since) : now.getTime() - GRADE_WINDOW_MS;
  const dryRun = deps.dryRun ?? false;
  const exported = rec(
    await getJson(deps.fetch, `${baseUrl(env)}/api/admin/runs/export?since=${encodeURIComponent(since)}`, {
      headers: { authorization: bearer(env, "ADMIN_TOKEN") },
    }),
  );
  const runs = arr(exported.runs).map(rec);
  const summary: WorkerSummary = { runs: runs.length, graded: 0, scoresPosted: 0, mustPassFailures: 0, issuesOpened: 0, dayCost: 0, paused: false, judgeGoodPosted: 0, queued: 0 };
  const projectId = projectIdOf(await deps.langfuse.api.projects.get());
  const existingMustPass = await openIssues(deps.fetch, env, "must-pass");
  const today = now.toISOString().slice(0, 10);

  for (const run of runs) {
    const state = rec(run.state);
    const events = arr(run.events).map(rec) as GraderEvent[];
    summary.dayCost += eventCostOnDate(events, today);
    if (!finished(state.status)) continue;
    const updatedAt = Date.parse(str(run.updatedAt) ?? "");
    if (Number.isFinite(updatedAt) && updatedAt < gradeFrom) continue;
    summary.graded += 1;
    const runId = str(state.id) ?? str(run.id) ?? "unknown";
    const report = gradeRun(state as unknown as GraderState, events);
    const scores = runEndScores({ ...(state as unknown as GraderState), id: runId }, events, report, "production");
    for (const score of scores) {
      if (dryRun) log.log(`[dry-run] score ${runId} ${score.name}`);
      else deps.langfuse.score.create({ ...score, environment: "production" });
      summary.scoresPosted += 1;
    }
    const failures = report.results.filter((r) => r.mustPass && !r.pass).map((r) => ({ name: r.name, comment: r.comment }));
    if (failures.length > 0) {
      summary.mustPassFailures += 1;
      if (!existingMustPass.some((issue) => issueTitleHasRun(issue.title, runId))) {
        const traceId = scores[0]?.traceId ?? "unknown";
        const opened = await createIssue(
          deps.fetch,
          env,
          {
            title: `must-pass failed: ${failures.map((f) => f.name).join(", ")} on run ${runId}`,
            body: failedBody(runId, state.stopReason, failures, traceUrl(env, projectId, traceId)),
            labels: ["must-pass", "online-evals"],
          },
          dryRun,
          log,
        );
        if (opened) summary.issuesOpened += 1;
      }
    }
  }

  const cap = dailyCap(env);
  if (cap > 0 && summary.dayCost > cap) {
    const cost = summary.dayCost.toFixed(2);
    const capText = cap.toFixed(2);
    summary.paused = await pauseApp(deps.fetch, env, `worker: day cost $${cost} > cap $${capText}`, dryRun, log);
    const existingSpend = await openIssues(deps.fetch, env, "spend-cap");
    if (!existingSpend.some((issue) => typeof issue.title === "string" && issue.title.includes(today))) {
      const opened = await createIssue(
        deps.fetch,
        env,
        { title: `spend cap exceeded on ${today}: $${cost} > $${capText}`, body: `Day cost from exported events: $${cost}\nCap: $${capText}`, labels: ["spend-cap", "online-evals"] },
        dryRun,
        log,
      );
      if (opened) summary.issuesOpened += 1;
    }
  }

  const judge = await processJudgeScores({ langfuse: deps.langfuse, log, since, dryRun });
  summary.judgeGoodPosted = judge.posted;
  summary.queued = judge.queued;
  if (!dryRun) await deps.langfuse.score.flush();
  log.log(`runs=${summary.runs} graded=${summary.graded} scores=${summary.scoresPosted} mustPass=${summary.mustPassFailures} queued=${summary.queued}`);
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { LangfuseClient } = await import("@langfuse/client");
  const args = parseArgs(argv);
  const langfuse = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  }) as unknown as LangfuseLike;
  const summary = await runWorker({ fetch: globalThis.fetch, langfuse, env: process.env, since: args.since, dryRun: args.dryRun });
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
