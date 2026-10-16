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
 *   npx tsx eval/harness/judge-contacts.ts --model jev [--results eval/results/contact-eval-2026-10-16] [--recordings eval/recordings/contact-eval-2026-10-16] [--limit n]
 *
 * --model jev is the evidence-only variant (src/judges/jev.ts, docs/RESEARCH-jev.md): no web. It judges only the
 * VERIFIED contacts of a contact-eval, on the evidence page text recorded in the Exa recordings, with one Noul
 * ("does this page show NAME currently holds TITLE at COMPANY"), and prints agreement with the Opus verdicts
 * (contacts-v1-*.jsonl in --results) where both exist. It needs JEV_API_KEY and refuses to start without it.
 *
 * The labelled set (eval/datasets/contact-cases.jsonl) is one ContactCase per line; it ships empty until a
 * human labels it (research §5.7: ~25 companies, frozen before the first scored run).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contactAnswerFromNoul, jevContactCurrent, requireJevKey, type JevOptions } from "../../src/judges/jev";
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
  /** null until a human (or the judge) fills it. */
  label: "verified" | "inferred" | "wrong" | null;
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
  if (r.label !== null && !LABELS.includes(r.label as never)) problems.push(`label must be null or one of ${LABELS.join(" | ")}`);
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
export type ContactToJudge = { id: string; company: string; name: string; title: string; /** Only for selecting which contacts to judge; never put in the prompt. */ tier?: "verified" | "inferred" };

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
  webFetches: number;
  judgedAt: string;
  /** The judge's raw reply text (masked, truncated), kept so a parse problem can be read. */
  raw?: string;
};

export const CONTACT_JUDGE_VERSION = "contacts-v1";
const MAX_SEARCHES = 3;
const MAX_FETCHES = 2;

export const CONTACT_JUDGE_SYSTEM = `You check one fact about one person, for a sales-research tool's evaluation.
Question: does this person CURRENTLY hold this role (or a title with the same function and seniority) at this company?
Use web_search (at most ${MAX_SEARCHES} searches) and web_fetch (at most ${MAX_FETCHES} fetches): the company's own site, recent press, conference bios, LinkedIn search results.
- yes: a source dated within the last 18 months, or the company's own current team page, says so.
- no: a source shows they left, or hold a clearly different role there.
- cannot_verify: nothing found either way.
You may write reasoning first. End the reply with exactly one JSON object and nothing after it: {"current": "yes" | "no" | "cannot_verify", "source": "<url you relied on, or empty>", "note": "<one sentence>"}`;

export function contactPrompt(c: ContactToJudge): string {
  return `Is ${c.name} currently ${c.title} at ${c.company}?\n\n${JSON.stringify({ person: c.name, title: c.title, company: c.company }, null, 2)}`;
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

/** Masks API-key-looking strings and email addresses before a reply is printed or stored. */
export function maskReply(text: string): string {
  return text.replace(/\b(sk|key|exa|tok)[-_][A-Za-z0-9_-]{16,}\b/gi, "[key]").replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]");
}

type JudgeClient = Pick<Anthropic, "messages">;

export async function judgeContact(c: ContactToJudge, client: JudgeClient, now = new Date()): Promise<ContactVerdict> {
  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    system: CONTACT_JUDGE_SYSTEM,
    messages: [{ role: "user", content: contactPrompt(c) }],
    output_config: { effort: "medium" },
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES, max_content_tokens: 6000 },
    ],
  } as never);
  const spent = responseCost(response);
  const text = allText(response);
  const parsed = parseContactJudge(text);
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
    webFetches: spent.webFetches,
    judgedAt: now.toISOString(),
    raw: maskReply(text).slice(0, 6000),
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
      out.push({ id: `${company}#${i}`, company, name: c.name, title, ...(c.tier === "verified" || c.tier === "inferred" ? { tier: c.tier } : {}) });
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

// --- --model jev: evidence-only, verified contacts, recorded page text ---------------------------

