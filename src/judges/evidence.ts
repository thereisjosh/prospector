/**
 * Evidence-only lead judge for any provider (the online judges' job: is the agent's claim supported by the
 * evidence attached to the lead? No web access). The prompt is exactly the online evaluators' text,
 * eval/online/judge-prompt.ts compileJudgeMessages (system = eval/RUBRIC.md, user = the question with the lead
 * JSON), and the answer comes back the way eval/online/calibrate-judge.ts judgeOnce asks for it: one `verdict`
 * tool call with reasoning + score, no forced tool_choice (claude-opus-5-5 rejects it; Kimi K2.6 in thinking
 * mode accepts only auto/none).
 *
 * The client comes from the provider factory (src/agent/providers.ts): Anthropic ids -> new Anthropic(),
 * kimi-k2.6 -> Moonshot's Anthropic-compatible endpoint. A missing key throws; there is no fallback model.
 */
import { readFileSync } from "node:fs";
import { AGENT_MODELS, claudeCostDollars, providerOf, type AgentModel } from "../agent/config";
import type { JudgePayload } from "../agent/judge-input";
import { createModelClient, type ModelClient } from "../agent/providers";
import { compileJudgeMessages, JUDGE_CATEGORIES, JUDGE_QUESTIONS, judgeOutputDefinition, type JudgeAnswer, type JudgeQuestion } from "../../eval/online/judge-prompt";

export type EvidenceJudgeModel = "opus" | "sonnet" | "kimi";

export const EVIDENCE_JUDGE_MODEL_IDS: Record<EvidenceJudgeModel, AgentModel> = { opus: AGENT_MODELS.opus, sonnet: AGENT_MODELS.sonnet, kimi: AGENT_MODELS.kimi };

/**
 * Output budget per verdict. Claude: calibrate-judge.ts MAX_OUTPUT_TOKENS (1000). Kimi K2.6 thinks by default
 * and its reasoning counts against max_tokens (docs/api/messages: output_tokens "includes reasoning tokens"),
 * so it gets 4000; at $4/M that bounds a call's output at $0.016.
 */
export function maxOutputTokens(model: AgentModel): number {
  return providerOf(model) === "kimi" ? 4000 : 1000;
}

export const VERDICT_INSTRUCTION = "Answer by calling the `verdict` tool exactly once.";

export function verdictTool(question: JudgeQuestion) {
  const def = judgeOutputDefinition(question);
  return {
    name: "verdict",
    description: "Record the verdict.",
    input_schema: {
      type: "object" as const,
      properties: {
        reasoning: { type: "string", description: def.scoreReasoningInstructions },
        score: { type: "string", enum: [...JUDGE_CATEGORIES], description: def.scoreValueInstructions },
      },
      required: ["reasoning", "score"],
    },
  };
}

export type EvidenceAnswer = { score: JudgeAnswer | "invalid"; reasoning: string; costDollars: number; usage: Record<string, number> };

type Message = { role: "system" | "user"; content: string };

/** One question, one call. `messages` overrides the compiled repo prompt (e.g. a Langfuse prompt version). */
export async function evidenceJudgeQuestion(
  client: ModelClient,
  model: AgentModel,
  question: JudgeQuestion,
  messages: Message[],
): Promise<EvidenceAnswer> {
  const system = messages.find((m) => m.role === "system")?.content;
  const response = (await client.messages.create({
    model,
    max_tokens: maxOutputTokens(model),
    ...(system ? { system } : {}),
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m, i, all) => ({ role: "user" as const, content: i === all.length - 1 ? `${m.content}\n\n${VERDICT_INSTRUCTION}` : m.content })),
    tools: [verdictTool(question)],
  } as never)) as unknown as { content?: Array<{ type: string; text?: string; input?: { score?: unknown; reasoning?: unknown } }>; usage?: Record<string, number>; stop_reason?: unknown };
  const usage = response.usage ?? {};
  const costDollars = claudeCostDollars(model, usage);
  const content = Array.isArray(response.content) ? response.content : [];
  const block = content.find((b) => b.type === "tool_use");
  if (!block) {
    const text = content.find((b) => b.type === "text")?.text ?? "";
    return { score: "invalid", reasoning: `no verdict tool call (stop_reason ${String(response.stop_reason)}): ${text.slice(0, 500)}`, costDollars, usage };
  }
  const score = (JUDGE_CATEGORIES as readonly string[]).includes(String(block.input?.score)) ? (block.input!.score as JudgeAnswer) : "invalid";
  return { score, reasoning: String(block.input?.reasoning ?? ""), costDollars, usage };
}

export type EvidenceJudgeOptions = {
  model: EvidenceJudgeModel | AgentModel;
  /** Default: all three (judge_q1..q3). */
  questions?: JudgeQuestion[];
  /** Default: eval/RUBRIC.md. */
  rubric?: string;
  /** Default: createModelClient(model). */
  client?: ModelClient;
};

export type EvidenceVerdict = {
  model: AgentModel;
  answers: Partial<Record<JudgeQuestion, EvidenceAnswer>>;
  costDollars: number;
};

export function resolveEvidenceModel(model: EvidenceJudgeModel | AgentModel): AgentModel {
  return (EVIDENCE_JUDGE_MODEL_IDS as Record<string, AgentModel>)[model] ?? (model as AgentModel);
}

/** yes / no / cannot_verify (or "invalid" when the model did not call the verdict tool) per question. */
export async function evidenceJudge(payload: JudgePayload, options: EvidenceJudgeOptions): Promise<EvidenceVerdict> {
  const model = resolveEvidenceModel(options.model);
  providerOf(model); // throws on an unknown id before any call
  const client = options.client ?? createModelClient(model);
  const rubric = options.rubric ?? readFileSync("eval/RUBRIC.md", "utf8");
  const out: EvidenceVerdict = { model, answers: {}, costDollars: 0 };
  for (const q of options.questions ?? JUDGE_QUESTIONS) {
    const answer = await evidenceJudgeQuestion(client, model, q, compileJudgeMessages(q, rubric, payload));
    out.answers[q] = answer;
    out.costDollars += answer.costDollars;
  }
  return out;
}
