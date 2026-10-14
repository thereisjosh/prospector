/**
 * Calibrate the online lead judges against the human-labelled set
 * (.agents/skills/langfuse/references/judge-calibration.md §2–§3).
 *
 *   npx tsx eval/online/calibrate-judge.ts                 # $0: fetch sets + prompts, print the cost estimate
 *   npx tsx eval/online/calibrate-judge.ts --run --max-dollars 1 [--judge judge_q1]
 *
 * --run is PAID (Anthropic, same model as the evaluator). For each judge it fetches the dataset
 * `judge-calibration/<judge>` and the candidate prompt `judge-calibration/<judge>` (latest
 * version) from Langfuse, runs that prompt on every item with the Experiments SDK
 * (`dataset.runExperiment`), and scores each result with the Boolean evaluator
 * `<judge>-judge-output-correct` (output === expected output). It then prints accuracy and
 * every mismatch (input, expected, actual). It refuses to start if the estimate exceeds
 * --max-dollars.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import type { LangfuseClient } from "@langfuse/client";
import { CLAUDE_PRICES_PER_MILLION, claudeCostDollars } from "../../src/agent/config";
import { createLangfuseClient, projectId, uiLink } from "../langfuse/client";
import { calibrationDatasetName } from "./calibration-set";
import { JUDGE_CATEGORIES, JUDGE_MODEL, JUDGE_QUESTIONS, LEAD_VARIABLE, judgeOutputDefinition, type JudgeAnswer, type JudgeQuestion } from "./judge-prompt";

/** Output budget per verdict (reasoning + label). */
export const MAX_OUTPUT_TOKENS = 600;
/** Conservative characters-per-token for English + JSON (no tokenizer call: that would be an Anthropic request). */
export const CHARS_PER_TOKEN = 3.2;

type Message = { role: "system" | "user"; content: string };

export function compile(messages: Message[], lead: unknown): Message[] {
  const json = JSON.stringify(lead, null, 2);
  return messages.map((m) => ({ ...m, content: m.content.split(`{{${LEAD_VARIABLE}}}`).join(json) }));
}