export type JevContactCase = { company: string; name: string; title: string; evidenceUrl: string; published?: string; pageText: string };
export type JevContactRow = JevContactCase & { pFound: number; current: RubricAnswer; costDollars: number };

/** Same page, same key: lower-case host, no hash, no trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsonFiles(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : []));
}

/** url -> page text (and Exa's publishedDate) from every recorded Exa search response under `dir`. The longest text wins when a URL recurs. */
export function pageTextIndex(dir: string): Map<string, { text: string; published?: string }> {
  const index = new Map<string, { text: string; published?: string }>();
  for (const file of jsonFiles(dir)) {
    const rec = JSON.parse(readFileSync(file, "utf8")) as { response?: { results?: Array<{ url?: unknown; text?: unknown; publishedDate?: unknown }> } };
    for (const r of rec.response?.results ?? []) {
      if (typeof r.url !== "string" || typeof r.text !== "string" || !r.text.trim()) continue;
      const key = normalizeUrl(r.url);
      if ((index.get(key)?.text.length ?? 0) >= r.text.length) continue;
      index.set(key, { text: r.text, ...(typeof r.publishedDate === "string" ? { published: r.publishedDate } : {}) });
    }
  }
  return index;
}

/** Verified contacts of a contact-eval's contacts.jsonl, joined to the recorded text of their evidence page. Those without a recorded page are returned in `missing` (never judged on nothing). */
export function verifiedContactCases(contactsJsonl: string, pages: Map<string, { text: string; published?: string }>): { cases: JevContactCase[]; missing: Array<{ company: string; name: string; reason: string }> } {
  const cases: JevContactCase[] = [];
  const missing: Array<{ company: string; name: string; reason: string }> = [];
  for (const line of contactsJsonl.split("\n").filter((l) => l.trim())) {
    const row = JSON.parse(line) as { company?: string; contacts?: Array<{ name?: string; tier?: string; why?: string; evidence?: { url?: string; title_quote?: string; published?: string } }> };
    for (const c of row.contacts ?? []) {
      if (c.tier !== "verified" || !row.company || !c.name) continue;
      const url = c.evidence?.url;
      const title = c.evidence?.title_quote ?? c.why;
      if (!url || !title) {
        missing.push({ company: row.company, name: c.name, reason: "no evidence url / title" });
        continue;
      }
      const page = pages.get(normalizeUrl(url));
      if (!page) {
        missing.push({ company: row.company, name: c.name, reason: `no recorded page text for ${url}` });
        continue;
      }
      cases.push({ company: row.company, name: c.name, title, evidenceUrl: url, ...(page.published ?? c.evidence?.published ? { published: page.published ?? c.evidence?.published } : {}), pageText: page.text });
    }
  }
  return { cases, missing };
}

export async function judgeContactsWithJev(cases: JevContactCase[], opts: JevOptions = {}): Promise<JevContactRow[]> {
  const rows: JevContactRow[] = [];
  for (const c of cases) {
    const v = await jevContactCurrent(c.pageText, c.name, c.title, c.company, { ...opts, pageUrl: c.evidenceUrl, ...(c.published ? { pageDate: c.published } : {}) });
    rows.push({ ...c, pFound: v.pFound, current: contactAnswerFromNoul(v.pFound), costDollars: v.costDollars });
  }
  return rows;
}

const contactKey = (company: string, name: string) => `${company.trim().toLowerCase()}|${name.trim().toLowerCase()}`;

/** Agreement of Jev's yes / no / cannot_verify with the Opus verdicts, matched on company + name; contacts without an Opus verdict are not compared. */
export function agreementWithOpus(jev: JevContactRow[], opus: Array<Pick<ContactVerdict, "company" | "name" | "current">>) {
  const byKey = new Map(opus.map((o) => [contactKey(o.company, o.name), o.current]));
  const compared = jev.flatMap((j) => {
    const o = byKey.get(contactKey(j.company, j.name));
    return o ? [{ company: j.company, name: j.name, jev: j.current, pFound: j.pFound, opus: o }] : [];
  });
  return { compared, agree: compared.filter((c) => c.jev === c.opus).length, total: compared.length };
}

