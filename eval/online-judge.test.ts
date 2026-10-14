import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { calibrationDatasetName, calibrationItems, SPOT_CHECKS } from "./online/calibration-set";
import { compile, estimateCallDollars, judgeOnce, outputCorrect, summaryLine, trackErrors } from "./online/calibrate-judge";
import { JUDGE_QUESTIONS, judgeMessages, judgeOutputDefinition, judgeUserPrompt } from "./online/judge-prompt";
import { evaluatorBody, ruleFilter, RULE_NAME } from "./online/setup-langfuse";
import { judgePayload } from "../src/agent/judge-input";

const rubric = readFileSync("eval/RUBRIC.md", "utf8");

describe("managed online judges (config as code)", () => {
  it("one evaluator per RUBRIC question, named like the offline score, {{lead}} ← observation input, same vocabulary", () => {
    for (const q of JUDGE_QUESTIONS) {
      const body = evaluatorBody(q, rubric);
      expect(body.name).toBe(q);
      expect(body.type).toBe("llm_as_judge");
      expect(body.prompt[0]).toEqual({ role: "system", content: rubric });
      expect(body.prompt[1]!.content.match(/\{\{(\w+)\}\}/g)).toEqual(["{{lead}}"]);
      expect(body.variableMapping).toEqual([{ variable: "lead", source: "input" }]);
      expect(body.modelConfig).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
      expect(body.outputDefinition).toMatchObject({ dataType: "CATEGORICAL", categories: ["yes", "no", "cannot_verify"], shouldAllowMultipleMatches: false });
    }
    // Q3 needs the page to load; without web access it may only say no / cannot_verify.
    expect(judgeUserPrompt("judge_q3")).toMatch(/never answer "yes"/);
  });

  it("the rule only matches lead-judge observations in production (selection and cap are ours)", () => {
    expect(RULE_NAME).toBe("lead-judge (production)");
    expect(ruleFilter()).toEqual([
      { type: "stringOptions", column: "environment", operator: "any of", value: ["production"] },
      { type: "stringOptions", column: "name", operator: "any of", value: ["lead-judge"] },
    ]);
  });
});

describe("judge calibration set (SPOT-CHECKS.md)", () => {
  it("has the 10 spot-checked leads per judge, with labels in the judge's vocabulary and the production input shape", () => {
    expect(SPOT_CHECKS).toHaveLength(10);
    const dist = Object.fromEntries(
      JUDGE_QUESTIONS.map((q) => {
        const items = calibrationItems(q);
        expect(items).toHaveLength(10);
        expect(new Set(items.map((i) => i.id)).size).toBe(10);
        for (const item of items) {
          expect(Object.keys(item.input)).toEqual(["company", "signal_url", "why_now", "contract", "contract_summary"]);
          expect(item.input).toEqual(judgePayload({ ...item.input, ...item.input.contract_summary }));
        }
        const counts: Record<string, number> = {};
        for (const i of items) counts[i.expectedOutput] = (counts[i.expectedOutput] ?? 0) + 1;
        return [q, counts];
      }),
    );
    expect(dist).toEqual({
      judge_q1: { yes: 7, no: 3 },
      judge_q2: { yes: 8, cannot_verify: 2 },
      judge_q3: { yes: 9, no: 1 },
    });
    expect(calibrationDatasetName("judge_q2")).toBe("judge-calibration/judge_q2");
  });

  it("compiles the stored prompt like the evaluator, estimates cost from it, and scores exact matches", async () => {
    const item = calibrationItems("judge_q1")[4]!; // Away Team (Spreetail): Q1 no
    const messages = compile(judgeMessages("judge_q1", rubric), item.input);
    expect(messages[1]!.content).toContain(JSON.stringify(item.input, null, 2));
    expect(messages[1]!.content).not.toContain("{{lead}}");
    const est = estimateCallDollars(messages);
    expect(est.dollars).toBeGreaterThan(0.005);
    expect(est.dollars).toBeLessThan(0.05);

    const client = {
      messages: {
        create: vi.fn(async (_body: unknown) => ({
          content: [{ type: "tool_use", name: "verdict", input: { reasoning: "own knowledge: Spreetail is a retailer", score: "no" } }],
          usage: { input_tokens: 2000, output_tokens: 120 },
        })),
      },
    };
    const out = await judgeOnce(client as never, "judge_q1", messages);
    expect(out).toMatchObject({ score: "no" });
    expect(out.costDollars).toBeCloseTo((2000 * 4 + 120 * 20) / 1e6, 6);
    const call = client.messages.create.mock.calls[0]![0] as unknown as { system: string; tools: Array<{ input_schema: { properties: { score: { enum: string[] } } } }>; tool_choice: unknown };
    expect(call.system).toBe(rubric);
    expect(call.tools[0]!.input_schema.properties.score.enum).toEqual(judgeOutputDefinition("judge_q1").categories);
    expect(call.tool_choice).toBeUndefined();
    const sent = (call as unknown as { messages: Array<{ content: string }> }).messages;
    expect(sent[sent.length - 1]!.content).toMatch(/calling the `verdict` tool exactly once\.$/);

    const correct = outputCorrect("judge_q1");
    expect(await correct({ output: out, expectedOutput: "no" })).toMatchObject({ name: "judge_q1-judge-output-correct", value: 1, dataType: "BOOLEAN" });
    expect(await correct({ output: { score: "cannot_verify" }, expectedOutput: "no" })).toMatchObject({ value: 0 });
  });
});

describe("judge calibration failure handling", () => {
  it("returns invalid (no text parsing) with the first text block when the model makes no tool call, and still costs it", async () => {
    const client = {
      messages: { create: vi.fn(async (_body: unknown) => ({ content: [{ type: "text", text: `score: yes ${"x".repeat(600)}` }], usage: { input_tokens: 1000, output_tokens: 50 } })) },
    };
    const out = await judgeOnce(client as never, "judge_q1", [{ role: "user", content: "hi" }]);
    expect(out.score).toBe("invalid");
    expect(out.reasoning.startsWith("no verdict tool call: score: yes")).toBe(true);
    expect(out.reasoning).toHaveLength("no verdict tool call: ".length + 500);
    expect(out.costDollars).toBeCloseTo((1000 * 4 + 50 * 20) / 1e6, 6);
  });

  it("logs the item id + message, counts the error, rethrows, and the summary reports it", async () => {
    const errors: Array<{ id: string; message: string }> = [];
    const log = vi.fn();
    const task = trackErrors(async (item: { id?: string }) => {
      if (item.id === "b") throw new Error("400 tool_choice not supported");
      return "ok";
    }, errors, log);
    expect(await task({ id: "a" })).toBe("ok");
    await expect(task({ id: "b" })).rejects.toThrow("400 tool_choice");
    expect(errors).toEqual([{ id: "b", message: "400 tool_choice not supported" }]);
    expect(log).toHaveBeenCalledWith("item b failed: 400 tool_choice not supported");
    expect(summaryLine("judge_q1", 0, 10, 10)).toBe("judge_q1: 0/10 correct, 10 errors");
  });
});
