/**
 * Contact judge (docs/SPEC-agent.md §5b, docs/RESEARCH-contacts-and-graph.md §5.7). Code only: NOT run yet.
 * Running it is paid (Claude + web search); per the paid-eval rule, run `--limit 1` first and read the raw
 * output before any batch.
 *
 * For each contact it asks one question with web search: is this person currently in this role at this
 * company? Answer yes / no / cannot_verify, with the URL it relied on. The judge never sees the gate's tier,
 * so the verified/inferred split can be scored blind.
 *
 *   npx tsx eval/harness/judge-contacts.ts --cases eval/datasets/contact-cases.jsonl [--limit 1] [--out eval/results/contacts]
 *   npx tsx eval/harness/judge-contacts.ts --run runs/<id> [--limit 1]
 *
 * The labelled set (eval/datasets/contact-cases.jsonl) is one ContactCase per line; it ships empty until a
 * human labels it (research §5.7: ~25 companies, frozen before the first scored run).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { allText, balancedJsonObjects, normalizeAnswer, responseCost } from "./judge";
import type { RubricAnswer } from "./types";

/** One labelled contact. `label` is the human's verdict; `tier` is what the product showed (absent for human-found people). */
export type ContactCase = {
  id: string;
  company: string;
  candidate_name: string;
  title: string;
  /** The URL the labeller confirmed the person and title on (any site; the labeller may use LinkedIn by hand, the product does not). */
  url: string;
  label: "verified" | "inferred" | "wrong";
  note?: string;
  /** What the product returned for this person, when the case came from a run. */
  tier?: "verified" | "inferred";
  /** ISO date the label was made: titles go stale, so the label is "as of". */
  labelled_at?: string;
};

const LABELS = ["verified", "inferred", "wrong"] as const;

/** Problems with one case; empty when valid. */
export function validateContactCase(value: unknown): string[] {
  const r = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (!r) return ["case must be an object"];
  const problems: string[] = [];
  for (const key of ["id", "company", "candidate_name", "title", "url"] as const) {
    if (typeof r[key] !== "string" || !(r[key] as string).trim()) problems.push(`${key} must be a non-empty string`);
  }
  if (typeof r.url === "string" && !/^https?:\/\//.test(r.url)) problems.push("url must be http(s)");
  if (!LABELS.includes(r.label as never)) problems.push(`label must be one of ${LABELS.join(" | ")}`);
  if (r.tier !== undefined && r.tier !== "verified" && r.tier !== "inferred") problems.push("tier must be verified | inferred when present");
  if (r.note !== undefined && typeof r.note !== "string") problems.push("note must be a string when present");
  return problems;
}

export function parseContactCases(text: string): ContactCase[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const parsed = JSON.parse(line) as unknown;
      const problems = validateContactCase(parsed);
      if (problems.length > 0) throw new Error(`contact-cases line ${i + 1}: ${problems.join("; ")}`);
      return parsed as ContactCase;
    });
}

/** What the judge needs: never the gate's tier or evidence, so its answer is independent of the code's. */
export type ContactToJudge = { id: string; company: string; name: string; title: string };

export type ContactVerdict = {
  id: string;
  company: string;
  name: string;
  title: string;
  current: RubricAnswer;
  source: string;
  note?: string;
  costDollars: number;
  webSearches: number;
  judgedAt: string;
};

export const CONTACT_JUDGE_VERSION = "contacts-v1";
const MAX_SEARCHES = 3;

export const CONTACT_JUDGE_SYSTEM = `You check one fact about one person, for a sales-research tool's evaluation.
Question: does this person CURRENTLY hold this role (or a title with the same function and seniority) at this company?
Use web search (at most ${MAX_SEARCHES} searches): the company's own site, recent press, conference bios, LinkedIn search results.
- yes: a source dated within the last 18 months, or the company's own current team page, says so.
- no: a source shows they left, or hold a clearly different role there.
- cannot_verify: nothing found either way.
Reply with exactly one JSON object and nothing after it: {"current": "yes" | "no" | "cannot_verify", "source": "<url you relied on, or empty>", "note": "<one sentence>"}`;

export function contactPrompt(c: ContactToJudge): string {
  return JSON.stringify({ person: c.name, title: c.title, company: c.company }, null, 2);
}

/** The LAST balanced JSON object with a valid `current` answer. */
export function parseContactJudge(text: string): { current: RubricAnswer; source: string; note?: string } | undefined {
  const objects = balancedJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(objects[i]!) as Record<string, unknown>;
      const current = normalizeAnswer(parsed.current);
      if (!current) continue;
      return { current, source: typeof parsed.source === "string" ? parsed.source : "", ...(typeof parsed.note === "string" && parsed.note.trim() ? { note: parsed.note.trim().slice(0, 500) } : {}) };
    } catch {
      continue;
    }
  }
  return undefined;
}

