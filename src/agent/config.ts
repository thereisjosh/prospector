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

/**
 * Context window per model, in tokens. NOT confirmed from the Anthropic docs (nothing in node_modules or
 * docs/ states it for these ids); 200,000 is the conservative assumption. Raise it when verified.
 */
export const CONTEXT_WINDOW_TOKENS: Record<AgentModel, number> = {
  "claude-opus-5-5": 200_000,
  "claude-sonnet-5-5": 200_000,
};

/** A request is trimmed when it would use more than this share of the window. */
export const CONTEXT_BUDGET_FRACTION = 0.6;

export function contextBudgetTokens(model: AgentModel): number {
  return Math.floor(CONTEXT_WINDOW_TOKENS[model] * CONTEXT_BUDGET_FRACTION);
}

export const DEFAULT_LIMITS = {
  maxCostDollars: 1,
  targetLeads: 10,
  maxTurns: 30,
  maxActiveMs: 6 * 60 * 1000,
  noProgressTurns: 4,
  handbackReserveDollars: 0.05,
  maxParallelTools: 6,
} as const;

/**
 * Where runs and workspace memory live. Explicit RUNS_DIR / WORKSPACES_DIR win;
 * on Vercel the filesystem is read-only except /tmp; otherwise ./runs and
 * ./workspaces.
 */
export function resolveDataDirs(env: Record<string, string | undefined> = process.env): {
  data: string;
  runs: string;
  workspaces: string;
} {
  const base = env.DATA_DIR ?? (env.VERCEL ? "/tmp/prospector" : ".");
  return {
    data: base,
    runs: env.RUNS_DIR ?? `${base}/runs`,
    workspaces: env.WORKSPACES_DIR ?? `${base}/workspaces`,
  };
}

export const DATA_DIR = resolveDataDirs().data;
export const RUNS_DIR = resolveDataDirs().runs;
export const WORKSPACES_DIR = resolveDataDirs().workspaces;

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
