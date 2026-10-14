/**
 * Calibrate the online lead judges against the human-labelled set
 * (.agents/skills/langfuse/references/judge-calibration.md §2–§3).
 *
 *   npx tsx eval/online/calibrate-judge.ts                 # $0: fetch sets + prompts, print the cost estimate
 *   npx tsx eval/online/calibrate-judge.ts --run --max-dollars 1 [--judge judge_q1] [--item <company substring>]
 *   npx tsx eval/online/calibrate-judge.ts --dry-run --judge judge_q3   # $0: stub verdicts, run "dry-run · …" in Langfuse
 *   npx tsx eval/online/calibrate-judge.ts --list-runs judge_q3         # $0: experiment runs + per-item verdicts (30 days)
 *
 * --run is PAID (Anthropic, same model as the evaluator). For each judge it fetches the dataset
 * `judge-calibration/<judge>` and the candidate prompt `judge-calibration/<judge>` (latest
 * version) from Langfuse, runs that prompt on every item with the Experiments SDK
 * (`dataset.runExperiment`), and scores each result with the Boolean evaluator
 * `<judge>-judge-output-correct` (output === expected output). It then prints accuracy and
 * every mismatch (input, expected, actual, full reasoning), writes every verdict to
 * eval/results/calibration/<date>/<judge>.json, and confirms the run is listed by the Langfuse
 * Experiments API. It refuses to start if the estimate exceeds --max-dollars.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { LangfuseClient } from "@langfuse/client";
import { CLAUDE_PRICES_PER_MILLION, claudeCostDollars } from "../../src/agent/config";
import { createLangfuseClient, EVAL_ENVIRONMENT, projectId, uiLink } from "../langfuse/client";
import { startSdkTracing } from "../langfuse/otel";
import { calibrationDatasetName } from "./calibration-set";
import { JUDGE_CATEGORIES, JUDGE_MODEL, JUDGE_QUESTIONS, LEAD_VARIABLE, judgeOutputDefinition, type JudgeAnswer, type JudgeQuestion } from "./judge-prompt";

/**
 * Output budget per verdict: adaptive thinking (always on for claude-opus-5-5) + reasoning + the
 * verdict tool call. 600 truncated one 2026-10-14 verdict mid tool call ("invalid", empty reasoning).
 */
export const MAX_OUTPUT_TOKENS = 1000;
/**
 * Characters per input token, and the per-call input the prompt text does not show (the API's
 * tool-use system prompt + the verdict tool schema). No tokenizer call (that is an Anthropic
 * request). Calibrated on the 2026-10-14 judge_q1 round: 67,786 prompt chars over 10 calls cost
 * $0.236, while 3.2 chars/token + 400 chars estimated $0.21 even with every output at its 600
 * budget, so input was under-counted (the Opus 4.7+ tokenizer uses more tokens per char). With
 * these values that round estimates $0.26, an upper bound unless outputs averaged < ~430 tokens.
 */
export const CHARS_PER_TOKEN = 2.2;
export const PER_CALL_OVERHEAD_TOKENS = 500;

type Message = { role: "system" | "user"; content: string };

export function compile(messages: Message[], lead: unknown): Message[] {
  const json = JSON.stringify(lead, null, 2);
  return messages.map((m) => ({ ...m, content: m.content.split(`{{${LEAD_VARIABLE}}}`).join(json) }));
}

/** Upper-bound cost of one verdict: estimated input tokens + the whole output budget. */
export function estimateCallDollars(messages: Message[], model = JUDGE_MODEL.model): { inputTokens: number; dollars: number } {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN) + PER_CALL_OVERHEAD_TOKENS;
  const p = CLAUDE_PRICES_PER_MILLION[model as keyof typeof CLAUDE_PRICES_PER_MILLION];
  return { inputTokens, dollars: (inputTokens * p.input + MAX_OUTPUT_TOKENS * p.output) / 1_000_000 };
}

/** The Boolean experiment evaluator the reference prescribes: true only on an exact match. */
export function outputCorrect(question: JudgeQuestion) {
  return async ({ output, expectedOutput }: { output: unknown; expectedOutput?: unknown }) => ({
    name: `${question}-judge-output-correct`,
    value: (output as { score?: unknown } | undefined)?.score === expectedOutput ? 1 : 0,
    dataType: "BOOLEAN" as const,
    comment: `expected ${String(expectedOutput)}, got ${String((output as { score?: unknown } | undefined)?.score)}`,
  });
}

const VERDICT_INSTRUCTION = "Answer by calling the `verdict` tool exactly once.";

