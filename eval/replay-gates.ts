import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkIdentity as newCheckIdentity,
  checkLead as newCheckLead,
  isListingUrl,
  isThirdPartyListing,
  squashName,
  type LeadInput,
  type LeadVerdict,
} from "../src/gates";
import { checkIdentity as oldCheckIdentity, checkLead as oldCheckLead } from "./replay/gates-head-62321c3";
import { defaultScenario } from "./harness/run-cell";
import { findVerdictFile } from "./harness/truth";
import type { RunState } from "../src/agent/state";
import type { RunRecord, Verdict } from "./harness/types";

const SETS = ["pilot-2026-10-12", "live-quotes-2026-10-14", "memory-eval-2026-10-15", "memory-eval-2026-10-15b"];
const OUT = "eval/results/gate-replay-2026-10-15.md";
const FALLBACK_NOW = new Date("2026-10-12T00:00:00.000Z");

/** accepted/rejected-with-code, or not computable from what the pilot persisted. */
type Out = { accepted: true } | { accepted: false; code: string } | { unverifiable: string };

type Row = {
  set: string;
  scenario: string;
  arm: string;
  rep: string;
  company: string;
  good: boolean;
  /** workflow rows carry no summary/enrichment/page text: only signal-only rules ran. */
  signalOnly: boolean;
  before: Out;
  after: Out;
  /** lookup-dependent / quote-dependent rules that could not be evaluated for this lead. */
  unverifiable: string[];
  /** layer 2 */
  noSignalQuote: boolean;
  unquotedGates: string[];
  fullCode?: string;
  /** URL-shape rule alone (independent of the domain list): would it reject this lead? agent rows only. */
  shapeRule?: boolean;
  url: string;
};

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function verdictFor(scenario: string, company: string, signalUrl: string): Verdict | undefined {
  const file = findVerdictFile(join("eval/truth", scenario), company, signalUrl);
  return file ? json<Verdict>(file) : undefined;
}

/**
 * The scorer's definition of "good" (eval/harness/score.ts leadGood, RUBRIC section 1): q1 and q3 yes; q2 yes, or a
 * single q2 cannot_verify tolerated per run (a second one scores as no). Copied, not imported, because score.ts does
 * not export it; using the verdict file's own `good` field would disagree with report.md for S2/B_agent_opus.
 */
function scorerGood(v: Verdict, state: { q2Tolerated: boolean }): boolean {
  if (v.q1 !== "yes" || v.q3 !== "yes") return false;
  if (v.q2 === "yes") return true;
  if (v.q2 === "no") return false;
  if (!state.q2Tolerated) {
    state.q2Tolerated = true;
    return true;
  }
  return false;
}

const toOut = (v: LeadVerdict | { ok: false; code: string } | undefined): Out =>
  !v ? { accepted: true } : "ok" in v && v.ok ? { accepted: true } : { accepted: false, code: (v as { code: string }).code };

const isAccepted = (o: Out): boolean => "accepted" in o && o.accepted === true;
const codeOf = (o: Out): string => ("unverifiable" in o ? "unverifiable" : o.accepted ? "accepted" : o.code);

function agentInput(state: RunState, lead: RunState["leads"][number], now: Date): LeadInput {
  const signal = state.caches.signalsByUrl[lead.signal_url] ?? { url: lead.signal_url, summary: lead.summary };
  const cached = state.caches.enrichmentByName[squashName(lead.company)];
  const resultText = (cached?.result as { text?: unknown } | undefined)?.text;
  return {
    company: lead.company,
    signal,
    enrichment: lead.enrichment ?? cached?.summary,
    companyUrl: cached?.url,
    lookupText: typeof resultText === "string" ? resultText : undefined,
    now,
  };
}

