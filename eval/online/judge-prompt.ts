/**
 * The managed online lead judges (Langfuse LLM-as-a-judge evaluators judge_q1, judge_q2,
 * judge_q3), as code: one evaluator per RUBRIC §1 question, each writing the same score name
 * and vocabulary (yes / no / cannot_verify) as the offline Opus judge (eval/harness/judge.ts).
 *
 * The evaluator sees one observation: the `lead-judge` observation whose input is the judge
 * payload (src/agent/judge-input.ts), the exact object the offline judge reads. Unlike the
 * offline judge it has no web_fetch or web_search, so its job is narrower: is the agent's claim
 * supported by the evidence attached to the lead (`evidence`: the signal page excerpt, the
 * company lookup and the gate result the code accepted the lead on; src/evidence.ts)? It answers
 * cannot_verify only when that evidence is silent on the question. The offline judge, which also
 * verifies on the live web, stays the authority for experiment numbers (RUBRIC change log 2026-10-14).
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
- "yes" when evidence.company_lookup.description / industry or evidence.signal_excerpt describe the company's primary activity and it meets every question in contract.who. A name such as "X Logistics" alone is not enough, and neither is a gate_fields value alone.
- "no" when the evidence, or a fact about this company you know with certainty, contradicts contract.who. Typical cases: a brand or retailer running its own warehouses or fulfilment when the contract asks for a provider of services to other businesses; an internal team or division named as if it were a company; a company whose funding history contradicts a "recently raised seed or Series A" requirement (for example, it raised later-stage rounds earlier).
- "cannot_verify" only when the evidence does not say what the company does.`,
  judge_q2: `Q2 rules:
- "yes" when a headcount or employee range in the evidence lies inside contract.size_band or within 25% of a boundary: evidence.company_lookup.employee_estimate backed by the phrase quoted in employee_estimate_source, or a figure stated in signal_excerpt.
- "no" when the evidence shows the company is clearly outside the band (a quoted headcount far outside it, or a public enterprise with thousands of employees for a 50–500 band), or a fact you know with certainty does.
- An employee_estimate with an empty employee_estimate_source is the lookup's unquoted guess, and contract_summary.size_basis is only the agent's label: neither is enough for "yes" on its own.
- "cannot_verify" only when the evidence holds no headcount for this company.`,
  judge_q3: `Q3 rules:
- evidence.signal_excerpt is the signal page's text as it loaded during the run (up to 1,500 characters around the company's mention); treat it as the page at signal_url.
- "yes" when signal_title or signal_excerpt names this company, the excerpt describes the claimed event as a concrete event of a kind the rubric lists (facility, funding, hiring wave, launch), and the event's date (stated in the excerpt, else contract_summary.event_date when it agrees with the excerpt and signal_published_date) is inside contract.window. A job post counts only if it is on the company's own site or names at least 2 roles.
- "no" when the evidence shows the signal fails the rubric: the event date is empty or outside contract.window; the excerpt or why_now is about a different company or describes no concrete event; the signal is a job post that is not on the company's own site and names fewer than 2 roles (for example a single job on a job board such as a /jobs/view/<id> page); or the page plainly has nothing to do with the company.
- "cannot_verify" only when signal_excerpt is empty or stops before the event is described.`,
};

/** The user message for one question; `{{lead}}` is the only variable. */
export function judgeUserPrompt(question: JudgeQuestion): string {
  return `You are one of three online judges for a B2B prospecting agent. The agent accepted the lead below. Answer only ${TITLES[question]} Use RUBRIC §1 in the system message.

<lead>
{{${LEAD_VARIABLE}}}
</lead>

The lead JSON holds: company; signal_url (the page the agent cites for the why-now); why_now (the agent's claim, at most 200 characters); contract (who: the required gate questions; size_band; hq_countries; recency_months; window: the allowed event-date range, YYYY-MM-DD..YYYY-MM-DD); contract_summary (event_date: the event date the agent recorded; size_basis: "quoted" or "unverified"); evidence, what the agent's code had when it accepted the lead: signal_title and signal_published_date (as the search engine returned them), signal_excerpt (the signal page's text), company_lookup (the company profile the lookup returned: description, industry, hq, employee_estimate, employee_estimate_source = the phrase the estimate was quoted from, is_public_or_enterprise, gate_fields = the lookup's yes/no answers to the contract's gate questions) and gate_result (the deterministic checks the lead passed). An empty string or null means that part was not captured.

Your task is to decide whether the agent's claim is supported by this evidence. You cannot open signal_url or search the web, so the evidence is your source: RUBRIC §1's cited source is the evidence field you quote. gate_fields and gate_result are the agent's own classifications: check them against description and signal_excerpt rather than taking them as proof. Never answer "yes" because a lead sounds plausible, and never answer "no" on a hunch; answer "cannot_verify" only when the evidence is silent on the question.

${RULES[question]}

Reason first: quote the evidence field(s) you rely on (or name a fact you know with certainty: "own knowledge: …"), then give the verdict.`;
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
    scoreReasoningInstructions: `Quote the evidence field(s) or the certain fact you rely on, then say why it settles ${question.replace("judge_", "").toUpperCase()}.`,
    scoreValueInstructions: `Exactly one of yes, no, cannot_verify, following the ${question.replace("judge_", "").toUpperCase()} rules.`,
  };
}

/** Insert the lead JSON the way Langfuse renders an object variable (pretty JSON). */
export function compileJudgeMessages(question: JudgeQuestion, rubric: string, lead: unknown) {
  return judgeMessages(question, rubric).map((m) => ({ ...m, content: m.content.split(`{{${LEAD_VARIABLE}}}`).join(JSON.stringify(lead, null, 2)) }));
}