const VERDICT_TOOL = (question: JudgeQuestion) => {
  const def = judgeOutputDefinition(question);
  return {
    name: "verdict",
    description: "Record the verdict.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: { type: "string", description: def.scoreReasoningInstructions },
        score: { type: "string", enum: [...JUDGE_CATEGORIES], description: def.scoreValueInstructions },
      },
      required: ["reasoning", "score"],
    },
  };
};

/** One judge call with structured output, like the managed evaluator's (reasoning + one category). */
export async function judgeOnce(client: Pick<Anthropic, "messages">, question: JudgeQuestion, messages: Message[]): Promise<{ score: JudgeAnswer | "invalid"; reasoning: string; costDollars: number }> {
  const system = messages.find((m) => m.role === "system")?.content;
  const response = (await client.messages.create({
    model: JUDGE_MODEL.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m, i, all) => ({ role: "user" as const, content: i === all.length - 1 ? `${m.content}\n\n${VERDICT_INSTRUCTION}` : m.content })),
    tools: [VERDICT_TOOL(question)],
    // No forced tool_choice: claude-opus-5-5 rejects type "tool"/"any" with a 400 (same constraint as src/agent/loop.ts).
  } as never)) as unknown as { content: Array<{ type: string; text?: string; input?: { score?: unknown; reasoning?: unknown } }>; usage?: Record<string, number> };
  const costDollars = claudeCostDollars(JUDGE_MODEL.model, response.usage ?? {});
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block) {
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return { score: "invalid", reasoning: `no verdict tool call: ${text.slice(0, 500)}`, costDollars };
  }
  const score = (JUDGE_CATEGORIES as readonly string[]).includes(String(block?.input?.score)) ? (block!.input!.score as JudgeAnswer) : "invalid";
  return { score, reasoning: String(block.input?.reasoning ?? ""), costDollars };
}

/**
 * `dataset.runExperiment` (@langfuse/client) has no error channel: a throwing task is caught inside its worker loop,
 * logged at logger level as "Task failed with error: … Skipping item.", and the item is dropped from `itemResults`.
 * So the task must catch itself: log the item id + message, count it, and rethrow so the SDK still drops the item.
 */
export function trackErrors<I extends { id?: string }, O>(task: (item: I) => Promise<O>, errors: Array<{ id: string; message: string }>, log: (line: string) => void = console.error) {
  return async (item: I): Promise<O> => {
    try {
      return await task(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ id: String(item.id ?? "?"), message });
      log(`item ${String(item.id ?? "?")} failed: ${message}`);
      throw error;
    }
  };
}

/** `N/M correct, K errors`; M counts every dataset item, errored ones included (they are not correct). */
export function summaryLine(q: string, correct: number, total: number, errors: number): string {
  return `${q}: ${correct}/${total} correct, ${errors} errors`;
}

type FetchedItem = { id: string; datasetId?: string; input: unknown; expectedOutput?: unknown; metadata?: unknown };

/** `--item <substring>`: the items whose company contains it (case-insensitive); all items without a filter. */
export function selectItems<T extends { input: unknown }>(items: T[], substring?: string): T[] {
  if (substring === undefined) return items;
  const needle = substring.toLowerCase();
  return items.filter((i) => String((i.input as { company?: unknown } | null)?.company ?? "").toLowerCase().includes(needle));
}

async function fetchSet(client: LangfuseClient, question: JudgeQuestion, itemFilter?: string): Promise<{ items: FetchedItem[]; messages: Message[]; promptVersion: number }> {
  const name = calibrationDatasetName(question);
  const dataset = await client.dataset.get(name);
  const prompt = (await client.api.prompts.get(name, { label: "latest", resolve: false })) as unknown as { version: number; prompt: Message[] };
  const items = selectItems(dataset.items as unknown as FetchedItem[], itemFilter);
  if (items.length === 0) throw new Error(`--item ${JSON.stringify(itemFilter)} matches no company in ${name}`);
  return { items, messages: prompt.prompt.map((m) => ({ role: m.role, content: m.content })), promptVersion: prompt.version };
}

export async function estimate(client: LangfuseClient, questions: JudgeQuestion[], itemFilter?: string) {
  const rows: Array<{ question: JudgeQuestion; items: number; promptVersion: number; inputTokens: number; dollars: number; labels: Record<string, number> }> = [];
  for (const q of questions) {
    const { items, messages, promptVersion } = await fetchSet(client, q, itemFilter);
    let inputTokens = 0;
    let dollars = 0;
    const labels: Record<string, number> = {};
    for (const item of items) {
      const e = estimateCallDollars(compile(messages, item.input));
      inputTokens += e.inputTokens;
      dollars += e.dollars;
      labels[String(item.expectedOutput)] = (labels[String(item.expectedOutput)] ?? 0) + 1;
    }
    rows.push({ question: q, items: items.length, promptVersion, inputTokens, dollars, labels });
  }
  return { rows, total: rows.reduce((n, r) => n + r.dollars, 0) };
}

