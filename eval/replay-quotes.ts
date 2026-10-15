/**
 * $0 replay of the quote matcher against recorded Exa responses.
 * Usage: npx tsx eval/replay-quotes.ts
 * Writes eval/results/quote-replay-2026-10-15.md (memory eval); pass --2026-10-14 to also regenerate the 2026-10-14 report.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { headcountQuoteInText, quoteMatch } from "../src/gates.js";

const ROOT = "eval/recordings/live-quotes-2026-10-14";
const OUT = "eval/results/quote-replay-2026-10-14.md";

// OLD matcher, verbatim from HEAD (whitespace-collapsing substring).
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}
function oldNorm(v: string): string {
  return decodeHtmlEntities(v)
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function oldQuoteInText(quote: string, text: string): boolean {
  const q = oldNorm(quote);
  return q.length > 0 && oldNorm(text).includes(q);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".json") ? [p] : [];
  });
}

const alnum = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Heuristic: does a NEW-pass quote look stitched from separate parts of the page? */
function synthNote(quote: string, text: string): string {
  if (/\.{3}|…/.test(quote)) return "";
  const lines = text.split("\n");
  // locate the first and last text line the stripped quote touches
  const q = alnum(quote);
  let acc = "";
  const starts: number[] = [];
  for (const l of lines) { starts.push(acc.length); acc += alnum(l); }
  const at = acc.indexOf(q);
  if (at < 0) return "";
  const end = at + q.length;
  let first = 0, last = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = alnum(lines[i]!).length;
    if (len === 0) continue;
    if (starts[i]! + len > at && starts[i]! < end) { if (!first && starts[i]! + len > at) first = i; last = i; }
  }
  const span = lines.slice(first, last + 1);
  const content = span.filter((l) => alnum(l).length > 0);
  const header = span.slice(1).some((l) => /^#{1,6}\s/.test(l));
  if (header) return "crosses a markdown section header";
  if (content.length >= 4) return `spans ${content.length} non-empty lines`;
  return "";
}

interface Row {
  file: string; company: string; key: string; value: string; quote: string;
  old: boolean; neu: boolean; reason: string; note: string;
}
const rows: Row[] = [];
let companiesSeen = 0;

for (const f of walk(ROOT).sort()) {
  const rec = JSON.parse(readFileSync(f, "utf8")) as {
    request?: { category?: string; query?: string };
    response?: { results?: Array<{ title?: string; text?: string; summary?: unknown }> };
  };
  const results = rec.response?.results ?? [];
  const isCompany = rec.request?.category === "company";
  const targets = isCompany ? results.slice(0, 1) : results;
  for (const r of targets) {
    let sum: Record<string, unknown> | undefined;
    try {
      sum = typeof r.summary === "string" ? JSON.parse(r.summary) : (r.summary as Record<string, unknown>);
    } catch { continue; }
    if (!sum || typeof sum !== "object") continue;
    const keys = Object.keys(sum).filter((k) =>
      isCompany ? /_quote$/.test(k) || k === "employee_estimate_source" : k === "signal_quote");
    if (isCompany) companiesSeen++;
    for (const key of keys) {
      const quote = typeof sum[key] === "string" ? (sum[key] as string) : "";
      const valueKey = key.endsWith("_quote") ? key.slice(0, -6) : key === "employee_estimate_source" ? "employee_estimate" : "";
      const value = valueKey ? String(sum[valueKey] ?? "") : "";
      const text = r.text ?? "";
      const company = isCompany ? (rec.request?.query ?? r.title ?? "?") : String(sum.company_name ?? r.title ?? "?");
      if (!quote.trim()) { rows.push({ file: relative(ROOT, f), company, key, value, quote: "", old: false, neu: false, reason: "empty", note: "" }); continue; }
      const old = oldQuoteInText(quote, text);
      const m = quoteMatch(quote, text, key === "employee_estimate_source" || key === "hq_quote" ? { minSegment: 6, minTotal: 6 } : undefined);
      rows.push({ file: relative(ROOT, f), company, key, value, quote, old, neu: m.ok, reason: m.reason ?? "", note: m.ok ? synthNote(quote, text) : "" });
    }
  }
}

