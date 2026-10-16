/**
 * One SDK client per model provider. Every provider in config.ts `providers` speaks the Anthropic Messages
 * API, so the loop keeps one code path (tools, tool_use loop, streaming, usage) and only the client differs:
 *
 *   anthropic: `new Anthropic()`, exactly as before (env ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL).
 *   kimi:      `new Anthropic({ baseURL: https://api.moonshot.ai/anthropic, authToken: KIMI_API_KEY, apiKey: null })`
 *              wrapped so every request is reshaped for Moonshot first (shapeKimiRequest).
 *
 * `apiKey: null` matters: without it the SDK reads ANTHROPIC_API_KEY from the environment and would send it
 * to Moonshot as X-Api-Key. Moonshot documents bearer auth only (docs/RESEARCH-kimi.md).
 *
 * No key, no call: a missing KIMI_API_KEY throws ProviderConfigError. Nothing ever falls back to another
 * provider or model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { providerOf, providers, type AgentModel, type ProviderId } from "./config";

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** A request shape Moonshot cannot serve (e.g. an Anthropic server tool). Thrown, never silently dropped. */
export class ProviderShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderShapeError";
  }
}

export type ModelClient = Pick<Anthropic, "messages">;

type Env = Record<string, string | undefined>;

/** The SDK options a provider's client is built with (exported for tests; holds the key, never log it). */
export function clientOptions(provider: ProviderId, env: Env = process.env): ConstructorParameters<typeof Anthropic>[0] {
  const spec = providers[provider];
  if (provider === "anthropic") return {};
  const key = env[spec.apiKeyEnv];
  if (!key) throw new ProviderConfigError(`${spec.apiKeyEnv} is not set: the ${provider} provider has no key, so no request was sent`);
  const baseURL = (spec.baseURLEnv ? env[spec.baseURLEnv] : undefined) || spec.baseURL;
  return spec.authMode === "authToken" ? { baseURL, authToken: key, apiKey: null } : { baseURL, apiKey: key, authToken: null };
}

/** K2.6's documented default/maximum completion size (platform.kimi.ai K2.6 quickstart: "Default to be 32k aka 32768"). */
export const KIMI_MAX_TOKENS = 32_768;

/** Anthropic-only request fields that Moonshot's /anthropic endpoint does not document for kimi-k2.6. */
const KIMI_DROPPED_FIELDS = ["thinking", "temperature", "top_p", "top_k", "betas", "context_management", "container", "mcp_servers", "service_tier", "inference_geo"] as const;

function stripBlockCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripBlockCacheControl) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "cache_control") continue;
    // Tool inputs and tool_result text are data, not request structure: copied as they are.
    out[k] = k === "input" || k === "input_schema" ? v : stripBlockCacheControl(v);
  }
  return out as T;
}

/**
 * Reshape an Anthropic Messages request for Moonshot's /anthropic endpoint (kimi-k2.6). Returns the new
 * params and what was changed (for tests and logs). Facts behind each rule are in docs/RESEARCH-kimi.md:
 *
 * - `thinking`, sampling params, betas: dropped. The documented request schema has no request-level
 *   `thinking`; K2.6 thinks by default and fixes temperature/top_p ("any other value will result in an error").
 * - `output_config.effort`: dropped. Moonshot's enum is low|high|max (documented for kimi-k3), so our
 *   "medium" would be invalid; `output_config.format` is kept.
 * - `tool_choice`: K2.6 in thinking mode accepts only auto|none, so a forced choice ("any"/"tool") becomes
 *   "auto"; `disable_parallel_tool_use` (undocumented) is removed.
 * - `cache_control`: the top-level marker is documented (ephemeral, ttl 5m|1h) and kept; block-level markers
 *   (system blocks, tools, message blocks) are documented as ignored and are stripped.
 * - `max_tokens`: same field name; clamped to K2.6's 32,768.
 * - Anthropic server tools (web_search_*, web_fetch_*, code_execution_* …): Moonshot has none on this
 *   endpoint, so a request carrying one throws ProviderShapeError.
 * - `tools[].strict`: not in Moonshot's tool schema; removed (the input_schema itself is unchanged).
 */