type Verdict = { score: JudgeAnswer | "invalid"; reasoning: string; costDollars: number };

export type ReportItem = {
  datasetItemId: string;
  company: string;
  signal_url: string;
  expected: string;
  /** The judge's category, "invalid", or "error" when the task threw (see `error`). */
  actual: string;
  correct: boolean;
  /** Full, untruncated. */
  reasoning: string;
  costDollars: number;
  /** Langfuse trace of the item (null when the task threw: the SDK drops the item result). */
  traceId: string | null;
  error?: string;
};

export type CalibrationReport = {
  judge: JudgeQuestion;
  runName: string;
  /** Langfuse experiment id (Experiments API). */
  experimentId: string;
  dataset: string;
  datasetId: string | null;
  promptVersion: number;
  model: string;
  itemFilter: string | null;
  createdAt: string;
  correct: number;
  total: number;
  errors: number;
  spentDollars: number;
  items: ReportItem[];
};

/** One report row per selected dataset item, in dataset order; errored items included as "error". */
export function reportItems(
  selected: FetchedItem[],
  results: Array<{ item: { id?: string }; output?: Partial<Verdict>; traceId?: string }>,
  errors: Array<{ id: string; message: string }>,
): ReportItem[] {
  return selected.map((item) => {
    const input = (item.input ?? {}) as { company?: unknown; signal_url?: unknown };
    const base = { datasetItemId: item.id, company: String(input.company ?? ""), signal_url: String(input.signal_url ?? ""), expected: String(item.expectedOutput) };
    const r = results.find((x) => x.item.id === item.id);
    if (!r) {
      const message = errors.find((e) => e.id === item.id)?.message ?? "no result from the experiment runner";
      return { ...base, actual: "error", correct: false, reasoning: "", costDollars: 0, traceId: null, error: message };
    }
    const actual = String(r.output?.score ?? "invalid");
    return { ...base, actual, correct: actual === base.expected, reasoning: String(r.output?.reasoning ?? ""), costDollars: r.output?.costDollars ?? 0, traceId: r.traceId ?? null };
  });
}

/** eval/results/calibration/<YYYY-MM-DD>/<judge>.json; a --item run gets its own file so it never replaces the full round. */
export function reportPath(report: Pick<CalibrationReport, "judge" | "createdAt" | "itemFilter">, root = "eval/results"): string {
  const slug = report.itemFilter === null ? "" : `.item-${report.itemFilter.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return join(root, "calibration", report.createdAt.slice(0, 10), `${report.judge}${slug}.json`);
}

export function writeReport(report: CalibrationReport, root?: string): string {
  const path = reportPath(report, root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/** Mismatch table (reasoning shortened to fit a row), then every mismatch's full reasoning. */
export function mismatchLines(items: ReportItem[]): string[] {
  const wrong = items.filter((i) => !i.correct);
  const lines = ["| Dataset input | Expected output | Actual output |", "|---|---|---|"];
  for (const i of wrong) lines.push(`| ${i.company} · ${i.signal_url} | ${i.expected} | ${i.actual} — ${(i.error ?? i.reasoning).replace(/\s+/g, " ").slice(0, 200)} |`);
  if (wrong.length) lines.push("", "Full reasoning for each mismatch:");
  for (const i of wrong) lines.push("", `### ${i.company} (expected ${i.expected}, got ${i.actual}; trace ${i.traceId ?? "none"})`, i.error ? `task error: ${i.error}` : i.reasoning || "(empty reasoning)");
  return lines;
}

type ExperimentsApi = Pick<LangfuseClient["api"]["experiments"], "list" | "listItems">;

/**
 * Wait until the Experiments API lists the run with every item (ingestion is asynchronous).
 * Returns the item count seen; throws if the run never appears.
 */
