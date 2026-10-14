/**
 * The managed online lead judges (Langfuse LLM-as-a-judge evaluators judge_q1, judge_q2,
 * judge_q3), as code: one evaluator per RUBRIC §1 question, each writing the same score name
 * and vocabulary (yes / no / cannot_verify) as the offline Opus judge (eval/harness/judge.ts).
 *
 * The evaluator sees one observation: the `lead-judge` observation whose input is the judge
 * payload (src/agent/judge-input.ts), the exact object the offline judge reads. Unlike the
 * offline judge it has no web_fetch or web_search, so it can settle a question only from that
 * JSON and facts it knows with certainty. RUBRIC Q3 "yes" requires the signal page to load,
 * so the online Q3 can never be "yes": the online judge is a detector of leads that are
 * definitely NOT good, and the offline judge stays the authority for experiment numbers.
 */

export type JudgeQuestion = "judge_q1" | "judge_q2" | "judge_q3";

export const JUDGE_QUESTIONS: JudgeQuestion[] = ["judge_q1", "judge_q2", "judge_q3"];

export const JUDGE_CATEGORIES = ["yes", "no", "cannot_verify"] as const;
export type JudgeAnswer = (typeof JUDGE_CATEGORIES)[number];

/** Same model as the offline judge, so calibration and offline/online comparisons share a model. */
export const JUDGE_MODEL = { provider: "anthropic", model: "claude-opus-5-5" } as const;

/** The prompt variable mapped to the observation input. */
export const LEAD_VARIABLE = "lead";

const TITLES: Record<JudgeQuestion, string> = {
  judge_q1: "Q1 Fit: is the company the kind the contract asked for?",
  judge_q2: "Q2 Size: is the company inside the size band?",
  judge_q3: "Q3 Signal: is the why-now real, specific and inside the window?",
};

const RULES: Record<JudgeQuestion, string> = {
  judge_q1: `Q1 rules:
- "yes" only when you know with certainty that the company's primary activity meets every question in contract.who (for example, a company you know to be a third-party logistics provider, for a contract that asks for logistics service providers). A name such as "X Logistics" alone is not enough.
- "no" when the lead JSON or a fact you are sure of contradicts contract.who. Typical cases: a brand or retailer running its own warehouses or fulfilment when the contract asks for a provider of services to other businesses; an internal team or division named as if it were a company; a company whose known funding history contradicts a "recently raised seed or Series A" requirement (for example, it raised later-stage rounds earlier).
- otherwise "cannot_verify".`,
  judge_q2: `Q2 rules:
- "yes" only when you know with certainty a headcount or employee range for this company that lies inside contract.size_band, or within 25% of a boundary.
- "no" when you know with certainty that it is clearly outside the band (for example, a public enterprise with thousands of employees for a 50–500 band).
- contract_summary.size_basis "quoted" is the agent's claim that some page quoted a headcount; the number is not in the JSON, so on its own it is not evidence: answer "cannot_verify".
- otherwise "cannot_verify".`,
  judge_q3: `Q3 rules:
- You cannot load signal_url, and RUBRIC Q3 "yes" requires that the signal page loads and describes the event. So never answer "yes".
- "no" when the lead JSON itself shows the signal fails the rubric: contract_summary.event_date is empty or outside contract.window; why_now names a different company or describes no concrete event of the kinds the rubric lists (facility, funding, hiring wave, launch); the signal is a job post that is not on the company's own site and names fewer than 2 roles (for example a single job on a job board such as a /jobs/view/<id> page); or signal_url plainly has nothing to do with the company.
- otherwise "cannot_verify".`,
};

/** The user message for one question; `{{lead}}` is the only variable. */
export function judgeUserPrompt(question: JudgeQuestion): string {
  return `You are one of three online judges for a B2B prospecting agent. The agent accepted the lead below. Answer only ${TITLES[question]} Use RUBRIC §1 in the system message.

<lead>
{{${LEAD_VARIABLE}}}
</lead>

The lead JSON holds: company; signal_url (the page the agent cites for the why-now); why_now (the agent's claim, at most 200 characters); contract (who: the required gate questions; size_band; hq_countries; recency_months; window: the allowed event-date range, YYYY-MM-DD..YYYY-MM-DD); contract_summary (event_date: the event date the agent recorded; size_basis: "quoted" or "unverified").

You cannot open signal_url, search the web, or see the agent's other steps. RUBRIC §1 asks for a cited source for every answer; here your only sources are the lead JSON and facts about this company you know with certainty. Never answer "yes" because a lead sounds plausible, and never answer "no" on a hunch: when the evidence the rubric asks for is not in front of you, the answer is "cannot_verify".

${RULES[question]}

Reason first: quote the lead field(s) you rely on, or name the fact you know ("own knowledge: …"), then give the verdict.`;
}

/** Chat prompt for the evaluator / the calibration prompt: system = the frozen rubric (as the offline judge), user = the question. */
export function judgeMessages(question: JudgeQuestion, rubric: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: rubric },
    { role: "user", content: judgeUserPrompt(question) },
  ];
}

export function judgeOutputDefinition(question: JudgeQuestion) {
  return {
    dataType: "CATEGORICAL" as const,
    categories: [...JUDGE_CATEGORIES],
    shouldAllowMultipleMatches: false,
    scoreReasoningInstructions: `Quote the lead field(s) or the certain fact you rely on, then say why it settles ${question.replace("judge_", "").toUpperCase()}.`,
    scoreValueInstructions: `Exactly one of yes, no, cannot_verify, following the ${question.replace("judge_", "").toUpperCase()} rules.`,
  };
}

/** Insert the lead JSON the way Langfuse renders an object variable (pretty JSON). */
export function compileJudgeMessages(question: JudgeQuestion, rubric: string, lead: unknown) {
  return judgeMessages(question, rubric).map((m) => ({ ...m, content: m.content.split(`{{${LEAD_VARIABLE}}}`).join(JSON.stringify(lead, null, 2)) }));
}
