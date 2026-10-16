/**
 * Calibrate the evidence-only judge (src/judges/evidence.ts) on any provider against the same three
 * human-labelled Langfuse datasets eval/online/calibrate-judge.ts uses (`judge-calibration/<judge>`), and print
 * the same accuracy line and mismatch table.
 *
 *   npx tsx eval/online/calibrate-evidence-judge.ts --model kimi                     # $0: fetch sets, print the estimate
 *   npx tsx eval/online/calibrate-evidence-judge.ts --model kimi --dry-run           # $0: fake model client, full parse/report path
 *   npx tsx eval/online/calibrate-evidence-judge.ts --model kimi --run --max-dollars 0.5 [--judge judge_q1] [--item <company>]
 *   npx tsx eval/online/calibrate-evidence-judge.ts --model sonnet --run --max-dollars 0.5
 *
 * --prompt repo (default) sends eval/online/judge-prompt.ts compiled with eval/RUBRIC.md, the text the
 * evidenceJudge function uses; --prompt langfuse sends the dataset's latest prompt version, as calibrate-judge
 * does. The script prints whether the two texts are identical, so a drift between repo and Langfuse is visible.
 *
 * Differences from calibrate-judge.ts (which the Jev work owns): results are NOT recorded as Langfuse
 * experiment runs; the report is written to eval/results/calibration/<date>/<judge>.evidence-<model>.json.
 * --run refuses to start when the provider's key is missing (KIMI_API_KEY / ANTHROPIC_API_KEY) or the
 * estimate exceeds --max-dollars. Exit code 1 when any item errored.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeCostDollars, providerOf, providers, type AgentModel } from "../../src/agent/config";
import { createModelClient, ProviderConfigError, type ModelClient } from "../../src/agent/providers";
import { evidenceJudgeQuestion, maxOutputTokens, resolveEvidenceModel, type EvidenceJudgeModel } from "../../src/judges/evidence";
import { calibrationDatasetName } from "./calibration-set";
import { compile, mismatchLines, selectItems, summaryLine, type ReportItem } from "./calibrate-judge";
import { compileJudgeMessages, judgeMessages, JUDGE_QUESTIONS, type JudgeQuestion } from "./judge-prompt";

type Message = { role: "system" | "user"; content: string };
type Item = { id: string; datasetId?: string; input: unknown; expectedOutput?: unknown };

/** What this runner needs from a LangfuseClient (a fake in tests). */
export type CalibrationSource = {
  dataset: { get(name: string): Promise<{ items: unknown[] }> };
  api: { prompts: { get(name: string, opts: { label: string; resolve: boolean }): Promise<unknown> } };
};

export function parseEvidenceModel(value: string | undefined): EvidenceJudgeModel {
  if (value === "sonnet" || value === "kimi" || value === "opus") return value;
  throw new Error(`--model takes sonnet, kimi or opus, got ${JSON.stringify(value)}`);
}

/** Same conservative input ratio as calibrate-judge.ts (2.2 chars/token + 500 per call); the whole output budget. */
export function estimateDollars(model: AgentModel, messages: Message[]): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / 2.2) + 500;
  return claudeCostDollars(model, { input_tokens: inputTokens, output_tokens: maxOutputTokens(model) });
}

/** A model client that answers every question with a `verdict` tool call (score "yes"), for --dry-run. */
export function fakeVerdictClient(score = "yes"): ModelClient {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "tool_use", id: "toolu_dry", name: "verdict", input: { reasoning: "dry-run", score } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    },
  } as unknown as ModelClient;
}

export function evidenceReportPath(judge: JudgeQuestion, model: AgentModel, createdAt: string, root = "eval/results"): string {
  return join(root, "calibration", createdAt.slice(0, 10), `${judge}.evidence-${model}.json`);
}

export type EvidenceCalibrationOptions = {
  model: EvidenceJudgeModel;
  questions?: JudgeQuestion[];
  itemFilter?: string;
  prompt?: "repo" | "langfuse";
  mode: "estimate" | "dry-run" | "run";
  maxDollars?: number;
  rubric?: string;
  /** Test seam / dry run: the model client. Default: createModelClient(model) (refuses without a key). */
  client?: ModelClient;
  env?: Record<string, string | undefined>;
  resultsRoot?: string;
  log?: (line: string) => void;
};

export type EvidenceCalibrationResult = {
  model: AgentModel;
  estimate: number;
  spent: number;
  errors: number;
  reports: Array<{ judge: JudgeQuestion; correct: number; total: number; errors: number; promptSource: "repo" | "langfuse"; promptMatchesLangfuse: boolean; items: ReportItem[]; path?: string }>;
};

