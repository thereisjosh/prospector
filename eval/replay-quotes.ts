/**
 * $0 replay of the quote matcher against recorded Exa responses.
 * Usage: npx tsx eval/replay-quotes.ts
 * Writes eval/results/quote-replay-2026-10-14.md.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { quoteMatch } from "../src/gates.js";

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
writeFileSync(OUT, out);
console.log(out);
