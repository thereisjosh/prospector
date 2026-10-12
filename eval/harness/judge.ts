import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { eventInWindow, truthKey } from "./truth";
import type { BlindLead } from "./blind";
import { claudeCostDollars } from "../../src/agent/config";
import type { RubricAnswer, Verdict } from "./types";

type JudgeClient = Pick<Anthropic, "messages">;

type JudgeJson = {
  q1: RubricAnswer;
  q1_source: string;
  q2: RubricAnswer;
  q2_source: string;
  q3: RubricAnswer;
  q3_source: string;
  note?: string;
};

const ANSWERS = new Set(["yes", "no", "cannot_verify"]);

function truthPath(scenarioId: string, company: string, signalUrl: string, truthRoot = "eval/truth"): string {
  return join(truthRoot, scenarioId, `${truthKey(company, signalUrl)}.json`);
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * All text of a response, in order. A web_search response interleaves several
 * text blocks (commentary, then the answer) with server_tool_use and
 * web_search_tool_result blocks; only the text blocks are read.
 */
export function allText(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Every top-level balanced {...} object in `text`, in order (string- and escape-aware). */
export function balancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"" && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

export function firstBalancedJson(text: string): string | undefined {
  return balancedJsonObjects(text)[0];
}

/** The LAST balanced JSON object that carries valid q1/q2/q3 answers. */
export function parseJudgeJson(text: string): JudgeJson | undefined {
  const candidates = balancedJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let parsed: Partial<JudgeJson>;
    try {
      parsed = JSON.parse(candidates[i]!) as Partial<JudgeJson>;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (!ANSWERS.has(parsed.q1 ?? "") || !ANSWERS.has(parsed.q2 ?? "") || !ANSWERS.has(parsed.q3 ?? "")) continue;
    return {
      q1: parsed.q1!,
      q1_source: String(parsed.q1_source ?? ""),
      q2: parsed.q2!,
      q2_source: String(parsed.q2_source ?? ""),
      q3: parsed.q3!,
      q3_source: String(parsed.q3_source ?? ""),
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  }
  return undefined;
}

type JudgeUsage = { input: number; output: number; cache_read: number; cache_creation: number };

/** Token usage, dollar cost (Opus price table) and web-search count of one response. */
export function responseCost(response: unknown): { usage: JudgeUsage; costDollars: number; webSearches: number } {
  const u = (response as { usage?: Record<string, number | null | undefined> }).usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_creation: u.cache_creation_input_tokens ?? 0,
  };
  const content = (response as { content?: unknown }).content;
  const webSearches = Array.isArray(content)
    ? content.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "web_search_tool_result").length
    : 0;
  return { usage, costDollars: claudeCostDollars("claude-opus-5-5", u), webSearches };
}

type Spent = ReturnType<typeof responseCost>;

function addSpent(a: Spent | undefined, b: Spent): Spent {
  if (!a) return b;
  return {
    usage: {
      input: a.usage.input + b.usage.input,
      output: a.usage.output + b.usage.output,
      cache_read: a.usage.cache_read + b.usage.cache_read,
      cache_creation: a.usage.cache_creation + b.usage.cache_creation,
    },
    costDollars: a.costDollars + b.costDollars,
    webSearches: a.webSearches + b.webSearches,
  };
}

function fallback(lead: BlindLead, scenarioId: string, spent?: Spent): Verdict {
  return {
    ...(spent ?? {}),
    company: lead.company,
    scenarioId,
    q1: "cannot_verify",
    q1_source: "",
    q2: "cannot_verify",
    q2_source: "",
    q3: "cannot_verify",
    q3_source: "",
    good: false,
    judgedAt: new Date().toISOString(),
    judge: "opus",
  };
}

function toVerdict(lead: BlindLead, scenarioId: string, parsed: JudgeJson, now: Date, spent?: Spent): Verdict {
  return {
    ...(spent ?? {}),
    company: lead.company,
    signal_url: lead.signal_url,
    event_date: lead.event_date,
    now: now.toISOString().slice(0, 10),
    scenarioId,
    q1: parsed.q1,
    q1_source: parsed.q1_source,
    q2: parsed.q2,
    q2_source: parsed.q2_source,
    q3: parsed.q3,
    q3_source: parsed.q3_source,
    good: parsed.q1 === "yes" && parsed.q3 === "yes" && parsed.q2 !== "no",
    judgedAt: new Date().toISOString(),
    judge: "opus",
  };
}

const JUDGE_INSTRUCTION =
  'Use web_search as needed (max 4), then reply with exactly one JSON object and nothing after it: {"q1":..., "q1_source":..., "q2":..., "q2_source":..., "q3":..., "q3_source":..., "note": "..."}';

export function userPrompt(lead: BlindLead): string {
  return `${JSON.stringify({
    company: lead.company,
    signal_url: lead.signal_url,
    why_now: lead.why_now,
    contract_summary: {
      event_date: lead.event_date,
      size_basis: lead.size_basis,
    },
  }, null, 2)}\n\n${JUDGE_INSTRUCTION}`;
}

/** Keep the raw reply when parsing fails, and say so on stderr: a judge failure is never silent. */
async function recordFailure(options: { resultsRoot?: string; setId?: string; scenarioId: string; lead: BlindLead }, text: string, stopReason: unknown) {
  const file = join(options.resultsRoot ?? "eval/results", options.setId ?? "adhoc", options.scenarioId, "judge-failures", `${truthKey(options.lead.company, options.lead.signal_url)}.txt`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `stop_reason: ${String(stopReason)}\n\n${text}\n`, "utf8");
  console.error(`judge: could not parse a verdict for ${options.lead.company} (stop_reason ${String(stopReason)}); raw reply saved to ${file}`);
}

export async function judgeLead(options: {
  scenarioId: string;
  lead: BlindLead;
  client?: JudgeClient;
  rubricText?: string;
  truthRoot?: string;
  force?: boolean;
  /** The set's "now" and the scenario's window; a cached verdict is reused only while the window still contains the event date. */
  now?: Date;
  months?: number;
  /** Where judge-failures/ is written. */
  setId?: string;
  resultsRoot?: string;
}): Promise<Verdict> {
  const file = truthPath(options.scenarioId, options.lead.company, options.lead.signal_url, options.truthRoot);
  const now = options.now ?? new Date();
  if (!options.force && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, "utf8")) as Verdict;
    const windowKnown = options.now !== undefined && options.months !== undefined;
    if (!windowKnown || eventInWindow(options.lead.event_date, options.now!, options.months!)) return cached;
  }

  const client = options.client ?? new Anthropic();
  const rubric = options.rubricText ?? readFileSync("eval/RUBRIC.md", "utf8");
  let spent: Spent | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: rubric,
      messages: [{ role: "user", content: userPrompt(options.lead) }],
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
    } as never);
    spent = addSpent(spent, responseCost(response));
    const text = allText(response);
    const parsed = parseJudgeJson(text);
    if (parsed) {
      const verdict = toVerdict(options.lead, options.scenarioId, parsed, now, spent);
      await writeJson(file, verdict);
      return verdict;
    }
    if (attempt === 1) await recordFailure(options, text, (response as { stop_reason?: unknown }).stop_reason);
  }
  // The all-cannot_verify fallback is returned but never cached: a transient judge failure must not become truth.
  return fallback(options.lead, options.scenarioId, spent);
}

