import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { eventInWindow, findVerdictFile, truthKey } from "./truth";
import type { BlindLead } from "./blind";
import { claudeCostDollars } from "../../src/agent/config";
import { judgePayload } from "../../src/agent/judge-input";
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

/** The existing verdict file (even under an older squash of the name), else the current key's path. */
function truthPath(scenarioId: string, company: string, signalUrl: string, truthRoot = "eval/truth"): string {
  const dir = join(truthRoot, scenarioId);
  return findVerdictFile(dir, company, signalUrl) ?? join(dir, `${truthKey(company, signalUrl)}.json`);
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

/** "Cannot verify", "cannot-verify", "unverifiable", "unknown" -> cannot_verify; yes/no case-insensitive. */
export function normalizeAnswer(value: unknown): RubricAnswer | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "yes" || v === "no" || v === "cannot_verify") return v;
  if (["unverifiable", "unverified", "unknown", "cant_verify", "can't_verify", "cannot_be_verified"].includes(v)) return "cannot_verify";
  return undefined;
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
    const q1 = normalizeAnswer(parsed.q1);
    const q2 = normalizeAnswer(parsed.q2);
    const q3 = normalizeAnswer(parsed.q3);
    if (!q1 || !q2 || !q3) continue;
    return {
      q1,
      q1_source: String(parsed.q1_source ?? ""),
      q2,
      q2_source: String(parsed.q2_source ?? ""),
      q3,
      q3_source: String(parsed.q3_source ?? ""),
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  }
  return undefined;
}

type JudgeUsage = { input: number; output: number; cache_read: number; cache_creation: number };

/** Does this web_fetch_tool_result carry an error (content is an error object, not a document)? */
function fetchErrorCode(block: unknown): string | undefined {
  const content = (block as { content?: unknown }).content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const c = content as { type?: unknown; error_code?: unknown };
  if (typeof c.error_code === "string") return c.error_code;
  return c.type === "web_fetch_tool_error" ? "unknown_error" : undefined;
}

/** Token usage, dollar cost (Opus prices), web-search and web-fetch counts of one response. */
export function responseCost(response: unknown): { usage: JudgeUsage; costDollars: number; webSearches: number; webFetches: number; fetchErrors: string[] } {
  const u = (response as { usage?: Record<string, number | null | undefined> }).usage ?? {};
  const usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_creation: u.cache_creation_input_tokens ?? 0,
  };
  const content = (response as { content?: unknown }).content;
  const blocks = Array.isArray(content) ? content.filter((b) => b && typeof b === "object") : [];
  const ofType = (type: string) => blocks.filter((b) => (b as { type?: unknown }).type === type);
  const fetches = ofType("web_fetch_tool_result");
  return {
    usage,
    costDollars: claudeCostDollars("claude-opus-5-5", u),
    webSearches: ofType("web_search_tool_result").length,
    webFetches: fetches.length,
    fetchErrors: fetches.map(fetchErrorCode).filter((c): c is string => c !== undefined),
  };
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
    webFetches: a.webFetches + b.webFetches,
    fetchErrors: [...a.fetchErrors, ...b.fetchErrors],
  };
}

/** Cost and tool-use fields recorded on every verdict. */
function spentFields(spent?: Spent): Partial<Verdict> {
  if (!spent) return { judgeVersion: JUDGE_VERSION };
  return {
    usage: spent.usage,
    costDollars: spent.costDollars,
    webSearches: spent.webSearches,
    webFetches: spent.webFetches,
    tools: { webSearches: spent.webSearches, webFetches: spent.webFetches },
    judgeVersion: JUDGE_VERSION,
  };
}

/**
 * How Q3 was verified. "fetched": the judge opened the signal page. "corroborated": the page
 * was blocked/not opened but another site's search result describes the same event (the
 * judge says "via corroborating source" in its note). "none": neither. A "yes" with no
 * basis cannot stand: Q3 becomes cannot_verify and the fetch error is noted.
 */
