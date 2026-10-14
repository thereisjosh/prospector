/**
 * The judge-calibration sets (references/judge-calibration.md): the 10 human spot-checked
 * leads of eval/truth/SPOT-CHECKS.md, one dataset per online judge question.
 *
 * input          = the judge payload (src/agent/judge-input.ts) built from the pilot's blind
 *                  pool, i.e. exactly what the `lead-judge` observation carries in production
 *                  and what the evaluator's {{lead}} variable maps to, with `evidence` rebuilt
 *                  from the pilot's own artifacts (see `recoverEvidence`; nothing is invented:
 *                  what cannot be recovered stays empty and metadata.evidenceSource says why);
 * expectedOutput = the label in the judge's own vocabulary (yes / no / cannot_verify): the
 *                  per-question verdict in eval/truth/<scenario>/, which the author checked
 *                  against the source (SPOT-CHECKS: 10/10 agree after the v3 re-judge).
 * Q1 and Q3 were checked by the human explicitly; Q2 only as part of the verdict (the human
 * agreed with the verdict, nobody re-checked the headcount), which metadata records.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findVerdictFile } from "../harness/truth";
import type { BlindLead } from "../harness/blind";
import type { Verdict } from "../harness/types";
import { judgePayload } from "../../src/agent/judge-input";
import type { RunState } from "../../src/agent/state";
import { emptyJudgeEvidence, judgeEvidence, signalEvidence, type JudgeEvidence } from "../../src/evidence";
import type { ExaResult } from "../../src/types";
import type { JudgeAnswer, JudgeQuestion } from "./judge-prompt";

/** SPOT-CHECKS.md rows. `scenario` is where the lead and its verdict actually live (#7 Capacity LLC is an S1 lead; SPOT-CHECKS says S2). */
export const SPOT_CHECKS: Array<{ n: number; scenario: "S1" | "S2"; company: string; human: string }> = [
  { n: 1, scenario: "S1", company: "RGL Logistics", human: "article names RGL, 2026-10-05, 427,500 sq ft, lists 3PL services (fetched); drove the v3 fetch fix" },
  { n: 2, scenario: "S1", company: "Metropolitan Warehouse and Delivery", human: "2026-09-23 530,000 sq ft lease; white-glove logistics for customers (fetched)" },
  { n: 3, scenario: "S1", company: "Southern AG Carriers, Inc.", human: "terminal opening 2026-09-15, Albany GA (fetched)" },
  { n: 4, scenario: "S1", company: "Hollingsworth Logistics", human: "expansion article reachable; v3 fetched it" },
  { n: 5, scenario: "S1", company: "Away Team (Spreetail)", human: "Spreetail is a retailer running its own fulfilment; internal team; single-role aggregator post" },
  { n: 6, scenario: "S2", company: "Agave", human: "$15M Series A 2026-07-07; B2B (search corroboration)" },
  { n: 7, scenario: "S1", company: "Capacity LLC", human: "majority stake in Core Fulfilment 2026-10-08; NJ 3PL (search corroboration)" },
  { n: 8, scenario: "S2", company: "Healthleap", human: "$38M seed + Series A; sells to hospitals (search corroboration)" },
  { n: 9, scenario: "S2", company: "Sybill", human: "last round earlier and later-stage: fails the recent seed/Series A gate" },
  { n: 10, scenario: "S2", company: "Miter", human: "funding is later-stage, not a recent seed/A" },
];

export const CALIBRATION_SET = "pilot-2026-10-12";

export type CalibrationItem = {
  id: string;
  input: ReturnType<typeof judgePayload>;
  expectedOutput: JudgeAnswer;
  metadata: Record<string, unknown>;
};

const FIELD: Record<JudgeQuestion, "q1" | "q2" | "q3"> = { judge_q1: "q1", judge_q2: "q2", judge_q3: "q3" };

type MappingEntry = { id: string; company: string; signal_url: string; sources: Array<{ arm: string; rep: number; runId?: string }> };

/** Where a recovered item's evidence came from (metadata.evidenceSource). */
export type EvidenceSource =
  | { kind: "agent_state"; path: string }
  | { kind: "exa_recording"; path: string; lookup: "not_recorded" }
  | { kind: "none"; why: string };

/**
 * The evidence the gate had for a pilot lead, from the pilot's own artifacts:
 *  - agent-arm leads: the rep's state.json — the accepted lead's `enrichment` + `details`, and
 *    the signal's title / publishedDate / text from `caches.signalsByUrl` (what search_signals,
 *    or a later read_page, stored for that URL), through the same builder the submit path uses;
 *  - workflow-arm leads: the pilot workflow cells were not recorded, so the signal comes from an
 *    Exa search recording (eval/recordings/*) that returned the same URL, read as the workflow
 *    gate reads it (text + highlights). Its company lookup was not recorded under the lead's
 *    name, so company_lookup and gate_result stay null;
 *  - otherwise empty evidence, with the reason.
 */
