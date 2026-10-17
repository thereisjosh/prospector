/**
 * Online evaluation of production runs (SPEC-observability §5).
 *
 * At run end, in-process and fire-and-forget:
 *  1. the code graders (`gradeRun`, eval/graders) and outcome scores are posted on the run's
 *     last trace (deterministic score ids, so the hourly worker's re-post is an upsert);
 *  2. accepted leads are selected for the online judge: every lead of a run that ended with a
 *     handback or an error (priority), else a deterministic 20% sample, while the day's judge
 *     spend is under ONLINE_JUDGE_DAILY_CAP_DOLLARS. The judge runs IN-PROCESS on Jev
 *     (src/judges/jev.ts: Langfuse managed evaluators cannot call Jev): one call per selected
 *     lead asks Q1/Q2/Q3 over the judge payload (with evidence); an answer whose confidence is
 *     below ONLINE_JUDGE_MIN_CONFIDENCE (0.4) becomes `cannot_verify`. The result is a
 *     `lead-judge` observation (output, model, usage, costDetails) plus `judge_q1..q3` scores on
 *     it (source API, metadata.judge = "jev"); the hourly worker derives `judge_good` and queues
 *     "no" traces. With JEV_API_KEY unset nothing is judged (one warning per process, no
 *     fallback to another model). The Langfuse rule stays disabled; the managed evaluators are
 *     for comparison runs only. The offline Opus judge remains the ground truth;
 *  3. runs with a handback, an error or a failed must-pass grader go to the review queue.
 * A 👎 on a lead (feedback route) selects that lead for judging (priority) and queues its trace.
 *
 * Nothing here touches state.json or events.jsonl: selections and the once-per-run guard
 * live in `runs/<id>/online-evals.jsonl`, the daily judge ledger in
 * `<DATA_DIR>/online-judge-<UTC date>.json`. Everything is a no-op with LANGFUSE_* unset,
 * and nothing throws into the caller.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDemoRunId } from "../demo/mode";
import { RUNS_DIR, resolveDataDirs } from "./config";
import type { AgentEvent } from "./events";
import { withFileLock, writeFileAtomic } from "./fslock";
import { judgeContractFromPlan, judgeLeadFromState, judgePayload } from "./judge-input";
import type { AcceptedLead, RunState } from "./state";
import { cacheShare } from "./cache-share";
import { jevLeadJudge, LEAD_QUESTION_IDS, type JevLeadVerdict, type LeadQuestionId } from "../judges/jev";
import type { JudgeAnswer } from "../../eval/online/judge-prompt";
import { emitLeadJudge, enabled, trackBackground, enqueueForReview, score, traceIdFor, tracingEnvironment, type TraceScore } from "./trace";
import type { GradeReport, GraderState } from "../../eval/graders/types";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Langfuse environments the online judge rule matches (eval/online/setup-langfuse.ts). */
export const ONLINE_JUDGE_ENVIRONMENTS = ["production"];
/** Share of other accepted leads judged (RUBRIC sample). */
export const ONLINE_JUDGE_SAMPLE_RATE = 0.2;
/** Samples may use at most this share of the day's judge budget, so flagged leads are never crowded out. */
export const ONLINE_JUDGE_SAMPLE_SHARE = 0.5;
/** Jev answers below this confidence count as cannot_verify (decision 2026-10-17; the raw answer stays in the score metadata). Not calibrated on our data. */
export const ONLINE_JUDGE_MIN_CONFIDENCE = 0.4;

export type JudgeBudget = { capDollars: number; costPerLeadDollars: number; maxPerDay: number; maxSamplesPerDay: number };

/**
 * ONLINE_JUDGE_DAILY_CAP_DOLLARS (default $3; 0 turns online judging off). The cap is spent in
 * Jev dollars: a selection reserves ONLINE_JUDGE_COST_PER_LEAD_DOLLARS (default $0.001, a
 * pessimistic reservation: one Jev call over the payload is ~$0.0003), and once the call
 * returns the ledger holds the real cost computed from its usage (input tokens x $42/1e9).
 * `maxPerDay` is the number of reservations the cap allows, used for the samples' share.
 */