export function settleQ3(parsed: JudgeJson, one: Pick<Spent, "webFetches" | "fetchErrors">): "fetched" | "corroborated" | "none" {
  const fetched = one.webFetches - one.fetchErrors.length > 0;
  if (fetched) return "fetched";
  if (/via corroborating source/i.test(parsed.note ?? "")) return "corroborated";
  if (parsed.q3 === "yes") {
    parsed.q3 = "cannot_verify";
    const why = one.fetchErrors.length > 0 ? `web_fetch failed (${one.fetchErrors.join(", ")})` : "signal page not fetched";
    parsed.q3_source = `${why}; no corroborating source. ${parsed.q3_source}`.trim();
  }
  return "none";
}

function fallback(lead: BlindLead, scenarioId: string, spent?: Spent): Verdict {
  return {
    ...spentFields(spent),
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

const NOTE_MAX = 1500;

function cleanNote(note: unknown): { note: string } | Record<string, never> {
  const trimmed = typeof note === "string" ? note.trim().slice(0, NOTE_MAX).trim() : "";
  return trimmed ? { note: trimmed } : {};
}

function toVerdict(lead: BlindLead, scenarioId: string, parsed: JudgeJson, now: Date, spent?: Spent): Verdict {
  return {
    ...spentFields(spent),
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
    ...cleanNote(parsed.note),
    good: parsed.q1 === "yes" && parsed.q3 === "yes" && parsed.q2 !== "no",
    judgedAt: new Date().toISOString(),
    judge: "opus",
  };
}

/** Cuts cost; the rubric allows "cannot_verify". The API can still return more, which is logged. */
const MAX_SEARCHES = 3;
const MAX_FETCHES = 2;

/** v3: the judge can open the signal URL (web_fetch), so Q3 no longer defaults to cannot_verify. */
export const JUDGE_VERSION = "v3-fetch";

const JUDGE_INSTRUCTION =
  'First fetch the signal_url with web_fetch to answer Q3; use web_search (max 3) for Q1/Q2 (company site, LinkedIn). If web_fetch of the signal_url fails or is blocked, Q3 may still be \'yes\' when a web_search result from a different site describes the same company and the same event with a date inside the window; cite that result as q3_source and say \'via corroborating source\' in the note. If no corroboration exists, answer cannot_verify. Then reply with exactly one JSON object and nothing after it: {"q1":..., "q1_source":..., "q2":..., "q2_source":..., "q3":..., "q3_source":..., "note": "..."}';

/** The lead JSON (src/agent/judge-input.ts, shared with the online evaluators) plus the tool instruction. */
export function userPrompt(lead: BlindLead): string {
  return `${JSON.stringify(judgePayload(lead), null, 2)}\n\n${JUDGE_INSTRUCTION}`;
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
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES, max_content_tokens: 6000 },
      ],
    } as never);
    const one = responseCost(response);
    if (one.webSearches > MAX_SEARCHES) {
      console.error(`judge: ${options.lead.company}: API returned ${one.webSearches} web searches for max_uses ${MAX_SEARCHES}`);
    }
    spent = addSpent(spent, one);
    const text = allText(response);
    const parsed = parseJudgeJson(text);
    if (parsed) {
      const q3Basis = settleQ3(parsed, one);
      const verdict = { ...toVerdict(options.lead, options.scenarioId, parsed, now, spent), q3_basis: q3Basis };
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
  const perLead: Array<{ company: string; signal_url: string; costDollars: number; webSearches: number; webFetches?: number; usage?: Verdict["usage"]; error?: string }> = [];
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
      perLead.push({ company: lead.company, signal_url: lead.signal_url, costDollars: cost, webSearches: verdict.webSearches ?? 0, webFetches: verdict.webFetches ?? 0, usage: verdict.usage });
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

function parseFields(value: string): Array<"q1" | "q2" | "q3"> {
  const fields = value.split(",").map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0 || !fields.every((f): f is "q1" | "q2" | "q3" => f === "q1" || f === "q2" || f === "q3")) {
    throw new Error("--fields takes a comma list of q1,q2,q3");
  }
  return fields;
}

const hasCannotVerify = (v: Pick<Verdict, "q1" | "q2" | "q3">) => v.q1 === "cannot_verify" || v.q2 === "cannot_verify" || v.q3 === "cannot_verify";

