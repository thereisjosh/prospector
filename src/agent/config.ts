export const AGENT_MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
} as const;

export type AgentModel = (typeof AGENT_MODELS)[keyof typeof AGENT_MODELS];

export const DEFAULT_MODEL: AgentModel = AGENT_MODELS.opus;

export const CLAUDE_PRICES_PER_MILLION: Record<
  AgentModel,
  { input: number; output: number; cache_read: number; cache_write: number }
> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
};

export const DEFAULT_LIMITS = {
  maxCostDollars: 1,
  targetLeads: 10,
  maxTurns: 30,
  maxActiveMs: 6 * 60 * 1000,
  noProgressTurns: 4,
  handbackReserveDollars: 0.05,
  maxParallelTools: 6,
} as const;

export const RUNS_DIR = process.env.RUNS_DIR ?? "./runs";
export const WORKSPACES_DIR = process.env.WORKSPACES_DIR ?? "./workspaces";

export function claudeCostDollars(
  model: AgentModel,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined,
): number {
  const p = CLAUDE_PRICES_PER_MILLION[model];
  return (
    ((usage?.input_tokens ?? 0) * p.input +
      (usage?.output_tokens ?? 0) * p.output +
      (usage?.cache_read_input_tokens ?? 0) * p.cache_read +
      (usage?.cache_creation_input_tokens ?? 0) * p.cache_write) /
    1_000_000
  );
}

export function isAgentModel(value: unknown): value is AgentModel {
  return value === AGENT_MODELS.opus || value === AGENT_MODELS.sonnet;
}