export async function confirmExperiment(api: ExperimentsApi, opts: { experimentId: string; datasetId: string | null; fromStartTime: string; expectedItems: number; timeoutMs?: number; intervalMs?: number }): Promise<number> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let seen = -1;
  for (;;) {
    const page = await api.list({ fromStartTime: opts.fromStartTime, id: opts.experimentId, ...(opts.datasetId ? { datasetId: opts.datasetId } : {}) });
    const found = page.data.find((e) => e.id === opts.experimentId);
    seen = found ? found.itemCount : -1;
    if (seen >= opts.expectedItems) return seen;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5_000));
  }
  throw new Error(seen < 0 ? `experiment ${opts.experimentId} not listed by the Experiments API after ${(opts.timeoutMs ?? 120_000) / 1000}s` : `experiment ${opts.experimentId} lists ${seen}/${opts.expectedItems} items`);
}

export const DRY_RUN_PREFIX = "dry-run · ";

async function run(client: LangfuseClient, questions: JudgeQuestion[], opts: { maxDollars?: number; dryRun: boolean; itemFilter?: string }) {
  const { rows, total } = await estimate(client, questions, opts.itemFilter);
  if (!opts.dryRun && total > (opts.maxDollars ?? 0)) throw new Error(`estimated $${total.toFixed(2)} > --max-dollars ${opts.maxDollars}; nothing was run`);
  const judge = opts.dryRun
    ? async (): Promise<Verdict> => ({ score: "invalid", reasoning: "dry-run", costDollars: 0 })
    : await (async () => {
        const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
        const anthropic = new AnthropicSdk();
        return (q: JudgeQuestion, messages: Message[]) => judgeOnce(anthropic, q, messages);
      })();
  const project = await projectId(client);
  const sdkTracing = await startSdkTracing({ environment: EVAL_ENVIRONMENT });
  let spent = 0;
  let errorCount = 0;
  const pending: Array<{ report: CalibrationReport; startedAt: string }> = [];
  try {
    for (const q of questions) {
      const { messages, promptVersion, items: selected } = await fetchSet(client, q, opts.itemFilter);
      const dataset = await client.dataset.get(calibrationDatasetName(q));
      const errors: Array<{ id: string; message: string }> = [];
      const startedAt = new Date().toISOString();
      const runName = `${opts.dryRun ? DRY_RUN_PREFIX : ""}${q} prompt v${promptVersion}${opts.itemFilter ? ` · item ${opts.itemFilter}` : ""} · ${startedAt.slice(0, 16)}`;
      const result = (await dataset.runExperiment({
        name: `judge-calibration/${q}`,
        runName,
        description: `Calibration of the online ${q} evaluator (prompt judge-calibration/${q} v${promptVersion}, ${JUDGE_MODEL.model})${opts.dryRun ? "; dry run, no model call" : ""}`,
        metadata: { judge: q, promptVersion, model: JUDGE_MODEL.model, dryRun: opts.dryRun },
        data: selected,
        task: trackErrors(async (item: { id?: string; input: unknown }) => {
          const out = await judge(q, compile(messages, item.input));
          spent += out.costDollars;
          return out;
        }, errors),
        evaluators: [outputCorrect(q)],
      } as never)) as unknown as { experimentId: string; itemResults: Array<{ item: FetchedItem; output?: Partial<Verdict>; traceId?: string }> };
      const items = reportItems(selected, result.itemResults, errors);
      errorCount += errors.length;
      const correct = items.filter((i) => i.correct).length;
      const report: CalibrationReport = {
        judge: q,
        runName,
        experimentId: result.experimentId,
        dataset: calibrationDatasetName(q),
        datasetId: selected[0]?.datasetId ?? null,
        promptVersion,
        model: JUDGE_MODEL.model,
        itemFilter: opts.itemFilter ?? null,
        createdAt: startedAt,
        correct,
        total: selected.length,
        errors: errors.length,
        spentDollars: items.reduce((n, i) => n + i.costDollars, 0),
        items,
      };
      console.log(`\n${summaryLine(q, correct, selected.length, errors.length)} (${((correct / Math.max(1, selected.length)) * 100).toFixed(0)}%; the reference treats 85% as good only if every category is acceptable)`);
      for (const line of mismatchLines(items)) console.log(line);
      if (opts.dryRun) console.log(`\n(dry run: report not written; it would go to ${reportPath(report)})`);
      else console.log(`\nreport: ${writeReport(report)}`);
      pending.push({ report, startedAt });
    }
  } finally {
    await client.flush();
    await sdkTracing.shutdown();
  }
  for (const { report, startedAt } of pending) {
    const from = new Date(Date.parse(startedAt) - 60_000).toISOString();
    const seen = await confirmExperiment(client.api.experiments, { experimentId: report.experimentId, datasetId: report.datasetId, fromStartTime: from, expectedItems: report.total - report.errors });
    console.log(`Langfuse experiment "${report.runName}" (${report.experimentId}): ${seen} items listed · ${report.datasetId ? uiLink(project, `datasets/${report.datasetId}`) : uiLink(project, "experiments")}`);
  }
  console.log(`\nspent $${spent.toFixed(4)} (estimated ≤ $${total.toFixed(2)})`);
  if (errorCount > 0) {
    console.error(`${errorCount} task errors; results above are incomplete`);
    process.exitCode = 1;
  }
  return { rows, spent, errorCount };
}

