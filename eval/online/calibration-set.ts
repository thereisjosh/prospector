/**
 * The judge-calibration sets (references/judge-calibration.md): the 10 human spot-checked
 * leads of eval/truth/SPOT-CHECKS.md, one dataset per online judge question.
 *
 * input          = the judge payload (src/agent/judge-input.ts) built from the pilot's blind
 *                  pool, i.e. exactly what the `lead-judge` observation carries in production
 *                  and what the evaluator's {{lead}} variable maps to;
 * expectedOutput = the label in the judge's own vocabulary (yes / no / cannot_verify): the
 *                  per-question verdict in eval/truth/<scenario>/, which the author checked
 *                  against the source (SPOT-CHECKS: 10/10 agree after the v3 re-judge).
 * Q1 and Q3 were checked by the human explicitly; Q2 only as part of the verdict (the human
 * agreed with the verdict, nobody re-checked the headcount), which metadata records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findVerdictFile } from "../harness/truth";
import type { BlindLead } from "../harness/blind";
import type { Verdict } from "../harness/types";
import { judgePayload } from "../../src/agent/judge-input";
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
    return {
      id: `${question}-spot-${String(row.n).padStart(2, "0")}`,
      input: judgePayload(lead),
      expectedOutput: verdict[field],
      metadata: {
        spotCheck: row.n,
        scenario: row.scenario,
        company: lead.company,
        human: row.human,
        labelSource: field === "q2" ? "judge verdict confirmed by the author at verdict level (headcount not re-checked)" : "author spot-check against the source (SPOT-CHECKS.md)",
        offlineJudgeVersion: verdict.judgeVersion ?? "v2",
        source: `eval/truth/${row.scenario}/${file.split("/").pop()}`,
      },
    };
  });
}
