export const AGENT_MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  /** Moonshot Kimi K2.6 through Moonshot's Anthropic-compatible endpoint (docs/RESEARCH-kimi.md). */
  kimi: "kimi-k2.6",
} as const;

export type AgentModel = (typeof AGENT_MODELS)[keyof typeof AGENT_MODELS];

/**
 * Planner / prompt-config default (cards, compile, the Langfuse prompt configs). Stays Opus; the agent loop
 * has its own default below.
 */
export const DEFAULT_MODEL: AgentModel = AGENT_MODELS.opus;

/**
 * Agent-loop default for live runs (POST /api/runs, eval/run-agent.ts, createRunState): Sonnet 5.5 since
 * 2026-10-17, after three reps per scenario (docs/DECISIONS.md row 26, docs/EVAL-DETAIL.md). Opus stays
 * selectable (`model: "opus"` / `--model opus`); the offline lead judge stays Opus.
 */
export const AGENT_DEFAULT_MODEL: AgentModel = AGENT_MODELS.sonnet;

/** Moonshot's Anthropic-compatible Messages endpoint (platform.kimi.ai/docs/api/messages; POST {base}/v1/messages). */
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.ai/anthropic";
/** KIMI_BASE_URL overrides it (e.g. the .cn host); read when a client is built, not at import. */
export const KIMI_BASE_URL_ENV = "KIMI_BASE_URL";

export type ProviderId = "anthropic" | "kimi";

export type ProviderSpec = {
  /** undefined = the SDK default (api.anthropic.com, or ANTHROPIC_BASE_URL as today). */
  baseURL?: string;
  /** Env var that may override baseURL. */
  baseURLEnv?: string;
  apiKeyEnv: string;
  /** "apiKey" = X-Api-Key header (Anthropic); "authToken" = Authorization: Bearer (Moonshot documents bearer only). */
  authMode: "apiKey" | "authToken";
  /** Whether /v1/messages/count_tokens exists. Moonshot documents none, so the preflight is estimated. */
  countTokens: boolean;
};

export const providers: Record<ProviderId, ProviderSpec> = {
  anthropic: { baseURL: undefined, apiKeyEnv: "ANTHROPIC_API_KEY", authMode: "apiKey", countTokens: true },
  kimi: { baseURL: KIMI_DEFAULT_BASE_URL, baseURLEnv: KIMI_BASE_URL_ENV, apiKeyEnv: "KIMI_API_KEY", authMode: "authToken", countTokens: false },
};

export type ModelPrices = { input: number; output: number; cache_read: number; cache_write: number };

/**
 * Model registry: provider, $ per million tokens, context window.
 * kimi-k2.6 (platform.kimi.ai/docs/pricing/chat, read 2026-10-16): $0.95 input (cache miss), $0.16 cache hit,
 * $4.00 output, 262,144-token context. Output includes reasoning tokens (docs/api/messages: "output_tokens:
 * includes reasoning tokens"). Moonshot lists no cache-WRITE price for K2.6 (only for K3), so a write is priced
 * as a cache-miss input token ($0.95): an assumption, recorded in docs/RESEARCH-kimi.md.
 */
export const MODEL_REGISTRY: Record<AgentModel, { provider: ProviderId; prices: ModelPrices; contextWindow: number }> = {
  "claude-opus-5-5": { provider: "anthropic", prices: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }, contextWindow: 200_000 },
  "claude-sonnet-5-5": { provider: "anthropic", prices: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }, contextWindow: 200_000 },
  "kimi-k2.6": { provider: "kimi", prices: { input: 0.95, output: 4, cache_read: 0.16, cache_write: 0.95 }, contextWindow: 262_144 },
};

export const CLAUDE_PRICES_PER_MILLION: Record<AgentModel, ModelPrices> = Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([id, m]) => [id, m.prices]),
) as Record<AgentModel, ModelPrices>;

/**
 * Context window per model, in tokens. The Claude values are NOT confirmed from the Anthropic docs (nothing in
 * node_modules or docs/ states it for these ids); 200,000 is the conservative assumption for both Opus and
 * Sonnet. Raise it when verified.
 * kimi-k2.6: 262,144 (Moonshot pricing table; the K2.6 quickstart says "256K").
 */
export const CONTEXT_WINDOW_TOKENS: Record<AgentModel, number> = Object.fromEntries(
  Object.entries(MODEL_REGISTRY).map(([id, m]) => [id, m.contextWindow]),
) as Record<AgentModel, number>;

/** The provider that serves a model id. Throws on an id with no registry entry (it would have no price). */
export function providerOf(model: string): ProviderId {
  const entry = (MODEL_REGISTRY as Record<string, { provider: ProviderId } | undefined>)[model];
  if (!entry) throw new Error(`unknown model "${model}": no entry in MODEL_REGISTRY (src/agent/config.ts)`);
  return entry.provider;
}

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

/** Dollar cost of one response's usage, priced by model id (any provider in MODEL_REGISTRY). */
export function claudeCostDollars(
  model: AgentModel,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined,
): number {
  const p = MODEL_REGISTRY[model]?.prices;
  if (!p) throw new Error(`no price for model "${model}" (src/agent/config.ts MODEL_REGISTRY)`);
  return (
    ((usage?.input_tokens ?? 0) * p.input +
      (usage?.output_tokens ?? 0) * p.output +
      (usage?.cache_read_input_tokens ?? 0) * p.cache_read +
      (usage?.cache_creation_input_tokens ?? 0) * p.cache_write) /
    1_000_000
  );
}

/** Same function under a provider-neutral name. */
export const modelCostDollars = claudeCostDollars;

export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_REGISTRY, value);
}