/** The Experiments API returns item input/output as JSON strings. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** `--list-runs <judge>` ($0): experiment runs on the judge's calibration dataset, with each item's verdict. */
export async function listRuns(api: Pick<LangfuseClient["api"], "datasets" | "experiments">, q: JudgeQuestion, days = 30, log: (line: string) => void = console.log): Promise<number> {
  const name = calibrationDatasetName(q);
  const dataset = await api.datasets.get(name);
  const fromStartTime = new Date(Date.now() - days * 86_400_000).toISOString();
  const experiments: Array<{ id: string; name: string; startTime: string; itemCount: number }> = [];
  let cursor: string | undefined;
  do {
    const page = await api.experiments.list({ fromStartTime, datasetId: dataset.id, limit: 100, ...(cursor ? { cursor } : {}) });
    experiments.push(...page.data);
    cursor = page.meta.cursor ?? undefined;
  } while (cursor);
  experiments.sort((a, b) => a.startTime.localeCompare(b.startTime));
  log(`${name} (${dataset.id}): ${experiments.length} experiment run(s) since ${fromStartTime.slice(0, 10)}`);
  const scoreName = `${q}-judge-output-correct`;
  for (const e of experiments) {
    log(`\n${e.name} · started ${e.startTime} · ${e.itemCount} items · ${e.id}`);
    const items: Array<{ input?: unknown; output?: unknown; expectedOutput?: unknown; traceId: string; scores?: Array<{ name: string; value: unknown }> }> = [];
    let itemCursor: string | undefined;
    do {
      const page = await api.experiments.listItems({ fromStartTime, experimentId: e.id, fields: "core,io,scores", limit: 100, ...(itemCursor ? { cursor: itemCursor } : {}) });
      items.push(...(page.data as typeof items));
      itemCursor = page.meta.cursor ?? undefined;
    } while (itemCursor);
    for (const i of items) {
      const company = String((parsed(i.input) as { company?: unknown } | null)?.company ?? "?");
      const actual = String((parsed(i.output) as { score?: unknown } | null)?.score ?? "?");
      const score = i.scores?.find((s) => s.name === scoreName);
      log(`  ${company} | expected ${String(parsed(i.expectedOutput))} | actual ${actual} | ${scoreName}=${score ? String(score.value) : "none"} | trace ${i.traceId}`);
    }
  }
  return experiments.length;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

function judgeArg(value: string | undefined, name: string): JudgeQuestion | undefined {
  if (value !== undefined && !JUDGE_QUESTIONS.includes(value as JudgeQuestion)) throw new Error(`${name} takes one of ${JUDGE_QUESTIONS.join(", ")}`);
  return value as JudgeQuestion | undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const client = await createLangfuseClient();
  const listJudge = judgeArg(flag(argv, "--list-runs"), "--list-runs");
  if (listJudge) {
    await listRuns(client.api, listJudge);
    return;
  }
  const judge = judgeArg(flag(argv, "--judge"), "--judge");
  const itemFilter = flag(argv, "--item");
  const questions = judge ? [judge] : JUDGE_QUESTIONS;
  if (argv.includes("--dry-run")) {
    if (argv.includes("--run")) throw new Error("--dry-run and --run are exclusive");
    await run(client, questions, { dryRun: true, itemFilter });
    return;
  }
  if (!argv.includes("--run")) {
    const { rows, total } = await estimate(client, questions, itemFilter);
    for (const r of rows) console.log(`${r.question}: ${r.items} items, prompt v${r.promptVersion}, ~${r.inputTokens} input tokens, ≤ $${r.dollars.toFixed(3)}; labels ${JSON.stringify(r.labels)}`);
    console.log(`total ≤ $${total.toFixed(2)} for one calibration round on ${JUDGE_MODEL.model} (${MAX_OUTPUT_TOKENS} output tokens budgeted per verdict). Nothing was run; pass --run --max-dollars <n> to run it.`);
    return;
  }
  const max = Number(flag(argv, "--max-dollars"));
  if (!Number.isFinite(max) || max <= 0) throw new Error("--run needs --max-dollars <n>");
  await run(client, questions, { maxDollars: max, dryRun: false, itemFilter });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
