/**
 * TypeSafe AI "Jev" adapter (docs/RESEARCH-jev.md). Jev is a discriminative System One model: one state
 * (text or JSON) plus typed questions in, typed answers (choice / noul / score) out. It writes no text,
 * calls no tools and cannot browse, so it can only JUDGE evidence the code already holds. It cannot
 * produce the quotes our gates require.
 *
 * Wire format (https://docs.typesafe.ai/api.md, /introduction/quickstart.md):
 *   POST {baseUrl}/v1/systemone   Authorization: Bearer <key>   Content-Type: application/json
 *   { state, model, questions: { <id>: { type, instructions, criteria? } } }
 *   -> { model, answers: { <id>: choice | noul | score answer }, usage: { input_tokens, output_tokens } }
 * Billing: input tokens only, $42 per billion (https://docs.typesafe.ai/models.md).
 *
 * No key, no call: a missing key is a JevConfigError, never a fallback to another judge.
 */
import { judgeQuestionText, JUDGE_CATEGORIES, type JudgeAnswer } from "../../eval/online/judge-prompt";
import type { JudgePayload } from "../agent/judge-input";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** A versioned id, not the `jev-latest` alias: aliases move when a release ships (docs.typesafe.ai/models.md), which would change calibration results between rounds. */
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
/** $42 per billion input tokens; output tokens are free. */
export const JEV_DOLLARS_PER_INPUT_TOKEN = 42 / 1_000_000_000;

export type JevChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type JevNoulQuestion = { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type JevScoreQuestion = { type: "score"; instructions: unknown; criteria: unknown[] };
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export type JevChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevScoreAnswer = { type: "score"; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number };
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export type JevUsage = { input_tokens: number; output_tokens: number };
export type JevResult = { model: string; answers: Record<string, JevAnswer>; usage: JevUsage; costDollars: number };

export type JevOptions = {
  /** Default: process.env.JEV_API_KEY. */
  apiKey?: string;
  /** Default: process.env.JEV_BASE_URL, else https://api.typesafe.ai. */
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  /** Retries on 429 / 529 (the docs say to back off); default 3. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class JevConfigError extends Error {}
export class JevApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class JevResponseError extends Error {}

export function jevCostDollars(inputTokens: number): number {
  return inputTokens * JEV_DOLLARS_PER_INPUT_TOKEN;
}

export function requireJevKey(apiKey = process.env.JEV_API_KEY): string {
  if (!apiKey || !apiKey.trim()) throw new JevConfigError("JEV_API_KEY is not set: the Jev judge does not run without a key (get one at https://console.typesafe.ai/keys). It never falls back to another judge.");
  return apiKey.trim();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isProbMap = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every(isProb);

function parseAnswer(id: string, expected: JevQuestion["type"], raw: unknown): JevAnswer {
  const bad = (why: string) => new JevResponseError(`Jev answer "${id}": ${why}`);
  if (!isRecord(raw)) throw bad("not an object");
  if (raw.type !== expected) throw bad(`type ${JSON.stringify(raw.type)}, expected ${expected}`);
  if (expected === "noul") {
    if (!isProb(raw.noul)) throw bad("noul is not a number in [0,1]");
    return { type: "noul", noul: raw.noul };
  }
  if (!isProbMap(raw.probabilities) || !isProb(raw.confidence)) throw bad("probabilities / confidence missing or out of range");
  if (expected === "choice") {
    if (typeof raw.choice !== "string" || !(raw.choice in raw.probabilities)) throw bad("choice is not one of the probabilities' options");
    return { type: "choice", choice: raw.choice, probabilities: raw.probabilities, confidence: raw.confidence };
  }
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) throw bad("score is not a number");
  return { type: "score", score: raw.score, legend: isRecord(raw.legend) ? raw.legend : {}, probabilities: raw.probabilities, confidence: raw.confidence };
}

/** One Jev call: one state, many questions (answered in parallel server-side; the state is billed once). */
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, opts: JevOptions = {}): Promise<JevResult> {
  const apiKey = requireJevKey(opts.apiKey);
  if (Object.keys(questions).length === 0) throw new JevConfigError("jevAsk needs at least one question");
  const baseUrl = (opts.baseUrl ?? (process.env.JEV_BASE_URL?.trim() || JEV_DEFAULT_BASE_URL)).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;
  const body = JSON.stringify({ state, model: opts.model ?? JEV_DEFAULT_MODEL, questions });
  for (let attempt = 0; ; attempt += 1) {
    const response = await doFetch(`${baseUrl}/v1/systemone`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body });
    const text = await response.text();
    if ((response.status === 429 || response.status === 529) && attempt < maxRetries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new JevApiError(response.status, `Jev HTTP ${response.status}: ${text.replace(apiKey, "[key]").slice(0, 500)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new JevResponseError(`Jev returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!isRecord(json) || !isRecord(json.answers) || !isRecord(json.usage)) throw new JevResponseError("Jev response lacks answers / usage");
    const inputTokens = json.usage.input_tokens;
    const outputTokens = json.usage.output_tokens;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number") throw new JevResponseError("Jev usage lacks input_tokens / output_tokens");
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (!(id in json.answers)) throw new JevResponseError(`Jev response has no answer for question "${id}"`);
      answers[id] = parseAnswer(id, q.type, json.answers[id]);
    }
    return { model: typeof json.model === "string" ? json.model : "", answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, costDollars: jevCostDollars(inputTokens) };
  }
}

