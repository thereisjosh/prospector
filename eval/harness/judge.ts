import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { squashName } from "../../src/gates";
import type { BlindLead } from "./blind";
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

function truthPath(scenarioId: string, company: string, truthRoot = "eval/truth"): string {
  return join(truthRoot, scenarioId, `${squashName(company)}.json`);
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function firstTextBlock(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function firstBalancedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseJudgeJson(text: string): JudgeJson | undefined {
  const balanced = firstBalancedJson(text);
  if (!balanced) return undefined;
  const parsed = JSON.parse(balanced) as Partial<JudgeJson>;
  if (!ANSWERS.has(parsed.q1 ?? "") || !ANSWERS.has(parsed.q2 ?? "") || !ANSWERS.has(parsed.q3 ?? "")) return undefined;
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

function fallback(lead: BlindLead, scenarioId: string): Verdict {
  return {
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

function toVerdict(lead: BlindLead, scenarioId: string, parsed: JudgeJson): Verdict {
  return {
    company: lead.company,
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

function userPrompt(lead: BlindLead): string {
  return JSON.stringify({
    company: lead.company,
    signal_url: lead.signal_url,
    why_now: lead.why_now,
    contract_summary: {
      event_date: lead.event_date,
      size_basis: lead.size_basis,
    },
  }, null, 2);
}

export async function judgeLead(options: {
  scenarioId: string;
  lead: BlindLead;
  client?: JudgeClient;
  rubricText?: string;
  truthRoot?: string;
  force?: boolean;
}): Promise<Verdict> {
  const file = truthPath(options.scenarioId, options.lead.company, options.truthRoot);
  if (!options.force && existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as Verdict;

  const client = options.client ?? new Anthropic();
  const rubric = options.rubricText ?? readFileSync("eval/RUBRIC.md", "utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1600,
      system: rubric,
      messages: [{ role: "user", content: userPrompt(options.lead) }],
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
    } as never);
    const parsed = parseJudgeJson(firstTextBlock(response));
    if (parsed) {
      const verdict = toVerdict(options.lead, options.scenarioId, parsed);
      await writeJson(file, verdict);
      return verdict;
    }
  }
  const verdict = fallback(options.lead, options.scenarioId);
  await writeJson(file, verdict);
  return verdict;
}

export async function judgeBlind(options: {
  setId: string;
  scenarioId: string;
  resultsRoot?: string;
  truthRoot?: string;
  client?: JudgeClient;
  force?: boolean;
}): Promise<Verdict[]> {
  const blindFile = join(options.resultsRoot ?? "eval/results", options.setId, options.scenarioId, "blind.json");
  const leads = JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[];
  const verdicts: Verdict[] = [];
  for (const lead of leads) {
    verdicts.push(await judgeLead({ scenarioId: options.scenarioId, lead, client: options.client, truthRoot: options.truthRoot, force: options.force }));
  }
  return verdicts;
}

export async function writeHumanVerdict(options: {
  scenarioId: string;
  company: string;
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
  await writeJson(truthPath(options.scenarioId, options.company, options.truthRoot), verdict);
  return verdict;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "force" || key === "human") out[key] = true;
    else out[key] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.human) {
    const required = ["scenario", "company", "q1", "q1-source", "q2", "q2-source", "q3", "q3-source"];
    for (const key of required) if (!args[key]) throw new Error(`--human requires --${key}`);
    await writeHumanVerdict({
      scenarioId: String(args.scenario),
      company: String(args.company),
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
  const verdicts = await judgeBlind({ setId: String(args.set), scenarioId: String(args.scenario), force: !!args.force });
  console.log(`judged ${verdicts.length} leads for ${args.scenario}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