export function shapeKimiRequest<P extends Record<string, unknown>>(params: P): { params: P; changes: string[] } {
  const changes: string[] = [];
  const out: Record<string, unknown> = { ...params };
  for (const field of KIMI_DROPPED_FIELDS) {
    if (field in out) {
      delete out[field];
      changes.push(`dropped ${field}`);
    }
  }
  if (out.output_config && typeof out.output_config === "object") {
    const { effort, ...rest } = out.output_config as Record<string, unknown>;
    if (effort !== undefined) changes.push(`dropped output_config.effort=${String(effort)}`);
    if (Object.keys(rest).length > 0) out.output_config = rest;
    else delete out.output_config;
  }
  if (out.tool_choice && typeof out.tool_choice === "object") {
    const choice = out.tool_choice as { type?: unknown; disable_parallel_tool_use?: unknown };
    if (choice.type === "any" || choice.type === "tool") {
      out.tool_choice = { type: "auto" };
      changes.push(`tool_choice ${String(choice.type)} -> auto`);
    } else if (choice.disable_parallel_tool_use !== undefined) {
      out.tool_choice = { type: choice.type };
      changes.push("dropped tool_choice.disable_parallel_tool_use");
    }
  }
  if (Array.isArray(out.tools)) {
    for (const tool of out.tools as Array<Record<string, unknown>>) {
      if (typeof tool.type === "string" && tool.type !== "custom") {
        throw new ProviderShapeError(`tool "${String(tool.name)}" is an Anthropic server tool (${tool.type}); Moonshot's /anthropic endpoint has no server tools`);
      }
    }
    if ((out.tools as Array<Record<string, unknown>>).some((t) => "strict" in t)) changes.push("dropped tools[].strict");
    out.tools = (out.tools as Array<Record<string, unknown>>).map(({ strict: _strict, ...tool }) => tool);
  }
  const hadBlockCache = JSON.stringify([out.system, out.tools, out.messages]).includes("\"cache_control\"");
  if (hadBlockCache) changes.push("stripped block-level cache_control");
  if (out.system !== undefined) out.system = stripBlockCacheControl(out.system);
  if (out.tools !== undefined) out.tools = stripBlockCacheControl(out.tools);
  if (out.messages !== undefined) out.messages = stripBlockCacheControl(out.messages);
  if (typeof out.max_tokens === "number" && out.max_tokens > KIMI_MAX_TOKENS) {
    changes.push(`max_tokens ${out.max_tokens} -> ${KIMI_MAX_TOKENS}`);
    out.max_tokens = KIMI_MAX_TOKENS;
  }
  return { params: out as P, changes };
}

/** A client whose create/stream reshape every request; it has no countTokens (Moonshot documents none). */
function kimiClient(inner: Anthropic): ModelClient {
  const shape = (p: unknown) => shapeKimiRequest(p as Record<string, unknown>).params as never;
  const messages = {
    create: (params: unknown, options?: unknown) => inner.messages.create(shape(params), options as never),
    stream: (params: unknown, options?: unknown) => inner.messages.stream(shape(params), options as never),
  };
  return { messages } as unknown as ModelClient;
}

export type ClientFactoryOptions = {
  env?: Env;
  /** Test seam: the SDK's fetch (lets a test see the URL and headers without a network call). */
  fetch?: typeof fetch;
  maxRetries?: number;
};

/**
 * The client a run (or judge) uses for `model`. Anthropic models get `new Anthropic()` exactly as before;
 * kimi models get the Moonshot-configured, request-shaping client.
 */
export function createModelClient(model: AgentModel | string, options: ClientFactoryOptions = {}): ModelClient {
  const provider = providerOf(model);
  if (provider === "anthropic") {
    return options.fetch || options.maxRetries !== undefined
      ? new Anthropic({ ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}) })
      : new Anthropic();
  }
  const inner = new Anthropic({
    ...clientOptions(provider, options.env ?? process.env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
  return kimiClient(inner);
}

/** Whether the model's provider has the count_tokens endpoint (src/agent/context.ts preflight). */
export function supportsCountTokens(model: string): boolean {
  return providers[providerOf(model)].countTokens;
}