export async function judgeBlind(options: {
  setId: string;
  scenarioId: string;
  resultsRoot?: string;
  truthRoot?: string;
  client?: JudgeClient;
  force?: boolean;
  now?: Date;
  months?: number;
  /** Judge only the first N blind leads. */
  limit?: number;
}): Promise<Verdict[]> {
  const root = options.resultsRoot ?? "eval/results";
  const blindFile = join(root, options.setId, options.scenarioId, "blind.json");
  let leads = JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[];
  if (options.limit !== undefined) leads = leads.slice(0, options.limit);
  const verdicts: Verdict[] = [];
  const perLead: Array<{ company: string; signal_url: string; costDollars: number; webSearches: number; usage?: Verdict["usage"]; error?: string }> = [];
  let total = 0;
  const writeCost = () => writeJson(join(root, options.setId, options.scenarioId, "judge-cost.json"), { totalDollars: total, leads: perLead.length, perLead });
  for (const lead of leads) {
    try {
      const verdict = await judgeLead({
        scenarioId: options.scenarioId, lead, client: options.client, truthRoot: options.truthRoot,
        force: options.force, now: options.now, months: options.months, setId: options.setId, resultsRoot: root,
      });
      verdicts.push(verdict);
      const cost = verdict.costDollars ?? 0;
      total += cost;
      perLead.push({ company: lead.company, signal_url: lead.signal_url, costDollars: cost, webSearches: verdict.webSearches ?? 0, usage: verdict.usage });
      console.log(`judge: ${lead.company} q1=${verdict.q1} q2=${verdict.q2} q3=${verdict.q3} $${cost.toFixed(4)} (running total $${total.toFixed(4)})`);
    } catch (error) {
      // An API error on one lead must not abort the scenario.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`judge: API error on ${lead.company}: ${message}`);
      perLead.push({ company: lead.company, signal_url: lead.signal_url, costDollars: 0, webSearches: 0, error: message });
    }
    await writeCost();
  }
  return verdicts;
}