const present = rows.filter((r) => r.quote);
const flips = present.filter((r) => !r.old && r.neu);
const regress = present.filter((r) => r.old && !r.neu);
const flagged = present.filter((r) => r.neu && r.note);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

const lines: string[] = [];
lines.push("# Quote matcher replay - 2026-10-14", "");
lines.push(`Source: \`${ROOT}/**\` (${companiesSeen} company lookups; signal recordings with signal_quote included). $0, no API calls.`, "");
lines.push("## Counts", "");
lines.push(`- quote fields: ${rows.length} (present ${present.length}, empty ${rows.length - present.length})`);
lines.push(`- OLD pass: ${present.filter((r) => r.old).length}/${present.length}`);
lines.push(`- NEW pass: ${present.filter((r) => r.neu).length}/${present.length}`);
lines.push(`- flip old FAIL -> new PASS: ${flips.length}`);
lines.push(`- regress old PASS -> new FAIL: ${regress.length}`);
lines.push(`- NEW fail reasons: ${JSON.stringify(present.filter((r) => !r.neu).reduce<Record<string, number>>((a, r) => ((a[r.reason] = (a[r.reason] ?? 0) + 1), a), {}))}`, "");
lines.push("## NEW passes that span many lines / sections (eyeball these)", "", "These are contiguous on the page once punctuation is stripped, so they are not stitched from distant lines; they are flagged only because a multi-line quote is where a false accept would hide. Quotes with an explicit ellipsis are flagged separately below.", "");
if (flagged.length === 0) lines.push("none");
for (const r of flagged) lines.push(`- ${r.company} / ${r.key} (${r.note}): ${cell(r.quote.slice(0, 200))}`);
const elided = present.filter((r) => r.neu && /\.{3}|\u2026/.test(r.quote));
lines.push("", "## NEW passes using an explicit ellipsis (elided parts are skipped; clauses must still be in order and local)", "");
if (elided.length === 0) lines.push("none");
for (const r of elided) lines.push(`- ${r.company} / ${r.key}: ${cell(r.quote.slice(0, 200))}`);
lines.push("", "## Regressions (old pass, new fail)", "");
if (regress.length === 0) lines.push("none");
for (const r of regress) lines.push(`- ${r.company} / ${r.key} [${r.reason}]: ${cell(r.quote.slice(0, 200))}`);
lines.push("", "## Table", "", "| company | key | value | quote (first 100) | old | new | new reason | note |", "|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  lines.push(`| ${cell(r.company)} | ${r.key} | ${cell(r.value.slice(0, 30))} | ${cell(r.quote.slice(0, 100))} | ${r.quote ? (r.old ? "pass" : "FAIL") : "-"} | ${r.quote ? (r.neu ? "pass" : "FAIL") : "-"} | ${r.reason} | ${cell(r.note)} |`);
}
const out = lines.join("\n") + "\n";
// The 2026-10-14 report is a historical artifact: regenerate it only on request.
if (process.argv.includes("--2026-10-14")) writeFileSync(OUT, out);
console.log(lines.slice(0, 12).join("\n"));

// ---------------------------------------------------------------------------
// 2026-10-15 memory eval: every lookup_company the agent screened as
// `quote_not_in_page` (S1 arm B, 3 reps), re-checked against the recorded Exa
// response, with the nearest page text and a failure class.
// ---------------------------------------------------------------------------


