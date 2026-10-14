import { windowStartIso } from "../gates";
import type { SearchPlan } from "../plan";
import type { AcceptedLead } from "./state";

/**
 * The exact data a lead judge sees (RUBRIC §1), shared by the offline Opus judge
 * (eval/harness/judge.ts `userPrompt`) and the managed online evaluators in Langfuse
 * (the `lead-judge` observation's input). One builder, so offline and online verdicts
 * are about the same facts.
 */

/** What the judge needs to check Q1/Q2/Q3. Identical for every arm, so it never identifies one. */
export type JudgeContract = {
  who: string[];
  size_band: string;
  hq_countries: string[];
  recency_months: number;
  window: string;
};

/** A lead as the judge sees it: why_now ≤ 200 chars, size_basis "quoted" | "unverified". */
export type JudgeLead = {
  company: string;
  signal_url: string;
  why_now: string;
  event_date: string;
  size_basis: string;
};

export type JudgePayload = {
  company: string;
  signal_url: string;
  why_now: string;
  contract?: JudgeContract;
  contract_summary: { event_date: string; size_basis: string };
};

const WHY_NOW_MAX = 200;

export function judgeContractFromPlan(plan: Pick<SearchPlan, "gateFields" | "employeeRange" | "hqCountries" | "months">, now: Date): JudgeContract {
  return {
    who: plan.gateFields.filter((g) => g.required).map((g) => g.question),
    size_band: `${plan.employeeRange.min}–${plan.employeeRange.max} employees`,
    hq_countries: plan.hqCountries,
    recency_months: plan.months,
    window: `${windowStartIso(plan.months, now).slice(0, 10)}..${now.toISOString().slice(0, 10)}`,
  };
}

/** Both arms emit the same normalised fields (eval/harness/run-cell.ts). */
export function normalizeJudgeLead(fields: JudgeLead): JudgeLead {
  return {
    company: fields.company,
    signal_url: fields.signal_url,
    why_now: fields.why_now.trim().slice(0, WHY_NOW_MAX),
    event_date: fields.event_date,
    size_basis: fields.size_basis === "quoted" ? "quoted" : "unverified",
  };
}

/** An agent run's accepted lead → the judge's view of it. */
export function judgeLeadFromState(lead: Pick<AcceptedLead, "company" | "signal_url" | "why_now" | "details">): JudgeLead {
  const details = lead.details as { event_date?: unknown; size_basis?: unknown };
  return normalizeJudgeLead({
    company: lead.company,
    signal_url: lead.signal_url,
    why_now: lead.why_now,
    event_date: typeof details.event_date === "string" ? details.event_date : "",
    size_basis: typeof details.size_basis === "string" ? details.size_basis : "unverified",
  });
}

/** The JSON object the judge is given (key order is part of the contract: the offline prompt is its pretty-print). */
export function judgePayload(lead: JudgeLead & { contract?: JudgeContract }): JudgePayload {
  return {
    company: lead.company,
    signal_url: lead.signal_url,
    why_now: lead.why_now,
    ...(lead.contract ? { contract: lead.contract } : {}),
    contract_summary: {
      event_date: lead.event_date,
      size_basis: lead.size_basis,
    },
  };
}