export async function writeHumanVerdict(options: {
  scenarioId: string;
  company: string;
  signalUrl: string;
  q1: RubricAnswer;
  q1_source: string;
  q2: RubricAnswer;
  q2_source: string;
  q3: RubricAnswer;
  q3_source: string;
  truthRoot?: string;
}): Promise<Verdict> {
  const verdict: Verdict = {
    company: options.company,
    signal_url: options.signalUrl,
    scenarioId: options.scenarioId,
    q1: options.q1,
    q1_source: options.q1_source,
    q2: options.q2,
    q2_source: options.q2_source,
    q3: options.q3,
    q3_source: options.q3_source,
    good: options.q1 === "yes" && options.q3 === "yes" && options.q2 !== "no",
    judgedAt: new Date().toISOString(),
    judge: "human",
  };
  await writeJson(truthPath(options.scenarioId, options.company, options.signalUrl, options.truthRoot), verdict);
  return verdict;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "force" || key === "human" || key === "dry-run") out[key] = true;
    else out[key] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.human) {
    const required = ["scenario", "company", "signal-url", "q1", "q1-source", "q2", "q2-source", "q3", "q3-source"];
    for (const key of required) if (!args[key]) throw new Error(`--human requires --${key}`);
    await writeHumanVerdict({
      scenarioId: String(args.scenario),
      company: String(args.company),
      signalUrl: String(args["signal-url"]),
      q1: args.q1 as RubricAnswer,
      q1_source: String(args["q1-source"]),
      q2: args.q2 as RubricAnswer,
      q2_source: String(args["q2-source"]),
      q3: args.q3 as RubricAnswer,
      q3_source: String(args["q3-source"]),
    });
    console.log(`human verdict wrote ${args.company}`);
    return;
  }
  if (!args.set || !args.scenario) throw new Error("pass --set <id> --scenario <id>");
  if (args["dry-run"]) {
    const blindFile = join("eval/results", String(args.set), String(args.scenario), "blind.json");
    const first = (JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[])[0];
    if (!first) throw new Error("blind pool is empty");
    console.log(`--- system (rubric) ---\n${readFileSync("eval/RUBRIC.md", "utf8")}\n--- user ---\n${userPrompt(first)}`);
    return;
  }
  const verdicts = await judgeBlind({
    limit: args.limit ? Number(args.limit) : undefined,
    setId: String(args.set),
    scenarioId: String(args.scenario),
    force: !!args.force,
    now: args.now ? new Date(String(args.now)) : undefined,
    months: args.months ? Number(args.months) : undefined,
  });
  console.log(`judged ${verdicts.length} leads for ${args.scenario}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