// Matcher as of HEAD fe7a4ee (before the ellipsis-boundary fix), frozen for before/after counts.
function prevQuoteStrip(v: string): string { return alnum(decodeHtmlEntities(v)); }
function prevClauses(quote: string, minClause: number): string[] {
  const pieces = quote.split(/\.{3}|\u2026|(?<!\d)\.|\.(?!\d)|[,;:"\u201C\u201D\n]/).map(prevQuoteStrip).filter((x) => x.length > 0);
  const out: string[] = [];
  let buf = "";
  for (const p of pieces) { buf += p; if (buf.length >= minClause) { out.push(buf); buf = ""; } }
  if (buf) { if (out.length > 0) out[out.length - 1] += buf; else out.push(buf); }
  return out;
}
function prevQuoteMatch(quote: string, text: string, o: { minSegment?: number; minTotal?: number } = {}): boolean {
  const minSegment = o.minSegment ?? 12, minTotal = o.minTotal ?? 20;
  const clauses = prevClauses(quote.slice(0, 500), minSegment);
  if (clauses.length === 0) return false;
  if (clauses.some((x) => x.length < minSegment) || clauses.reduce((n, x) => n + x.length, 0) < minTotal) return false;
  const hay = prevQuoteStrip(text.slice(0, 20000));
  const place = (i: number, ps: number, pe: number): boolean => {
    if (i === clauses.length) return true;
    const c = clauses[i]!;
    const limit = i === 0 ? Infinity : ps + 600;
    for (let at = hay.indexOf(c, pe); at >= 0 && at <= limit; at = hay.indexOf(c, at + 1)) if (place(i + 1, at, at + c.length)) return true;
    return false;
  };
  return place(0, 0, 0);
}

const MEM_RESULTS = "eval/results/memory-eval-2026-10-15/S1/B_agent_opus";
const MEM_REC = "eval/recordings/memory-eval-2026-10-15";
const MEM_OUT = "eval/results/quote-replay-2026-10-15.md";
const TRUNC = 20_000;

type Rec = { request: Record<string, unknown>; response: { results?: Array<{ url?: string; title?: string; text?: string; summary?: unknown }> } };

function parseSummary(v: unknown): Record<string, unknown> {
  try { return (typeof v === "string" ? JSON.parse(v) : v) as Record<string, unknown> ?? {}; } catch { return {}; }
}

/** Longest stripped substring of the quote that occurs in the stripped page. */
function nearest(quote: string, text: string): string {
  const a = alnum(quote), t = alnum(text);
  let best = "";
  for (let i = 0; i < a.length; i++) {
    if (a.length - i <= best.length) break;
    let len = best.length;
    while (i + len + 1 <= a.length && t.includes(a.slice(i, i + len + 1))) len++;
    if (len > best.length) best = a.slice(i, i + len);
  }
  return best;
}

const COMMENTARY = /\b(does not state|not state|described as|listed under|the page (?:describes|states|says)|no explicit|appears to)\b/i;

/** Hand-checked explanation per (rep, company), written after reading each page. */
const NOTES: Record<string, string> = {
  "1|Spartan Logistics": "bare figure '281' (3 chars, below the 6-char floor); the page has 'Employees: 281' and 'employs 281 people'",
  "1|Southern AG Carriers": "summariser dropped words: page says 'They offer nationwide logistics and are dedicated to', quote says 'nationwide logistics and dedicated to'",
  "2|A. Duie Pyle": "signal_quote: summariser silently deleted the appositive '(Pyle), a premier ... solutions,' between subject and verb (no ellipsis marker); first fragment 'A. Duie Pyle' is 9 chars",
  "2|Spartan Logistics": "label/value reversed: quote '281 employees', page 'Employees: 281'",
  "2|Cleveland Group": "not a quote: summariser commentary ('it does not state ... third-party logistics'); the gate value is also 'no'",
  "2|King of Freight": "bare figure '679' (3 chars); the page has 'Employees: 679' and 'employs 679 people'",
  "2|Hollingsworth Logistics Group": "starts with summariser commentary ('listed under capabilities and services; company described as'); the tail is genuine page text with one comma dropped",
  "3|XDP Ltd": "explicit ellipsis join; both halves are contiguous page text 'employs 263 people (+4.4% YoY, +11 people), founded ... with offices in Tamworth'. Matcher bug: the short piece '+11 people)' was merged forward across the ellipsis",
  "3|Spartan Logistics": "two genuine sentences joined by '...'; the second starts 717 stripped chars after the first (window 600)",
};

/** Hand-checked class where the heuristic below cannot tell (see NOTES). */
const CLASS: Record<string, string> = {
  "2|A. Duie Pyle": "(f) silent appositive deletion (no ellipsis marker)",
  "2|Spartan Logistics": "(f) label/value reversed",
  "3|XDP Ltd": "(b) elision join (matcher bug, fixed)",
  "3|Spartan Logistics": "(c) two sentences 717 chars apart joined by ellipsis (outside window)",
};

async function memoryEvalReplay(): Promise<void> {
  const out: string[] = [];
  const classRows: string[] = [];
  const fetchRows: string[] = [];
  let total = 0, nowPass = 0;
  const byClass: Record<string, number> = {};
  for (const rep of ["1", "2", "3"]) {
    const events = readFileSync(join(MEM_RESULTS, rep, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    const state = JSON.parse(readFileSync(join(MEM_RESULTS, rep, "state.json"), "utf8")) as { screened?: Array<{ company: string; code: string; reason: string }> };
    const recs = readdirSync(join(MEM_REC, rep)).map((f) => JSON.parse(readFileSync(join(MEM_REC, rep, f), "utf8")) as Rec);
    const lookups = events.filter((e) => e.kind === "tool_call" && e.tool === "lookup_company");
    for (const e of lookups) {
      const name = String(e.input?.name ?? "");
      const summary = String(e.resultSummary ?? "");
      if (e.is_error === true && /fetch failed/.test(summary)) { fetchRows.push(`| ${rep} | ${cell(name)} | ${e.turn} | ${cell(summary)} |`); continue; }
      if (!/screened=quote_not_in_page/.test(summary)) continue;
      const screen = state.screened?.find((s) => s.company === name && s.code === "quote_not_in_page");
      const signalSide = /signal_quote|signal_date_quote/.test(screen?.reason ?? "");
      type Found = { key: string; quote: string; text: string; r1: boolean; kind: "signal" | "lookup"; now: boolean };
      const found: Found[] = [];
      let truncated = false;
      if (signalSide) {
        for (const r of recs) for (const x of r.response.results ?? []) {
          const s = parseSummary(x.summary);
          if (String(s.company_name ?? "") !== name || typeof s.signal_quote !== "string") continue;
          const hay = [x.title, x.text].filter(Boolean).join(" ");
          if (!prevQuoteMatch(s.signal_quote, hay)) found.push({ key: `signal_quote @ ${x.url}`, quote: s.signal_quote, text: hay, r1: false, kind: "signal", now: quoteMatch(s.signal_quote, hay).ok });
        }
      } else {
        const rec = recs.find((r) => r.request.category === "company" && r.request.query === name);
        const results = rec?.response.results ?? [];
        truncated = (results[0]?.text?.length ?? 0) >= TRUNC;
        const s0 = parseSummary(results[0]?.summary);
        for (const key of Object.keys(s0).filter((k) => /_quote$/.test(k) || k === "employee_estimate_source")) {
          const quote = typeof s0[key] === "string" ? (s0[key] as string) : "";
          if (!quote.trim()) continue;
          const opts = key === "employee_estimate_source" || key === "hq_quote" ? { minSegment: 6, minTotal: 6 } : undefined;
          if (prevQuoteMatch(quote, results[0]?.text ?? "", opts)) continue;
          const r1 = results[1] ? quoteMatch(quote, results[1].text, opts).ok : false;
          found.push({ key, quote, text: results[0]?.text ?? "", r1, kind: "lookup", now: key === "employee_estimate_source" ? headcountQuoteInText(quote, results[0]?.text) !== undefined : quoteMatch(quote, results[0]?.text, opts).ok });
        }
      }
      total++;
      if (found.every((f) => f.now)) nowPass++;
      for (const f of found) {
        let cls: string;
        if (f.r1) cls = "(d) quoted from results[1]";
        else if (truncated) cls = "(e) page truncated";
        else {
          const clauses = quoteClauses2(f.quote, f.key);
          const allFound = clauses.length > 0 && clauses.every((c) => alnum(f.text).includes(c));
          if (allFound) cls = "(c) non-adjacent joins (all clauses on the page, outside the window or out of order)";
          else if (alnum(f.quote).length < 6) cls = "(f) bare figure";
          else if (COMMENTARY.test(f.quote)) cls = "(f) summariser commentary / paraphrase";
          else cls = "(f) other: edited text";
        }
        cls = CLASS[`${rep}|${name}`] ?? cls;
        byClass[cls] = (byClass[cls] ?? 0) + 1;
        const near = nearest(f.quote, f.text);
        classRows.push(`| ${rep} | ${cell(name)} | ${cell(f.key)} | ${cell(f.quote.slice(0, 160))} | ${near.length}/${alnum(f.quote).length}: ${cell(near.slice(0, 90))} | ${cls} | ${f.now ? "PASS" : "reject"} | ${cell(NOTES[`${rep}|${name}`] ?? "")} |`);
      }
    }
  }
  out.push("# Quote replay: memory eval 2026-10-15 (S1 arm B, 3 reps)", "");
  out.push(`Source: \`${MEM_RESULTS}/{1,2,3}\` events and state, \`${MEM_REC}/{1,2,3}\` Exa recordings. $0, no API calls. Matcher: current \`quoteMatch\` (12-char clauses, in order, 600-char window).`, "");
  out.push("## Counts", "");
  out.push(`- lookups screened \`quote_not_in_page\`: ${total} (rep 1: 2, rep 2: 5, rep 3: 2)`);
  out.push(`- before (matcher at HEAD fe7a4ee): 0 of ${total} lookups pass the lookup-stage quote check`);
  out.push(`- after (current matcher): ${nowPass} of ${total} lookups pass the quote check on every failing key; ${total - nowPass} still rejected`);
  out.push(`- failing keys by class: ${JSON.stringify(byClass)}`);
  out.push("- no recorded lookup has text >= 20,000 chars (max 16,980), so class (e) cannot occur here; no quote matches `results[1].text`, so class (d) does not occur.", "");
  out.push("## Classification", "", "| rep | company | failing key (failed at HEAD) | quote | nearest page text (stripped chars) | class | now | note |", "|---|---|---|---|---|---|---|---|", ...classRows, "");
  out.push("## `error: fetch failed` lookups", "", "| rep | company | turn | resultSummary |", "|---|---|---|---|", ...fetchRows, "");
  out.push("Origin: Node's `fetch` rejects with `TypeError: fetch failed` (the real reason is in `error.cause`) when the TCP/TLS connection to api.exa.ai fails. `fetchWithRetry` in `src/exa.ts` only retried HTTP 429/5xx; a thrown network error escaped on the first attempt with no cause in the message. It is Exa transport, not our page fetch (lookup_company makes no page fetch of its own).", "");
  writeFileSync(MEM_OUT, out.join("\n") + "\n");
  console.log(out.join("\n"));
}

/** Stripped clauses of a quote (same split as the matcher) for the "all clauses on the page" test. */
function quoteClauses2(quote: string, key: string): string[] {
  const min = key === "employee_estimate_source" || key === "hq_quote" ? 6 : 12;
  const pieces = quote
    .split(/\.{3}|\u2026|(?<!\d)\.|\.(?!\d)|[,;:"\u201C\u201D\n]/)
    .map(alnum)
    .filter((x) => x.length >= min);
  return pieces;
}

await memoryEvalReplay();