function opusVerdictsIn(dir: string): ContactVerdict[] {
  return readdirSync(dir)
    .filter((f) => /^contacts-v1-.*\.jsonl$/.test(f))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ContactVerdict),
    );
}

async function mainJev() {
  const resultsDir = arg("--results") ?? join("eval", "results", "contact-eval-2026-10-16");
  const recordingsDir = arg("--recordings") ?? join("eval", "recordings", "contact-eval-2026-10-16");
  const limit = Number(arg("--limit") ?? Infinity);
  const apiKey = requireJevKey();
  const { cases, missing } = verifiedContactCases(await readFile(join(resultsDir, "contacts.jsonl"), "utf8"), pageTextIndex(recordingsDir));
  for (const m of missing) console.error(`skipped ${m.name} @ ${m.company}: ${m.reason}`);
  const rows = await judgeContactsWithJev(cases.slice(0, limit), { apiKey });
  for (const r of rows) console.log(`${r.name} @ ${r.company} (${r.title}): p=${r.pFound.toFixed(3)} -> ${r.current} ($${r.costDollars.toFixed(5)})`);
  const opus = agreementWithOpus(rows, opusVerdictsIn(resultsDir));
  for (const c of opus.compared) console.log(`vs opus: ${c.name} @ ${c.company}: jev ${c.jev} (p=${c.pFound.toFixed(3)}) / opus ${c.opus}`);
  console.log(`agreement with Opus: ${opus.agree}/${opus.total} (contacts with an Opus verdict only)`);
  const outDir = arg("--out") ?? join("eval", "results", "contacts");
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `jev-contacts-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await writeFile(file, `${rows.map((r) => JSON.stringify({ ...r, pageText: undefined, pageChars: r.pageText.length })).join("\n")}\n`, "utf8");
  console.log(`judged ${rows.length} verified contact(s), ${missing.length} skipped, $${rows.reduce((n, r) => n + r.costDollars, 0).toFixed(5)} → ${file}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const model = arg("--model");
  if (model !== undefined && model !== "anthropic" && model !== "jev") throw new Error(`--model takes anthropic or jev, got ${JSON.stringify(model)}`);
  if (model === "jev") return mainJev();
  const casesPath = arg("--cases");
  const runDir = arg("--run");
  const limit = Number(arg("--limit") ?? Infinity);
  const outDir = arg("--out") ?? join("eval", "results", "contacts");
  if (!casesPath && !runDir) {
    console.error("usage: judge-contacts.ts --cases <jsonl> | --run <runs/id> [--limit n] [--tier verified|inferred] [--out dir]");
    process.exit(2);
  }
  const inputs: ContactToJudge[] = casesPath
    ? parseContactCases(await readFile(casesPath, "utf8")).map((c) => ({ id: c.id, company: c.company, name: c.candidate_name, title: c.title, ...(c.tier ? { tier: c.tier } : {}) }))
    : contactsFromRunState(JSON.parse(await readFile(join(runDir!, "state.json"), "utf8")));
  if (inputs.length === 0) {
    console.error("judge-contacts: no contacts to judge (the labelled set ships empty until it is labelled)");
    process.exit(1);
  }
  const tier = arg("--tier");
  const selected = tier ? inputs.filter((c) => c.tier === tier) : inputs;
  if (selected.length === 0) {
    console.error(`judge-contacts: no contacts match --tier ${tier}`);
    process.exit(1);
  }
  const client = new Anthropic();
  const verdicts: ContactVerdict[] = [];
  for (const c of selected.slice(0, limit)) {
    const v = await judgeContact(c, client);
    verdicts.push(v);
    console.log(`--- ${c.name} @ ${c.company} (${c.title}) ---\nraw reply (masked):\n${v.raw ?? ""}\nparsed: ${JSON.stringify({ current: v.current, source: v.source, note: v.note })}\ncost: $${v.costDollars.toFixed(4)} (${v.webSearches} searches, ${v.webFetches} fetches)`);
  }
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