/** Upper-bound cost of one verdict: estimated input tokens + the whole output budget. */
export function estimateCallDollars(messages: Message[], model = JUDGE_MODEL.model): { inputTokens: number; dollars: number } {
  const chars = messages.reduce((n, m) => n + m.content.length, 0) + 400; // + the structured-output tool schema
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
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

type FetchedItem = { id: string; input: unknown; expectedOutput?: unknown; metadata?: unknown };

async function fetchSet(client: LangfuseClient, question: JudgeQuestion): Promise<{ items: FetchedItem[]; messages: Message[]; promptVersion: number }> {
  const name = calibrationDatasetName(question);
  const dataset = await client.dataset.get(name);
  const prompt = (await client.api.prompts.get(name, { label: "latest", resolve: false })) as unknown as { version: number; prompt: Message[] };
  return { items: dataset.items as unknown as FetchedItem[], messages: prompt.prompt.map((m) => ({ role: m.role, content: m.content })), promptVersion: prompt.version };
}

export async function estimate(client: LangfuseClient, questions: JudgeQuestion[]) {
  const rows: Array<{ question: JudgeQuestion; items: number; promptVersion: number; inputTokens: number; dollars: number; labels: Record<string, number> }> = [];
  for (const q of questions) {
    const { items, messages, promptVersion } = await fetchSet(client, q);
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

async function run(client: LangfuseClient, questions: JudgeQuestion[], maxDollars: number) {
  const { rows, total } = await estimate(client, questions);
  if (total > maxDollars) throw new Error(`estimated $${total.toFixed(2)} > --max-dollars ${maxDollars}; nothing was run`);
  process.env.LANGFUSE_TRACING_ENVIRONMENT ||= "eval";
  const [{ default: AnthropicSdk }, tracing, otel, base] = await Promise.all([
    import("@anthropic-ai/sdk"),
    import("@langfuse/tracing"),
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-base"),
  ]);
  const processor = new otel.LangfuseSpanProcessor({ additionalHeaders: { "x-langfuse-ingestion-version": "4" } });
  const provider = new base.BasicTracerProvider({ spanProcessors: [processor] });
  tracing.setLangfuseTracerProvider(provider);
  const anthropic = new AnthropicSdk();
  const project = await projectId(client);
  let spent = 0;
  let errorCount = 0;
  for (const q of questions) {
    const { messages, promptVersion } = await fetchSet(client, q);
    const dataset = await client.dataset.get(calibrationDatasetName(q));
    const errors: Array<{ id: string; message: string }> = [];
    const result = await dataset.runExperiment({
      name: `judge-calibration/${q}`,
      runName: `${q} prompt v${promptVersion} · ${new Date().toISOString().slice(0, 16)}`,
      description: `Calibration of the online ${q} evaluator (prompt judge-calibration/${q} v${promptVersion}, ${JUDGE_MODEL.model})`,
      metadata: { judge: q, promptVersion, model: JUDGE_MODEL.model },
      task: trackErrors(async (item: { id?: string; input: unknown }) => {
        const out = await judgeOnce(anthropic, q, compile(messages, item.input));
        spent += out.costDollars;
        return out;
      }, errors),
      evaluators: [outputCorrect(q)],
    } as never);
    const items = (result as unknown as { itemResults: Array<{ item: FetchedItem; output: { score: string; reasoning: string } }> }).itemResults;
    const wrong = items.filter((r) => r.output?.score !== r.item.expectedOutput);
    errorCount += errors.length;
    const total = dataset.items.length;
    console.log(`\n${summaryLine(q, items.length - wrong.length, total, errors.length)} (${(((items.length - wrong.length) / Math.max(1, total)) * 100).toFixed(0)}%; the reference treats 85% as good only if every category is acceptable)`);
    console.log("| Dataset input | Expected output | Actual output |\n|---|---|---|");
    for (const r of wrong) {
      const input = r.item.input as { company?: string; signal_url?: string };
      console.log(`| ${input.company} · ${input.signal_url} | ${String(r.item.expectedOutput)} | ${r.output?.score} — ${String(r.output?.reasoning ?? "").replace(/\s+/g, " ").slice(0, 200)} |`);
    }
  }
  await client.flush();
  await provider.forceFlush();
  await provider.shutdown();
  console.log(`\nspent $${spent.toFixed(4)} (estimated ≤ $${total.toFixed(2)}); results: ${uiLink(project, "datasets")}`);
  if (errorCount > 0) {
    console.error(`${errorCount} task errors; results above are incomplete`);
    process.exitCode = 1;
  }
  return { rows, spent, errorCount };
}

async function main() {
  const argv = process.argv.slice(2);
  const judge = argv.includes("--judge") ? (argv[argv.indexOf("--judge") + 1] as JudgeQuestion) : undefined;
  if (judge && !JUDGE_QUESTIONS.includes(judge)) throw new Error(`--judge takes one of ${JUDGE_QUESTIONS.join(", ")}`);
  const questions = judge ? [judge] : JUDGE_QUESTIONS;
  const client = await createLangfuseClient();
  if (!argv.includes("--run")) {
    const { rows, total } = await estimate(client, questions);
    for (const r of rows) console.log(`${r.question}: ${r.items} items, prompt v${r.promptVersion}, ~${r.inputTokens} input tokens, ≤ $${r.dollars.toFixed(3)}; labels ${JSON.stringify(r.labels)}`);
    console.log(`total ≤ $${total.toFixed(2)} for one calibration round on ${JUDGE_MODEL.model} (${MAX_OUTPUT_TOKENS} output tokens budgeted per verdict). Nothing was run; pass --run --max-dollars <n> to run it.`);
    return;
  }
  const max = Number(argv[argv.indexOf("--max-dollars") + 1]);
  if (!argv.includes("--max-dollars") || !Number.isFinite(max) || max <= 0) throw new Error("--run needs --max-dollars <n>");
  await run(client, questions, max);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