export async function runEvidenceCalibration(source: CalibrationSource, opts: EvidenceCalibrationOptions): Promise<EvidenceCalibrationResult> {
  const log = opts.log ?? console.log;
  const model = resolveEvidenceModel(opts.model);
  const env = opts.env ?? process.env;
  const keyEnv = providers[providerOf(model)].apiKeyEnv;
  // Refuse before any Langfuse or model call: a paid round without the provider key must not start.
  if (opts.mode === "run" && !opts.client && !env[keyEnv]) throw new ProviderConfigError(`${keyEnv} is not set: --run refused, nothing was called`);
  const rubric = opts.rubric ?? readFileSync("eval/RUBRIC.md", "utf8");
  const promptSource = opts.prompt ?? "repo";
  const questions = opts.questions ?? JUDGE_QUESTIONS;

  const sets: Array<{ q: JudgeQuestion; items: Item[]; promptVersion: number; langfuseMessages: Message[]; matches: boolean }> = [];
  let estimate = 0;
  for (const q of questions) {
    const name = calibrationDatasetName(q);
    const dataset = await source.dataset.get(name);
    const prompt = (await source.api.prompts.get(name, { label: "latest", resolve: false })) as { version: number; prompt: Message[] };
    const items = selectItems(dataset.items as Item[], opts.itemFilter);
    if (items.length === 0) throw new Error(`--item ${JSON.stringify(opts.itemFilter)} matches no company in ${name}`);
    const langfuseMessages = prompt.prompt.map((m) => ({ role: m.role, content: m.content }));
    const repo = judgeMessages(q, rubric);
    const matches = JSON.stringify(repo) === JSON.stringify(langfuseMessages);
    for (const item of items) {
      const messages = promptSource === "repo" ? compileJudgeMessages(q, rubric, item.input) : compile(langfuseMessages, item.input);
      estimate += estimateDollars(model, messages);
    }
    sets.push({ q, items, promptVersion: prompt.version, langfuseMessages, matches });
    log(`${q}: ${items.length} items · Langfuse prompt v${prompt.version} ${matches ? "identical to" : "DIFFERS from"} the repo prompt (eval/online/judge-prompt.ts + RUBRIC.md); using ${promptSource}`);
  }
  log(`estimate ≤ $${estimate.toFixed(3)} on ${model} (${maxOutputTokens(model)} output tokens budgeted per verdict)`);
  const result: EvidenceCalibrationResult = { model, estimate, spent: 0, errors: 0, reports: [] };
  if (opts.mode === "estimate") {
    log("Nothing was run; pass --run --max-dollars <n> (or --dry-run).");
    return result;
  }
  if (opts.mode === "run" && estimate > (opts.maxDollars ?? 0)) throw new Error(`estimated $${estimate.toFixed(2)} > --max-dollars ${opts.maxDollars}; nothing was run`);
  const client = opts.client ?? (opts.mode === "dry-run" ? fakeVerdictClient() : createModelClient(model, { env }));

  for (const set of sets) {
    const createdAt = new Date().toISOString();
    const items: ReportItem[] = [];
    let errors = 0;
    for (const item of set.items) {
      const input = (item.input ?? {}) as { company?: unknown; signal_url?: unknown };
      const base = { datasetItemId: item.id, company: String(input.company ?? ""), signal_url: String(input.signal_url ?? ""), expected: String(item.expectedOutput), traceId: null };
      const messages = promptSource === "repo" ? compileJudgeMessages(set.q, rubric, item.input) : compile(set.langfuseMessages, item.input);
      try {
        const answer = await evidenceJudgeQuestion(client, model, set.q, messages);
        result.spent += answer.costDollars;
        items.push({ ...base, actual: answer.score, correct: answer.score === base.expected, reasoning: answer.reasoning, costDollars: answer.costDollars });
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        log(`item ${item.id} failed: ${message}`);
        items.push({ ...base, actual: "error", correct: false, reasoning: "", costDollars: 0, error: message });
      }
    }
    result.errors += errors;
    const correct = items.filter((i) => i.correct).length;
    log(`\n${summaryLine(set.q, correct, items.length, errors)} (${((correct / Math.max(1, items.length)) * 100).toFixed(0)}%; ${model}, evidence-only, prompt ${promptSource})`);
    for (const line of mismatchLines(items)) log(line);
    const report = { judge: set.q, model, promptSource, langfusePromptVersion: set.promptVersion, promptMatchesLangfuse: set.matches, itemFilter: opts.itemFilter ?? null, createdAt, correct, total: items.length, errors, spentDollars: items.reduce((n, i) => n + i.costDollars, 0), items };
    let path: string | undefined;
    if (opts.mode === "run") {
      path = evidenceReportPath(set.q, model, createdAt, opts.resultsRoot);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      log(`report: ${path}`);
    } else {
      log(`(dry run: report not written; it would go to ${evidenceReportPath(set.q, model, createdAt, opts.resultsRoot)})`);
    }
    result.reports.push({ judge: set.q, correct, total: items.length, errors, promptSource, promptMatchesLangfuse: set.matches, items, path });
  }
  log(`\nspent $${result.spent.toFixed(4)} (estimated ≤ $${estimate.toFixed(3)})`);
  return result;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const model = parseEvidenceModel(flag(argv, "--model"));
  const judge = flag(argv, "--judge");
  if (judge !== undefined && !JUDGE_QUESTIONS.includes(judge as JudgeQuestion)) throw new Error(`--judge takes one of ${JUDGE_QUESTIONS.join(", ")}`);
  const prompt = flag(argv, "--prompt") ?? "repo";
  if (prompt !== "repo" && prompt !== "langfuse") throw new Error("--prompt takes repo or langfuse");
  const dryRun = argv.includes("--dry-run");
  const run = argv.includes("--run");
  if (dryRun && run) throw new Error("--dry-run and --run are exclusive");
  const maxDollars = run ? Number(flag(argv, "--max-dollars")) : undefined;
  if (run && (!Number.isFinite(maxDollars) || maxDollars! <= 0)) throw new Error("--run needs --max-dollars <n>");
  const resolved = resolveEvidenceModel(model);
  const keyEnv = providers[providerOf(resolved)].apiKeyEnv;
  if (run && !process.env[keyEnv]) throw new ProviderConfigError(`${keyEnv} is not set: --run refused, nothing was called`);
  const { createLangfuseClient } = await import("../langfuse/client");
  const client = await createLangfuseClient();
  const result = await runEvidenceCalibration(client as unknown as CalibrationSource, {
    model,
    questions: judge ? [judge as JudgeQuestion] : undefined,
    itemFilter: flag(argv, "--item"),
    prompt,
    mode: run ? "run" : dryRun ? "dry-run" : "estimate",
    maxDollars,
  });
  if (result.errors > 0) {
    console.error(`${result.errors} item errors; results above are incomplete`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