// --- snapshot provenance ----------------------------------------------------
function snapshotMatchesHead(): string {
  try {
    const head = execFileSync("git", ["show", "62321c3:src/gates.ts"], { encoding: "utf8", maxBuffer: 16 << 20 });
    const snap = readFileSync("eval/replay/gates-head-62321c3.ts", "utf8");
    const norm = (s: string) =>
      s.split("\n").filter((l) => !l.startsWith("// Frozen copy")).join("\n").replace(/"\.\.\/\.\.\/src\//g, '"./').replace(/"\.\/(eval|geo|plan|types)"/g, '"./$1"');
    return norm(head) === norm(snap)
      ? "`eval/replay/gates-head-62321c3.ts` is byte-identical to `git show 62321c3:src/gates.ts` apart from its provenance comment and import paths (checked at replay time); it is used as the OLD side."
      : "WARNING: `eval/replay/gates-head-62321c3.ts` DIFFERS from `git show 62321c3:src/gates.ts`; OLD side is the snapshot.";
  } catch (e) {
    return `could not compare snapshot with HEAD (${(e as Error).message.split("\n")[0]})`;
  }
}

// --- build rows ------------------------------------------------------------
const rows: Row[] = [];
const WF_UNVERIFIABLE = [
  "hiring-by-roles (no signal text recorded)",
  "quote rules",
  "entity/hq/size/enterprise/gates (no lookup recorded)",
];

for (const SET of SETS) {
const ROOT = join("eval/results", SET);
for (const scenario of readdirSync(ROOT).filter((d) => d.startsWith("S") && statSync(join(ROOT, d)).isDirectory()).sort()) {
  const scenarioDir = join(ROOT, scenario);
  const plan = defaultScenario(scenario).plan;
  for (const arm of readdirSync(scenarioDir).filter((d) => statSync(join(scenarioDir, d)).isDirectory() && d !== "judge-failures").sort()) {
    const armDir = join(scenarioDir, arm);
    for (const rep of readdirSync(armDir).filter((d) => statSync(join(armDir, d)).isDirectory()).sort()) {
      const runPath = join(armDir, rep, "run.json");
      if (!existsSync(runPath)) continue;
      const run = json<RunRecord & { now?: string }>(runPath);
      const now = run.now && Number.isFinite(Date.parse(run.now)) ? new Date(run.now) : FALLBACK_NOW;
      const statePath = join(armDir, rep, "state.json");
      const state = existsSync(statePath) ? json<RunState>(statePath) : undefined;
      const q2State = { q2Tolerated: false };
      for (const lead of run.leads) {
        const truth = verdictFor(scenario, lead.company, lead.signal_url);
        if (!truth) continue;
        const base = { set: SET, scenario, arm, rep, company: lead.company, good: scorerGood(truth, q2State) };
        const stateLead = state?.leads.find(
          (l) => l.signal_url === lead.signal_url && (l.company === lead.company || squashName(l.company) === squashName(lead.company)),
        );
        if (!state || !stateLead) {
          // Workflow arm (or lead missing from state): run only the rules that need nothing but company + signal URL.
          const before = toOut(oldCheckIdentity(plan, lead.company, lead.signal_url));
          const after = toOut(newCheckIdentity(plan, lead.company, lead.signal_url));
          rows.push({
            ...base,
            signalOnly: true,
            before,
            after,
            unverifiable: state ? ["lead missing from copied agent state", ...WF_UNVERIFIABLE] : WF_UNVERIFIABLE,
            noSignalQuote: true,
            unquotedGates: [],
            url: lead.signal_url,
          });
          continue;
        }
        const input = agentInput(state, stateLead, now);
        const full = newCheckLead(plan, input);
        const enrichment = (input.enrichment ?? {}) as Record<string, unknown>;
        const unquotedGates = plan.gateFields
          .filter((g) => g.required && enrichment[g.key] === true && !String(enrichment[`${g.key}_quote`] ?? "").trim())
          .map((g) => g.key);
        if (plan.hqCountries.length > 0 && typeof enrichment.hq === "string" && enrichment.hq && !/^unknown$/i.test(enrichment.hq) && !String(enrichment.hq_quote ?? "").trim()) {
          unquotedGates.push("hq");
        }
        rows.push({
          ...base,
          signalOnly: false,
          before: toOut(oldCheckLead(plan, input, { evidenceMode: "skip-quotes" })),
          after: toOut(newCheckLead(plan, input, { evidenceMode: "skip-quotes" })),
          unverifiable: input.lookupText ? [] : ["lookup page text not recorded: quote_not_in_page on lookup quotes"],
          noSignalQuote: !String(input.signal.summary.signal_quote ?? "").trim(),
          unquotedGates,
          fullCode: full.ok ? "accepted" : full.code,
          shapeRule: isThirdPartyListing(input.signal, input.companyUrl),
          url: lead.signal_url,
        });
      }
    }
  }
}

}
// --- formatting ------------------------------------------------------------
const groupKey = (r: Row) => `${r.set}/${r.scenario}/${r.arm}`;
const groups = [...new Set(rows.map(groupKey))].sort();

function names(rs: Row[], withCode: boolean): string {
  const byKey = new Map<string, { n: number; reps: string[] }>();
  for (const r of rs) {
    const k = withCode ? `${r.company} [${codeOf(r.after)}]` : r.company;
    const e = byKey.get(k) ?? { n: 0, reps: [] };
    e.n += 1;
    e.reps.push(r.rep);
    byKey.set(k, e);
  }
  return [...byKey.entries()].map(([k, e]) => `${k} (rep ${e.reps.join(",")})`).join("; ") || "-";
}

const flipped = (r: Row) => isAccepted(r.before) && !isAccepted(r.after) && !("unverifiable" in r.after);
const sum = (rs: Row[], f: (r: Row) => boolean) => rs.filter(f).length;

const snapshotNote = snapshotMatchesHead();
const lines: string[] = [];
lines.push("# Gate Replay Projection - 2026-10-15 (third-party job-listing rule)", "");
lines.push(
  "Scope: every judged lead (verdict in `eval/truth/S1|S2/*.json`) in `eval/results/{pilot-2026-10-12,live-quotes-2026-10-14,memory-eval-2026-10-15,memory-eval-2026-10-15b}/**`; each lead is counted once per run (rep) it appeared in. No Exa or Anthropic calls are made ($0).",
  "",
);
lines.push(
  "**Simulation limits (exact).** (1) Pilot lead summaries (only) predate the quote fields: none carries `signal_quote`, `signal_date_quote`, `<gate>_quote` or `hq_quote`, so no quote rule can be evaluated against a fresh summary; Layer 1 therefore runs the NEW `checkLead` with `evidenceMode: \"skip-quotes\"`, and Layer 2 only counts which accepted leads would lack a quote. (2) Lookup page text was not recorded in the pilot state, so `quote_not_in_page` on lookup-page quotes (employee source, HQ, gate quotes) cannot be replayed for any lead. (3) Workflow-arm (`A_workflow`) `run.json` files persist only company, signal URL, why_now, event_date and size_basis: no signal summary, signal text, title, enrichment or lookup. For those leads only the rules that need nothing but company name and signal URL run (built-in/plan excluded domains, personal-profile URL, plan exclude names, placeholder/job-board names); hiring-by-roles, entity match, HQ, size, enterprise, gates and all quote rules are reported unverifiable per lead, not the lead dropped. (4) The signal-page text used for entity/hiring checks on agent-arm leads is the recorded Exa page text; the live-Exa behaviour of the quote rule is unproven until a paid run.",
  "",
);
lines.push(`OLD side: ${snapshotNote}`, "");
lines.push("Good/bad = the scorer's rule (`eval/harness/score.ts` leadGood: q1 and q3 yes, q2 yes or one tolerated cannot_verify per run). OLD = `src/gates.ts` at 62321c3, NEW = the working tree, both run with `evidenceMode: \"skip-quotes\"`, so only deterministic rules differ. The OLD side therefore already carries the 2026-10-14 rules; \"bad leads caught\" are leads the 62321c3 gates accepted and the new gates reject.", "");

lines.push("## Layer 1 - deterministic rules only (NEW `skip-quotes` vs OLD)", "");
lines.push("| set | scenario | arm | judged | accepted-before | accepted-after | bad leads caught (code) | good leads lost (code) | projected precision | leads with unverifiable rules |");
lines.push("|---|---|---|---:|---:|---:|---|---|---:|---:|");
for (const g of groups) {
  const rs = rows.filter((r) => groupKey(r) === g);
  const [set, scenario, arm] = g.split("/");
  const before = sum(rs, (r) => isAccepted(r.before));
  const after = sum(rs, (r) => isAccepted(r.after));
  const goodAfter = sum(rs, (r) => isAccepted(r.after) && r.good);
  lines.push(
    `| ${set} | ${scenario} | ${arm} | ${rs.length} | ${before} | ${after} | ${names(rs.filter((r) => !r.good && flipped(r)), true)} | ${names(rs.filter((r) => r.good && flipped(r)), true)} | ${after ? `${goodAfter}/${after} = ${(goodAfter / after).toFixed(2)}` : "n/a"} | ${sum(rs, (r) => r.unverifiable.length > 0)} |`,
  );
}

lines.push("", "Baseline precision (accepted-before, judged good): ");
for (const g of groups) {
  const rs = rows.filter((r) => groupKey(r) === g);
  const b = rs.filter((r) => isAccepted(r.before));
  lines.push(`- ${g}: ${b.filter((r) => r.good).length}/${b.length}`);
}

lines.push("", "### Named flips per rule (Layer 1)", "");
const flips = rows.filter(flipped);
const byCode = new Map<string, Row[]>();
for (const r of flips) byCode.set(codeOf(r.after), [...(byCode.get(codeOf(r.after)) ?? []), r]);
if (flips.length === 0) lines.push("- none");
for (const [c, rs] of [...byCode.entries()].sort()) {
  lines.push(`- \`${c}\` (${rs.length} lead-reps): ` + rs.map((r) => `${r.set}/${r.scenario}/${r.arm}/${r.rep} ${r.company} (${r.good ? "GOOD" : "bad"})`).join("; "));
}
const reverse = rows.filter((r) => !isAccepted(r.before) && isAccepted(r.after));
if (reverse.length) lines.push("", "Accepted only by NEW (old rejected; replay drift, not a rule change): " + reverse.map((r) => `${r.set}/${r.scenario}/${r.arm}/${r.rep} ${r.company}`).join("; "));
const oldRej = rows.filter((r) => !isAccepted(r.before) && !r.signalOnly);
if (oldRej.length) lines.push("", "Note: OLD replay already rejected (not accepted-before): " + oldRej.map((r) => `${r.set}/${r.scenario}/${r.arm}/${r.rep} ${r.company} [${codeOf(r.before)}]`).join("; "));

lines.push("", "### Unverifiable per lead (Layer 1)", "");
const wf = rows.filter((r) => r.signalOnly);
const ag = rows.filter((r) => !r.signalOnly);
lines.push(`- Workflow-arm leads (${wf.length}): signal-only rules ran; unverifiable: ${WF_UNVERIFIABLE.join("; ")}.`);
lines.push(`- Agent-arm leads (${ag.length}): all deterministic rules ran; unverifiable: ${ag[0]?.unverifiable[0] ?? "none"} (${sum(ag, (r) => r.unverifiable.length > 0)} leads).`);

// Layer 2
lines.push("", "## Layer 2 - would require evidence (leads accepted after Layer 1)", "");
lines.push("Counts leads that rest on an unquoted required gate boolean (or an unquoted HQ) and/or have no `signal_quote`. Under full enforcement these become `tier: \"candidate\"` (`unquoted_gate` / `unquoted_signal`); the simulation cannot say whether a fresh quote-enabled run would find a quote on the page.", "");
lines.push("| set | scenario | arm | accepted after L1 | no signal_quote | unquoted required gate / HQ | would become candidate | of which BAD (quote rule stops them) | of which GOOD (demoted pending a fresh run) |");
lines.push("|---|---|---|---:|---:|---:|---:|---|---|");
for (const g of groups) {
  const rs = rows.filter((r) => groupKey(r) === g && isAccepted(r.after));
  const [set, scenario, arm] = g.split("/");
  const cand = rs.filter((r) => r.noSignalQuote || r.unquotedGates.length > 0);
  lines.push(
    `| ${set} | ${scenario} | ${arm} | ${rs.length} | ${sum(rs, (r) => r.noSignalQuote)} | ${sum(rs, (r) => r.unquotedGates.length > 0)} | ${cand.length} | ${names(cand.filter((r) => !r.good), false)} | ${names(cand.filter((r) => r.good), false)} |`,
  );
}
const l2 = rows.filter((r) => isAccepted(r.after) && (r.noSignalQuote || r.unquotedGates.length > 0));
lines.push("", `Totals: ${l2.length} of ${sum(rows, (r) => isAccepted(r.after))} Layer-1-accepted lead-reps would be candidates; BAD ${sum(l2, (r) => !r.good)}, GOOD ${sum(l2, (r) => r.good)}.`);
lines.push(
  `Full-enforcement `+
    `verdict codes on agent-arm leads (NEW \`checkLead\`, default mode, no lookup text): ` +
    (() => {
      const c = new Map<string, number>();
      for (const r of ag) c.set(r.fullCode ?? "-", (c.get(r.fullCode ?? "-") ?? 0) + 1);
      return [...c.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
    })() + ".",
);
lines.push("Workflow-arm rows count as `no signal_quote` by construction (their run files carry no summary); their gate-quote status is unverifiable.");

const mustCatch = ["NXTPoint Logistics|snaprecruit", "Fetch Package|capitalfactory", "Port City Logistics|jobtarget"];
lines.push("", "## Required catches", "");
for (const m of mustCatch) {
  const [name, host] = m.split("|");
  const hit = rows.filter((r) => r.company.startsWith(name) && !r.good && flipped(r) && JSON.stringify(r).length > 0);
  lines.push(`- ${name} (${host}): ${hit.length ? "caught " + hit.map((r) => `${r.set}/${r.rep} [${codeOf(r.after)}]`).join(", ") : "NOT CAUGHT"}`);
}
lines.push("- Constellation Cold Logistics (bbc.co.uk news article): not a listing; q3=no because the event (council approval, early June 2026) predates the window and the BBC piece is a later report. NOT caught, and not catchable by a deterministic URL rule: the summary's event date (2026-08-27, the BBC piece) is inside the window; only the judge's fetch of other sources showed the underlying approval was early June. Judge-only failure.");
lines.push("", "## URL-shape rule on its own (independent of the domain list)", "");
lines.push("Every agent-arm lead-rep the shape rule (`isThirdPartyListing`: listing-shaped host/path, registrable domain differs from the lookup URL or lookup unknown) would reject, whichever rule fires first in `checkLead`:", "");
const shape = rows.filter((r) => r.shapeRule);
if (!shape.length) lines.push("- none");
for (const r of shape) lines.push(`- ${r.set}/${r.scenario}/${r.arm}/${r.rep} ${r.company} (${r.good ? "GOOD" : "bad"}): ${r.url}`);
const listingLike = rows.filter((r) => !r.signalOnly && !r.shapeRule && isListingUrl(r.url));
lines.push("", "Listing-shaped URLs the rule lets through (own domain): " + (listingLike.map((r) => `${r.set}/${r.rep} ${r.company} (${r.good ? "GOOD" : "bad"}) ${r.url}`).join("; ") || "none"));
const JAY_REASON = "Jay Group is lost by design: a single third-party job post (thejobsmap.com) is not counted by the rubric, which accepts a job post only on the company's own site or naming >=2 roles; its judge verdict was good only via the aggregator's \"More jobs at Jay Group\" list and carried a spot-check flag.";
const goodLost = rows.filter((r) => r.good && flipped(r));
lines.push("", `SUMMARY good leads lost: ${goodLost.length}${goodLost.length ? " -> " + goodLost.map((r) => `${r.set}/${r.rep} ${r.company}`).join("; ") : ""}`);
if (goodLost.length) lines.push(`SUMMARY reason: ${JAY_REASON}`);
lines.push(`SUMMARY bad leads newly caught: ${rows.filter((r) => !r.good && flipped(r)).length} of ${rows.filter((r) => !r.good && isAccepted(r.before)).length} bad lead-reps accepted before`);
writeFileSync(OUT, `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));
console.log(`\nwrote ${OUT}`);