export function judgeBudget(env: Record<string, string | undefined> = process.env): JudgeBudget {
  const capRaw = Number(env.ONLINE_JUDGE_DAILY_CAP_DOLLARS ?? 3);
  const costRaw = Number(env.ONLINE_JUDGE_COST_PER_LEAD_DOLLARS ?? 0.001);
  const capDollars = Number.isFinite(capRaw) ? Math.max(0, capRaw) : 3;
  const costPerLeadDollars = Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 0.001;
  const maxPerDay = Math.floor(capDollars / costPerLeadDollars + 1e-9);
  return { capDollars, costPerLeadDollars, maxPerDay, maxSamplesPerDay: Math.floor(maxPerDay * ONLINE_JUDGE_SAMPLE_SHARE) };
}

/* ------------------------------------------------------------------ */
/* Pure helpers (shared with eval/online/worker.ts)                    */
/* ------------------------------------------------------------------ */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Stable key of a lead (company + signal URL), for dedupe and sampling. */
export function leadKey(company: string, signalUrl: string): string {
  return sha256(`${company.trim().toLowerCase()}|${signalUrl.trim()}`).slice(0, 16);
}

/** Deterministic sample: the same lead is always in or always out. */
export function inJudgeSample(runId: string, key: string, rate = ONLINE_JUDGE_SAMPLE_RATE): boolean {
  return parseInt(sha256(`judge-sample|${runId}|${key}`).slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

/** The toolUseId of the submit_lead call whose verdict accepted this lead (company/URL as clipped in events). */
export function findAcceptedSubmit(events: AgentEvent[], lead: Pick<AcceptedLead, "turn" | "company" | "signal_url">): string | undefined {
  for (let i = 0; i < events.length - 1; i += 1) {
    const e = events[i]!;
    const next = events[i + 1]!;
    if (e.turn !== lead.turn || e.kind !== "tool_call" || e.tool !== "submit_lead") continue;
    const input = (e.input ?? {}) as { company?: unknown; signal_url?: unknown };
    if (next.kind !== "submit_verdict" || next.ok !== true) continue;
    if (input.company !== lead.company.slice(0, 200) || input.signal_url !== lead.signal_url.slice(0, 200)) continue;
    return typeof e.toolUseId === "string" ? e.toolUseId : undefined;
  }
  return undefined;
}

/** Turn of the run's last trace: the highest turn in its events. */
export function lastTurn(events: AgentEvent[], state: Pick<RunState, "counters">): number {
  return events.reduce((max, e) => (typeof e.turn === "number" && e.turn > max ? e.turn : max), state.counters.turns);
}

/** Deterministic id of a run-level online score: the in-process post and the worker's re-post upsert the same score. */
export function runScoreId(environment: string, runId: string, name: string): string {
  return sha256(`online|${environment}|${runId}|${name}`).slice(0, 32);
}

const isFinished = (status: string) => status === "done" || status === "stopped" || status === "error";

/**
 * Run-level scores for the run's last trace: every applicable code grader (boolean +
 * comment, as in the L1 experiments), `must_pass`, and the outcome scores that need no
 * judge: `accepted_leads`, `run_cost_dollars`, `stop_reason`, `handback`.
 */
export function runEndScores(
  state: GraderState & { id: string },
  events: AgentEvent[],
  report: GradeReport,
  environment = tracingEnvironment(),
): TraceScore[] {
  const traceId = traceIdFor(state.id, lastTurn(events, state as Pick<RunState, "counters">), environment);
  const scores: TraceScore[] = [];
  const add = (name: string, value: number | string, dataType: TraceScore["dataType"], comment?: string) =>
    scores.push({ id: runScoreId(environment, state.id, name), traceId, name, value, dataType, ...(comment ? { comment: comment.slice(0, 500) } : {}) });
  for (const r of report.results) {
    if (r.applicable) add(r.name, r.pass ? 1 : 0, "BOOLEAN", r.comment);
  }
  const failedMust = report.results.filter((r) => r.mustPass && !r.pass).map((r) => r.name);
  add("must_pass", report.pass ? 1 : 0, "BOOLEAN", report.pass ? `${report.results.length} graders, all must-pass graders pass` : `failed: ${failedMust.join(", ")}`);
  add("accepted_leads", state.leads.length, "NUMERIC", `${state.leads.length} of ${state.contract.targetLeads} target`);
  add("run_cost_dollars", Math.round(state.spend.total * 10_000) / 10_000, "NUMERIC", `Claude $${state.spend.claude.toFixed(4)} + Exa $${state.spend.exa.toFixed(4)} (cap $${state.contract.maxCostDollars})`);
  // Accepted, not good: "good" needs the judge, which online cannot settle (SPEC-observability §5).
  // Left out at 0 leads (∞ is not a valid score), as cost_per_good_lead is in experiments.
  if (state.leads.length > 0) {
    add("cost_per_accepted_lead", Math.round((state.spend.total / state.leads.length) * 10_000) / 10_000, "NUMERIC", `$${state.spend.total.toFixed(4)} / ${state.leads.length} accepted`);
  }
  const cache = cacheShare(events);
  if (cache !== undefined) add("cache_share", Math.round(cache * 1000) / 1000, "NUMERIC", "cache_read / (input + cache_read + cache_creation) over the run's model calls");
  add("stop_reason", state.stopReason ?? state.status, "CATEGORICAL");
  add("handback", state.handback ? 1 : 0, "BOOLEAN", state.handback ? `${state.handback.suggestions.length} suggestion(s)` : undefined);
  return scores;
}

/* ------------------------------------------------------------------ */
/* Records and the daily judge ledger                                  */
/* ------------------------------------------------------------------ */

export type JudgeReason = "thumbs_down" | "handback" | "error" | "sample";

export type OnlineEvalRecord =
  | { kind: "run_end"; ts: string; scores: number; pass: boolean }
  | { kind: "judge_request"; ts: string; lead: string; reason: JudgeReason; priority: "high" | "sample"; traceId: string; observationId: string }
  | { kind: "judge_skipped"; ts: string; lead: string; reason: JudgeReason; why: "daily_cap" | "no_submit" | "jev_error" }
  | { kind: "review"; ts: string; objectId: string; why: string };

function recordsFile(runId: string): string {
  return join(RUNS_DIR, runId, "online-evals.jsonl");
}

export async function readOnlineEvalRecords(runId: string): Promise<OnlineEvalRecord[]> {
  try {
    const raw = await readFile(recordsFile(runId), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as OnlineEvalRecord);
  } catch {
    return [];
  }
}

async function appendRecords(runId: string, records: OnlineEvalRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(join(RUNS_DIR, runId), { recursive: true });
  await appendFile(recordsFile(runId), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function ledgerFile(date: Date, dataDir: string): string {
  return join(dataDir, `online-judge-${date.toISOString().slice(0, 10)}.json`);
}

/** `dollars` = Jev spend so far today (reservations replaced by real cost as calls finish). */
export type JudgeLedger = { judged: number; samples: number; dollars: number };

export async function readJudgeLedger(date = new Date(), dataDir = resolveDataDirs().data): Promise<JudgeLedger> {
  try {
    const raw = JSON.parse(await readFile(ledgerFile(date, dataDir), "utf8")) as Partial<JudgeLedger>;
    return { judged: Number(raw.judged) || 0, samples: Number(raw.samples) || 0, dollars: Number(raw.dollars) || 0 };
  } catch {
    return { judged: 0, samples: 0, dollars: 0 };
  }
}

/**
 * Take one judge slot for today (UTC) if the cap allows it: reserves the per-lead estimate in
 * dollars (`settleJudgeSpend` swaps it for the real cost). Priority leads may use the whole
 * budget; samples only `ONLINE_JUDGE_SAMPLE_SHARE` of it. Read-modify-write under a file lock.
 */
export async function reserveJudgeSlot(
  priority: "high" | "sample",
  options: { date?: Date; dataDir?: string; env?: Record<string, string | undefined> } = {},
): Promise<boolean> {
  const date = options.date ?? new Date();
  const dataDir = options.dataDir ?? resolveDataDirs().data;
  const budget = judgeBudget(options.env);
  if (budget.maxPerDay <= 0) return false;
  return withFileLock(join(dataDir, ".online-judge.lock"), async () => {
    const ledger = await readJudgeLedger(date, dataDir);
    if (ledger.dollars + budget.costPerLeadDollars > budget.capDollars + 1e-9) return false;
    if (priority === "sample" && ledger.samples >= budget.maxSamplesPerDay) return false;
    const next: JudgeLedger = { judged: ledger.judged + 1, samples: ledger.samples + (priority === "sample" ? 1 : 0), dollars: ledger.dollars + budget.costPerLeadDollars };
    await writeFileAtomic(ledgerFile(date, dataDir), JSON.stringify(next, null, 2));
    return true;
  });
}

/** Replace a slot's reserved estimate with what the Jev call really cost (0 when it failed). */
export async function settleJudgeSpend(
  actualDollars: number,
  options: { date?: Date; dataDir?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  const date = options.date ?? new Date();
  const dataDir = options.dataDir ?? resolveDataDirs().data;
  const { costPerLeadDollars } = judgeBudget(options.env);
  await withFileLock(join(dataDir, ".online-judge.lock"), async () => {
    const ledger = await readJudgeLedger(date, dataDir);
    const dollars = Math.max(0, ledger.dollars - costPerLeadDollars + actualDollars);
    await writeFileAtomic(ledgerFile(date, dataDir), JSON.stringify({ ...ledger, dollars }, null, 2));
  });
}

/* ------------------------------------------------------------------ */
/* The Jev verdict -> the three scores                                 */
/* ------------------------------------------------------------------ */

export type ThresholdedAnswer = {
  question: LeadQuestionId;
  /** What is written as `judge_<q>`: the raw answer, or cannot_verify when confidence < min. */
  answer: JudgeAnswer;
  raw: JudgeAnswer;
  confidence: number;
  probabilities: Record<string, number>;
  thresholded: boolean;
};

const fmtProbs = (p: Record<string, number>) => `yes ${p.yes?.toFixed(2) ?? "?"} / no ${p.no?.toFixed(2) ?? "?"} / cv ${p.cannot_verify?.toFixed(2) ?? "?"}`;

/** Apply the confidence threshold to a Jev verdict: below `min` the answer is cannot_verify, whatever was raw. */
export function thresholdVerdict(verdict: JevLeadVerdict, min = ONLINE_JUDGE_MIN_CONFIDENCE): ThresholdedAnswer[] {
  return LEAD_QUESTION_IDS.map((question) => {
    const raw = verdict[question]!;
    const confidence = verdict.confidence[question] ?? 0;
    const thresholded = confidence < min;
    return { question, answer: thresholded ? "cannot_verify" : raw, raw, confidence, probabilities: verdict.probabilities[question] ?? {}, thresholded };
  });
}

/** The injectable Jev call (tests use a fake fetch instead; this exists so the call site is one line). */
const judgeCall = (payload: Parameters<typeof jevLeadJudge>[0]) => jevLeadJudge(payload);

let warnedNoKey = false;
/** Tests: forget that the missing-key warning was printed. */
export function resetOnlineJudgeWarning(): void {
  warnedNoKey = false;
}

/* ------------------------------------------------------------------ */
/* Effects                                                             */
/* ------------------------------------------------------------------ */

const pending = new Set<Promise<unknown>>();

function background(fn: () => Promise<void>): void {
  const p = fn().catch((error) => {
    console.warn(`[online-eval] ${error instanceof Error ? error.message : String(error)}`);
  });
  pending.add(p);
  void p.finally(() => pending.delete(p));
  // flush() and the trace test-hook swap also wait for this work (it calls score() when it gets scheduled).
  trackBackground(p);
}

/** Tests: wait for every queued run-end / feedback evaluation. */
export async function onlineEvalIdle(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function readAllEvents(runId: string): Promise<AgentEvent[]> {
  try {
    const raw = await readFile(join(RUNS_DIR, runId, "events.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
  } catch {
    return [];
  }
}

/** The grader-relevant part of the state, copied so later mutations by the caller cannot race the background work. */
function snapshot(state: RunState): RunState {
  const { messages: _messages, caches: _caches, ...rest } = state;
  return structuredClone({ ...rest, messages: [], caches: { signalsByUrl: {}, enrichmentByName: {}, candidateCompanies: [], searchQueries: [], seenKeys: [] } }) as RunState;
}

/** Production, a non-zero cap, and a Jev key. Without the key: one warning per process, nothing judged, no other model. */
function judgeEnabled(): boolean {
  if (!ONLINE_JUDGE_ENVIRONMENTS.includes(tracingEnvironment()) || judgeBudget().maxPerDay <= 0) return false;
  if (!process.env.JEV_API_KEY?.trim()) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn("[online-eval] JEV_API_KEY is not set: the online lead judge is off (no fallback to another judge). Set it to judge production leads on Jev.");
    }
    return false;
  }
  return true;
}

async function requestJudge(
  state: RunState,
  lead: AcceptedLead,
  events: AgentEvent[],
  reason: JudgeReason,
  done: Set<string>,
): Promise<OnlineEvalRecord | undefined> {
  const key = leadKey(lead.company, lead.signal_url);
  if (done.has(key)) return undefined;
  const priority = reason === "sample" ? "sample" : "high";
  const toolUseId = findAcceptedSubmit(events, lead);
  const ts = new Date().toISOString();
  if (!toolUseId) return { kind: "judge_skipped", ts, lead: key, reason, why: "no_submit" };
  const day = new Date();
  if (!(await reserveJudgeSlot(priority, { date: day }))) return { kind: "judge_skipped", ts, lead: key, reason, why: "daily_cap" };
  const contract = judgeContractFromPlan(state.contract, new Date(state.createdAt));
  const input = judgePayload({ ...judgeLeadFromState(lead), contract });
  const metadata = { eval_priority: priority, eval_reason: reason, lead_key: key, judge: "jev" };
  let verdict: JevLeadVerdict;
  try {
    verdict = await judgeCall(input);
  } catch (error) {
    // Nothing was billed (or we cannot tell): release the reservation, record why, never throw into the loop.
    await settleJudgeSpend(0, { date: day }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[online-eval] Jev judge failed for ${key}: ${message.slice(0, 300)}`);
    emitLeadJudge({ runId: state.id, turn: lead.turn, toolUseId, input, metadata: { ...metadata, jev_error: message.slice(0, 300) }, state, ts });
    return { kind: "judge_skipped", ts, lead: key, reason, why: "jev_error" };
  }
  await settleJudgeSpend(verdict.costDollars, { date: day }).catch(() => undefined);
  const answers = thresholdVerdict(verdict);
  const emitted = emitLeadJudge({
    runId: state.id,
    turn: lead.turn,
    toolUseId,
    input,
    metadata: { ...metadata, jev_cost_dollars: verdict.costDollars },
    state,
    ts,
    judged: {
      output: Object.fromEntries(answers.map((a) => [`judge_${a.question}`, { answer: a.answer, raw: a.raw, confidence: a.confidence, probabilities: a.probabilities }])),
      model: verdict.model,
      inputTokens: verdict.inputTokens,
      outputTokens: 0,
      costDollars: verdict.costDollars,
    },
  });
  if (emitted) {
    for (const a of answers) {
      score({ traceId: emitted.traceId, observationId: emitted.observationId }, `judge_${a.question}`, a.answer, {
        dataType: "CATEGORICAL",
        workspaceId: state.workspaceId,
        comment: `jev ${verdict.model}: raw ${a.raw}, confidence ${a.confidence.toFixed(2)}${a.thresholded ? ` < ${ONLINE_JUDGE_MIN_CONFIDENCE} -> cannot_verify` : ""}; ${fmtProbs(a.probabilities)}`,
        metadata: { judge: "jev", model: verdict.model, question: a.question, raw_answer: a.raw, confidence: a.confidence, probabilities: a.probabilities, threshold: ONLINE_JUDGE_MIN_CONFIDENCE, thresholded: a.thresholded, cost_dollars: verdict.costDollars },
      });
    }
  }
  if (!emitted) return undefined;
  done.add(key);
  return { kind: "judge_request", ts, lead: key, reason, priority, ...emitted };
}

async function evaluateRunEnd(state: RunState): Promise<void> {
  const prior = await readOnlineEvalRecords(state.id);
  if (prior.some((r) => r.kind === "run_end")) return;
  const events = await readAllEvents(state.id);
  const { gradeRun } = await import("../../eval/graders");
  const report = gradeRun(state, events);
  const scores = runEndScores(state, events, report);
  for (const s of scores) score({ traceId: s.traceId }, s.name, s.value, { id: s.id, dataType: s.dataType, comment: s.comment, workspaceId: state.workspaceId });
  const records: OnlineEvalRecord[] = [{ kind: "run_end", ts: new Date().toISOString(), scores: scores.length, pass: report.pass }];

  if (judgeEnabled()) {
    const done = new Set(prior.filter((r) => r.kind === "judge_request").map((r) => (r as { lead: string }).lead));
    const flag: JudgeReason | undefined = state.status === "error" ? "error" : state.handback ? "handback" : undefined;
    for (const lead of state.leads) {
      const reason = flag ?? (inJudgeSample(state.id, leadKey(lead.company, lead.signal_url)) ? "sample" : undefined);
      if (!reason) continue;
      const record = await requestJudge(state, lead, events, reason, done);
      if (record) records.push(record);
    }
  }

  const why = [!report.pass ? `must-pass failed: ${report.failed.join(", ")}` : "", state.handback ? "handback" : "", state.status === "error" ? "error" : ""].filter(Boolean).join("; ");
  if (why) {
    const traceId = scores[0]!.traceId!;
    enqueueForReview(traceId, "TRACE");
    records.push({ kind: "review", ts: new Date().toISOString(), objectId: traceId, why });
  }
  await appendRecords(state.id, records);
}

/**
 * Call once when a run reaches done/stopped/error (loop `step`/`stopRun`, the step route's
 * allowance stop). Returns at once; the work runs in the background and never throws.
 */
export function runEnded(state: RunState): void {
  try {
    if (!enabled() || isDemoRunId(state.id) || !isFinished(state.status)) return;
    const copy = snapshot(state);
    background(() => evaluateRunEnd(copy));
  } catch (error) {
    console.warn(`[online-eval] ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A 👎 on an accepted lead: judge that lead (priority, still under the daily cap) unless it was
 * already selected, and queue the lead's turn trace for review. Never throws.
 */
export function leadFeedback(state: RunState, lead: AcceptedLead, verdict: "up" | "down"): void {
  try {
    if (verdict !== "down" || !enabled() || isDemoRunId(state.id)) return;
    const copy = snapshot(state);
    const target = structuredClone(lead);
    background(async () => {
      const prior = await readOnlineEvalRecords(copy.id);
      const records: OnlineEvalRecord[] = [];
      if (judgeEnabled()) {
        const done = new Set(prior.filter((r) => r.kind === "judge_request").map((r) => (r as { lead: string }).lead));
        const record = await requestJudge(copy, target, await readAllEvents(copy.id), "thumbs_down", done);
        if (record) records.push(record);
      }
      const traceId = traceIdFor(copy.id, target.turn);
      if (!prior.some((r) => r.kind === "review" && r.objectId === traceId)) {
        enqueueForReview(traceId, "TRACE");
        records.push({ kind: "review", ts: new Date().toISOString(), objectId: traceId, why: "thumbs_down" });
      }
      await appendRecords(copy.id, records);
    });
  } catch (error) {
    console.warn(`[online-eval] ${error instanceof Error ? error.message : String(error)}`);
  }
}