// --- lead judge: evidence-only Q1/Q2/Q3 -------------------------------------------------------

export type LeadQuestionId = "q1" | "q2" | "q3";
export const LEAD_QUESTION_IDS: LeadQuestionId[] = ["q1", "q2", "q3"];

const CRITERIA: Record<JudgeAnswer, string> = {
  yes: "The evidence supports the agent's claim for this question.",
  no: "The evidence, or a fact known with certainty, contradicts the claim or shows it fails the rubric.",
  cannot_verify: "The evidence is silent on this question.",
};

/** The Choice question for one lead-judge question: same vocabulary and rules as the Langfuse evaluators (eval/online/judge-prompt.ts). */
export function leadChoiceQuestion(id: LeadQuestionId): JevChoiceQuestion {
  const { title, rules } = judgeQuestionText(`judge_${id}` as "judge_q1");
  return {
    type: "choice",
    instructions: {
      task: `${title} Decide whether the agent's claim is supported by the evidence in the state. You cannot open signal_url or search the web, so the evidence object is your only source. gate_fields and gate_result are the agent's own classifications: check them against description and signal_excerpt rather than taking them as proof. Never answer yes because a lead sounds plausible, and never answer no on a hunch; answer cannot_verify only when the evidence is silent on the question.`,
      rules,
    },
    criteria: { ...CRITERIA },
  };
}

export type JevLeadVerdict = {
  q1: JudgeAnswer | null;
  q2: JudgeAnswer | null;
  q3: JudgeAnswer | null;
  /** Per question: probability of each of yes / no / cannot_verify. */
  probabilities: Partial<Record<LeadQuestionId, Record<string, number>>>;
  confidence: Partial<Record<LeadQuestionId, number>>;
  costDollars: number;
  inputTokens: number;
  model: string;
};

/** Evidence-only lead judge. `only` limits the questions asked (calibration asks one per dataset); the others come back null. */
export async function jevLeadJudge(payload: JudgePayload, opts: JevOptions & { only?: LeadQuestionId[] } = {}): Promise<JevLeadVerdict> {
  const asked = opts.only ?? LEAD_QUESTION_IDS;
  const questions = Object.fromEntries(asked.map((id) => [id, leadChoiceQuestion(id)]));
  const result = await jevAsk(payload, questions, opts);
  const verdict: JevLeadVerdict = { q1: null, q2: null, q3: null, probabilities: {}, confidence: {}, costDollars: result.costDollars, inputTokens: result.usage.input_tokens, model: result.model };
  for (const id of asked) {
    const a = result.answers[id] as JevChoiceAnswer;
    if (!(JUDGE_CATEGORIES as readonly string[]).includes(a.choice)) throw new JevResponseError(`Jev answered "${a.choice}" for ${id}, not one of ${JUDGE_CATEGORIES.join(" / ")}`);
    verdict[id] = a.choice as JudgeAnswer;
    verdict.probabilities[id] = a.probabilities;
    verdict.confidence[id] = a.confidence;
  }
  return verdict;
}

// --- contact: is this person currently in this role on this page ------------------------------

export type JevContactVerdict = { pFound: number; costDollars: number; inputTokens: number; model: string };

/** Noul over the page text plus the candidate. High = the page shows the person currently holds the role. */
export async function jevContactCurrent(
  pageText: string,
  name: string,
  title: string,
  company: string,
  opts: JevOptions & { pageUrl?: string; pageDate?: string } = {},
): Promise<JevContactVerdict> {
  const state = { page: { ...(opts.pageUrl ? { url: opts.pageUrl } : {}), ...(opts.pageDate ? { published: opts.pageDate } : {}), text: pageText }, candidate: { name, title, company } };
  const result = await jevAsk(
    state,
    {
      current: {
        type: "noul",
        instructions: `Does the page show that ${name} currently holds the role ${title} (or a title with the same function and seniority) at ${company}? Judge from the page text only.`,
        criteria: {
          true: "The page names this person in this role at this company as a present-tense fact: a current team or leadership page, or a recent dated announcement with no later change.",
          false: "The page says the person left, is a former holder, or holds a clearly different role; or it is an old dated item (more than 18 months) with nothing showing the role is still current; or it does not mention the person at this company.",
        },
      },
    },
    opts,
  );
  return { pFound: (result.answers.current as JevNoulAnswer).noul, costDollars: result.costDollars, inputTokens: result.usage.input_tokens, model: result.model };
}

/** The yes / no / cannot_verify the contact judge uses, from a noul. Thresholds are the docs' example values (0.8 / 0.2), NOT calibrated on our data. */
export const JEV_CONTACT_YES = 0.8;
export const JEV_CONTACT_NO = 0.2;
export function contactAnswerFromNoul(p: number): JudgeAnswer {
  return p >= JEV_CONTACT_YES ? "yes" : p <= JEV_CONTACT_NO ? "no" : "cannot_verify";
}