export function recoverEvidence(scenario: string, lead: Pick<BlindLead, "company" | "signal_url" | "why_now">, root = process.cwd()): { evidence: JudgeEvidence; source: EvidenceSource } {
  const dir = join(root, "eval/results", CALIBRATION_SET, scenario);
  const mapping = JSON.parse(readFileSync(join(dir, "mapping.json"), "utf8")) as MappingEntry[];
  const entry = mapping.find((m) => m.company === lead.company && m.signal_url === lead.signal_url);
  for (const src of entry?.sources ?? []) {
    if (!src.runId) continue;
    const rel = join("eval/results", CALIBRATION_SET, scenario, src.arm, String(src.rep), "state.json");
    if (!existsSync(join(root, rel))) continue;
    const state = JSON.parse(readFileSync(join(root, rel), "utf8")) as RunState;
    const accepted = state.leads.find((l) => l.company === lead.company && l.signal_url === lead.signal_url);
    const signal = state.caches?.signalsByUrl?.[lead.signal_url];
    if (!accepted || !signal) continue;
    return {
      evidence: judgeEvidence({ signal: accepted.evidence ?? signalEvidence(signal, accepted.company, accepted.why_now), enrichment: accepted.enrichment, details: accepted.details }),
      source: { kind: "agent_state", path: rel },
    };
  }
  const recordings = join(root, "eval/recordings");
  const runs = existsSync(recordings) ? readdirSync(recordings, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  for (const run of runs) {
    const runDir = join(recordings, run);
    for (const file of readdirSync(runDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).sort()) {
      const rec = JSON.parse(readFileSync(join(runDir, file), "utf8")) as { response?: { results?: ExaResult[] } };
      const hit = rec.response?.results?.find((r) => r.url === lead.signal_url && (r.text || r.highlights?.length));
      if (!hit) continue;
      const text = [hit.text, hit.highlights?.join(" ")].filter(Boolean).join(" ");
      return {
        evidence: judgeEvidence({ signal: signalEvidence({ title: hit.title, publishedDate: hit.publishedDate, text }, lead.company, lead.why_now) }),
        source: { kind: "exa_recording", path: `eval/recordings/${run}/${file}`, lookup: "not_recorded" },
      };
    }
  }
  return { evidence: emptyJudgeEvidence(), source: { kind: "none", why: "workflow-arm lead: the pilot workflow cells were not Exa-recorded and no recording under eval/recordings returned this signal URL" } };
}

export function calibrationDatasetName(question: JudgeQuestion): string {
  return `judge-calibration/${question}`;
}

export function calibrationItems(question: JudgeQuestion, root = process.cwd()): CalibrationItem[] {
  const blind = new Map<string, BlindLead[]>();
  const pool = (scenario: string) => {
    if (!blind.has(scenario)) blind.set(scenario, JSON.parse(readFileSync(join(root, "eval/results", CALIBRATION_SET, scenario, "blind.json"), "utf8")) as BlindLead[]);
    return blind.get(scenario)!;
  };
  return SPOT_CHECKS.map((row) => {
    const lead = pool(row.scenario).find((l) => l.company === row.company);
    if (!lead) throw new Error(`calibration: ${row.company} not in ${row.scenario}/blind.json`);
    const file = findVerdictFile(join(root, "eval/truth", row.scenario), lead.company, lead.signal_url);
    if (!file) throw new Error(`calibration: no verdict for ${row.company}`);
    const verdict = JSON.parse(readFileSync(file, "utf8")) as Verdict;
    const field = FIELD[question];
    const { evidence, source } = recoverEvidence(row.scenario, lead, root);
    return {
      id: `${question}-spot-${String(row.n).padStart(2, "0")}`,
      input: judgePayload({ ...lead, evidence }),
      expectedOutput: verdict[field],
      metadata: {
        spotCheck: row.n,
        scenario: row.scenario,
        company: lead.company,
        human: row.human,
        labelSource: field === "q2" ? "judge verdict confirmed by the author at verdict level (headcount not re-checked)" : "author spot-check against the source (SPOT-CHECKS.md)",
        offlineJudgeVersion: verdict.judgeVersion ?? "v2",
        source: `eval/truth/${row.scenario}/${file.split("/").pop()}`,
        evidenceSource: source,
      },
    };
  });
}