type JudgeClient = Pick<Anthropic, "messages">;

export async function judgeContact(c: ContactToJudge, client: JudgeClient, now = new Date()): Promise<ContactVerdict> {
  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    system: CONTACT_JUDGE_SYSTEM,
    messages: [{ role: "user", content: contactPrompt(c) }],
    output_config: { effort: "medium" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
  } as never);
  const spent = responseCost(response);
  const parsed = parseContactJudge(allText(response));
  if (!parsed) {
    // A judge that could not answer is never silent: it is recorded as cannot_verify with the reason.
    console.error(`judge-contacts: no parseable verdict for ${c.id} (stop_reason ${String((response as { stop_reason?: unknown }).stop_reason)})`);
  }
  return {
    id: c.id,
    company: c.company,
    name: c.name,
    title: c.title,
    current: parsed?.current ?? "cannot_verify",
    source: parsed?.source ?? "",
    ...(parsed?.note ? { note: parsed.note } : parsed ? {} : { note: "unparseable judge reply" }),
    costDollars: spent.costDollars,
    webSearches: spent.webSearches,
    judgedAt: now.toISOString(),
  };
}

/** Contacts of a finished run (state.json), as judge inputs. A verified contact's title is its quote; an inferred one is judged against its role. */
export function contactsFromRunState(state: unknown): ContactToJudge[] {
  const leads = (state as { leads?: unknown }).leads;
  if (!Array.isArray(leads)) return [];
  const out: ContactToJudge[] = [];
  for (const lead of leads as Array<{ company?: unknown; contacts?: { contacts?: Array<{ name?: unknown; why?: unknown; role?: unknown; tier?: unknown }> } }>) {
    const company = typeof lead.company === "string" ? lead.company : "";
    for (const [i, c] of (lead.contacts?.contacts ?? []).entries()) {
      if (typeof c.name !== "string" || !company) continue;
      const title = c.tier === "verified" && typeof c.why === "string" ? c.why : typeof c.role === "string" ? c.role : "";
      out.push({ id: `${company}#${i}`, company, name: c.name, title });
    }
  }
  return out;
}

/**
 * Metrics over judged contacts joined with the tier the product showed (research §5.7):
 * precision of verified = yes / (verified judged yes|no); stale rate = no among verified;
 * inferred honesty = no among inferred (high is honest: the inferred tier should hold the doubtful ones).
 */
export function contactMetrics(rows: Array<{ tier: "verified" | "inferred"; current: RubricAnswer }>) {
  const of = (tier: "verified" | "inferred", answer: RubricAnswer) => rows.filter((r) => r.tier === tier && r.current === answer).length;
  const vYes = of("verified", "yes");
  const vNo = of("verified", "no");
  const iNo = of("inferred", "no");
  const iYes = of("inferred", "yes");
  return {
    verified: rows.filter((r) => r.tier === "verified").length,
    inferred: rows.filter((r) => r.tier === "inferred").length,
    verifiedPrecision: vYes + vNo > 0 ? vYes / (vYes + vNo) : null,
    verifiedStaleRate: vYes + vNo > 0 ? vNo / (vYes + vNo) : null,
    inferredWrongShare: iYes + iNo > 0 ? iNo / (iYes + iNo) : null,
    cannotVerify: rows.filter((r) => r.current === "cannot_verify").length,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const casesPath = arg("--cases");
  const runDir = arg("--run");
  const limit = Number(arg("--limit") ?? Infinity);
  const outDir = arg("--out") ?? join("eval", "results", "contacts");
  if (!casesPath && !runDir) {
    console.error("usage: judge-contacts.ts --cases <jsonl> | --run <runs/id> [--limit n] [--out dir]");
    process.exit(2);
  }
  const inputs: ContactToJudge[] = casesPath
    ? parseContactCases(await readFile(casesPath, "utf8")).map((c) => ({ id: c.id, company: c.company, name: c.candidate_name, title: c.title }))
    : contactsFromRunState(JSON.parse(await readFile(join(runDir!, "state.json"), "utf8")));
  if (inputs.length === 0) {
    console.error("judge-contacts: no contacts to judge (the labelled set ships empty until it is labelled)");
    process.exit(1);
  }
  const client = new Anthropic();
  const verdicts: ContactVerdict[] = [];
  for (const c of inputs.slice(0, limit)) verdicts.push(await judgeContact(c, client));
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${CONTACT_JUDGE_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await writeFile(file, `${verdicts.map((v) => JSON.stringify(v)).join("\n")}\n`, "utf8");
  const cost = verdicts.reduce((n, v) => n + v.costDollars, 0);
  console.log(`judged ${verdicts.length} contact(s), $${cost.toFixed(3)} → ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