/**
 * Re-judge (force) only the truth files where any answer is cannot_verify. The old
 * verdict is kept as `<key>.prev.json` for the audit trail (never overwritten once it exists).
 */
export async function rejudgeCannotVerify(options: {
  setId: string;
  scenarioId: string;
  resultsRoot?: string;
  truthRoot?: string;
  client?: JudgeClient;
  now?: Date;
  months?: number;
  limit?: number;
  /** Which answers to look at (default q1, q2, q3): only verdicts with a cannot_verify in one of these are re-judged. */
  fields?: Array<"q1" | "q2" | "q3">;
}): Promise<{ selected: number; before: { cannotVerify: number; good: number }; after: { cannotVerify: number; good: number }; failed: number }> {
  const root = options.resultsRoot ?? "eval/results";
  let leads = JSON.parse(await readFile(join(root, options.setId, options.scenarioId, "blind.json"), "utf8")) as BlindLead[];
  const fields = options.fields ?? ["q1", "q2", "q3"];
  const targets: Array<{ lead: BlindLead; old: Verdict }> = [];
  for (const lead of leads) {
    const file = truthPath(options.scenarioId, lead.company, lead.signal_url, options.truthRoot);
    if (!existsSync(file)) continue;
    const old = JSON.parse(await readFile(file, "utf8")) as Verdict;
    if (old.judge !== "human" && fields.some((f) => old[f] === "cannot_verify")) targets.push({ lead, old });
  }
  leads = [];
  const chosen = options.limit !== undefined ? targets.slice(0, options.limit) : targets;
  console.log(`rejudge-cannot-verify: ${targets.length} verdicts have cannot_verify in ${fields.join(",")}; judging ${chosen.length}`);
  const before = { cannotVerify: chosen.length, good: chosen.filter((t) => t.old.good).length };
  const after = { cannotVerify: 0, good: 0 };
  let failed = 0;
  let total = 0;
  for (const { lead, old } of chosen) {
    const file = truthPath(options.scenarioId, lead.company, lead.signal_url, options.truthRoot);
    const prev = file.replace(/\.json$/, ".prev.json");
    if (!existsSync(prev)) await writeJson(prev, old);
    try {
      const verdict = await judgeLead({
        scenarioId: options.scenarioId, lead, client: options.client, truthRoot: options.truthRoot, force: true,
        now: options.now, months: options.months, setId: options.setId, resultsRoot: root,
      });
      // judgeLead leaves the old file in place when it falls back, so re-read what is on disk.
      const current = JSON.parse(await readFile(file, "utf8")) as Verdict;
      if (current.judgedAt !== verdict.judgedAt) failed += 1;
      if (hasCannotVerify(current)) after.cannotVerify += 1;
      if (current.good) after.good += 1;
      total += verdict.costDollars ?? 0;
    } catch (error) {
      failed += 1;
      if (hasCannotVerify(old)) after.cannotVerify += 1;
      if (old.good) after.good += 1;
      console.error(`judge: API error on ${lead.company}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`rejudge-cannot-verify: ${chosen.length} re-judged ($${total.toFixed(4)}); with a cannot_verify ${before.cannotVerify} -> ${after.cannotVerify}; good ${before.good} -> ${after.good}; failed ${failed}`);
  return { selected: chosen.length, before, after, failed };
}

/**
 * Free: re-parse saved judge-failures/*.txt with the current parser. A recovered
 * verdict is written to truth (cost taken from judge-cost.json's perLead entry
 * if present, else 0) and its failure file deleted.
 */
export async function replayFailures(options: {
  setId: string;
  scenarioId?: string;
  resultsRoot?: string;
  truthRoot?: string;
  now?: Date;
}): Promise<{ recovered: number; stillFailing: number; noLead: number }> {
  const root = options.resultsRoot ?? "eval/results";
  const setDir = join(root, options.setId);
  const scenarios = options.scenarioId ? [options.scenarioId] : (await readdir(setDir).catch(() => [] as string[]));
  const counts = { recovered: 0, stillFailing: 0, noLead: 0 };
  for (const scenarioId of scenarios) {
    const failDir = join(setDir, scenarioId, "judge-failures");
    const files = (await readdir(failDir).catch(() => [] as string[])).filter((f) => f.endsWith(".txt"));
    if (files.length === 0) continue;
    const blindFile = join(setDir, scenarioId, "blind.json");
    const leads = existsSync(blindFile) ? (JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[]) : [];
    const costFile = join(setDir, scenarioId, "judge-cost.json");
    const perLead = existsSync(costFile)
      ? ((JSON.parse(await readFile(costFile, "utf8")) as { perLead?: Array<{ company: string; signal_url: string; costDollars?: number; webSearches?: number; webFetches?: number; usage?: JudgeUsage }> }).perLead ?? [])
      : [];
    for (const file of files) {
      const key = file.replace(/\.txt$/, "");
      const lead = leads.find((l) => truthKey(l.company, l.signal_url) === key);
      if (!lead) {
        counts.noLead += 1;
        continue;
      }
      const raw = await readFile(join(failDir, file), "utf8");
      const parsed = parseJudgeJson(raw.replace(/^stop_reason:[^\n]*\n\n/, ""));
      if (!parsed) {
        counts.stillFailing += 1;
        continue;
      }
      const entry = perLead.find((p) => p.company === lead.company && p.signal_url === lead.signal_url);
      const spent: Spent = { usage: entry?.usage ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, costDollars: entry?.costDollars ?? 0, webSearches: entry?.webSearches ?? 0, webFetches: 0, fetchErrors: [] };
      const verdict = toVerdict(lead, scenarioId, parsed, options.now ?? new Date(), spent);
      await writeJson(truthPath(scenarioId, lead.company, lead.signal_url, options.truthRoot), verdict);
      await unlink(join(failDir, file));
      counts.recovered += 1;
      console.log(`judge: recovered ${lead.company} q1=${verdict.q1} q2=${verdict.q2} q3=${verdict.q3} good=${verdict.good}`);
    }
  }
  console.log(`replay-failures: ${counts.recovered} recovered, ${counts.stillFailing} still failing, ${counts.noLead} without a blind lead`);
  return counts;
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
  note?: string;
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
    ...cleanNote(options.note),
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
    if (key === "force" || key === "human" || key === "dry-run" || key === "replay-failures" || key === "rejudge-cannot-verify") out[key] = true;
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
      note: args.note ? String(args.note) : undefined,
    });
    console.log(`human verdict wrote ${args.company}`);
    return;
  }
  if (args["replay-failures"]) {
    if (!args.set) throw new Error("pass --set <id> [--scenario <id>]");
    await replayFailures({ setId: String(args.set), scenarioId: args.scenario ? String(args.scenario) : undefined, now: args.now ? new Date(String(args.now)) : undefined });
    return;
  }
  if (!args.set || !args.scenario) throw new Error("pass --set <id> --scenario <id>");
  if (args["rejudge-cannot-verify"]) {
    await rejudgeCannotVerify({
      setId: String(args.set), scenarioId: String(args.scenario),
      now: args.now ? new Date(String(args.now)) : undefined,
      months: args.months ? Number(args.months) : undefined,
      limit: args.limit ? Number(args.limit) : undefined,
      fields: args.fields ? parseFields(String(args.fields)) : undefined,
    });
    return;
  }
  if (args["dry-run"]) {
    const blindFile = join("eval/results", String(args.set), String(args.scenario), "blind.json");
    const first = (JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[])[0];
    if (!first) throw new Error("blind pool is empty");
    const all = JSON.parse(await readFile(blindFile, "utf8")) as BlindLead[];
    const costFile = join("eval/results", String(args.set), String(args.scenario), "judge-cost.json");
    const n = args.limit ? Math.min(Number(args.limit), all.length) : all.length;
    let projection = `${n} of ${all.length} blind leads would be judged.`;
    if (existsSync(costFile)) {
      const c = JSON.parse(readFileSync(costFile, "utf8")) as { totalDollars?: number; perLead?: unknown[] };
      const judged = (c.perLead ?? []).length;
      if (judged > 0 && typeof c.totalDollars === "number") {
        const avg = c.totalDollars / judged;
        projection += ` Average so far $${avg.toFixed(4)}/lead over ${judged} judged; projected $${(avg * n).toFixed(2)}.`;
      }
    }
    console.log(projection);
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
