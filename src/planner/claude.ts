import { claudeCostDollars, DEFAULT_MODEL, type AgentModel } from "../agent/config";

export type PlannerClient = {
  messages: {
    create(args: {
      model: AgentModel;
      max_tokens: number;
      system: string;
      messages: { role: "user" | "assistant"; content: string }[];
      output_config: { effort: "medium" };
    }): Promise<{
      content?: unknown;
      usage?: {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      } | null;
    }>;
  };
};

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: "model_json_invalid" | "validation_failed",
    public readonly errors: string[] = [],
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

export type PlannerModelDeps = {
  client: PlannerClient;
  model?: AgentModel;
};

export type JsonValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function responseText(response: { content?: unknown }): string {
  const content = response.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

export function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new PlannerError("Model did not return a JSON object.", "model_json_invalid");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch (error) {
          throw new PlannerError(
            error instanceof Error ? error.message : "Invalid JSON.",
            "model_json_invalid",
          );
        }
      }
    }
  }
  throw new PlannerError("Model JSON object was not balanced.", "model_json_invalid");
}

export async function callClaudeJson<T>(
  deps: PlannerModelDeps,
  system: string,
  user: string,
  validate: (json: unknown) => JsonValidation<T>,
): Promise<{ value: T; cost: number }> {
  const model = deps.model ?? DEFAULT_MODEL;
  let totalCost = 0;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = [{
      role: "user" as const,
      content: attempt === 0
        ? user
        : `${user}\n\nYour previous JSON failed validation. Return one corrected JSON object only. Errors:\n${lastErrors.join("\n")}`,
    }];
    const response = await deps.client.messages.create({
      model,
      max_tokens: 4000,
      system,
      messages,
      output_config: { effort: "medium" },
    });
    totalCost += claudeCostDollars(model, response.usage);

    let json: unknown;
    try {
      json = extractFirstJsonObject(responseText(response));
    } catch (error) {
      lastErrors = [error instanceof Error ? error.message : "invalid model JSON"];
      if (attempt === 1) throw error;
      continue;
    }

    const result = validate(json);
    if (result.ok) return { value: result.value, cost: totalCost };
    lastErrors = result.errors;
  }

  throw new PlannerError("Planner output failed validation.", "validation_failed", lastErrors);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
