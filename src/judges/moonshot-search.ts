/**
 * Moonshot's standalone Web Search Pro API (platform.kimi.ai/docs/guide/web-search-best-practice, read
 * 2026-10-16):
 *
 *   POST https://api.moonshot.ai/v1/tools/search_pro   Authorization: Bearer <KIMI_API_KEY>
 *   { text_query, limit (1-20, default 5), timeout_seconds (1-60) }
 *   -> { search_results: [{ title, url, site_name, date, snippet, chunks: [{ text, score }] }] }
 *   $0.003 per call, billed only when a call succeeds and returns results (platform.kimi.ai/docs/pricing/websearch).
 *
 * Why not the `$web_search` builtin_function the task named: Moonshot's pricing page says that approach "is
 * expected to be deprecated on October 20, 2026" (4 days after this was written), it exists only on the
 * OpenAI-format chat endpoint, and the K2.6 quickstart says it is "temporarily incompatible with Kimi K2.6
 * thinking mode". The standalone API is the documented replacement. docs/RESEARCH-kimi.md has the details.
 *
 * Pro, not Basic ($0.002): Pro's response shape is documented; Basic's is not.
 */
import { KIMI_BASE_URL_ENV, KIMI_DEFAULT_BASE_URL, providers } from "../agent/config";

export const MOONSHOT_SEARCH_DOLLARS_PER_CALL = 0.003;

export type MoonshotSearchResult = { title: string; url: string; site_name?: string; date?: string; snippet?: string; chunks?: Array<{ text: string; score?: number }> };

export type MoonshotSearchOptions = {
  apiKey?: string;
  /** The Anthropic-compatible base (KIMI_BASE_URL); the tools API lives at the same origin under /v1/tools/. */
  baseURL?: string;
  fetch?: typeof fetch;
  limit?: number;
  timeoutSeconds?: number;
};

/** https://api.moonshot.ai/anthropic -> https://api.moonshot.ai/v1/tools/search_pro */
export function searchEndpoint(baseURL: string): string {
  return `${new URL(baseURL).origin}/v1/tools/search_pro`;
}

export async function moonshotSearch(query: string, options: MoonshotSearchOptions = {}): Promise<MoonshotSearchResult[]> {
  const apiKey = options.apiKey ?? process.env[providers.kimi.apiKeyEnv];
  if (!apiKey) throw new Error(`${providers.kimi.apiKeyEnv} is not set: Moonshot search was not called`);
  const base = options.baseURL ?? (process.env[KIMI_BASE_URL_ENV] || KIMI_DEFAULT_BASE_URL);
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const res = await (options.fetch ?? fetch)(searchEndpoint(base), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text_query: query, limit: options.limit ?? 5, timeout_seconds: timeoutSeconds }),
    signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Moonshot search HTTP ${res.status}: ${text.slice(0, 300)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Moonshot search returned non-JSON: ${text.slice(0, 200)}`);
  }
  const results = (body as { search_results?: unknown }).search_results;
  // An unexpected shape is an error, never an empty result list (that would read as "nothing found").
  if (!Array.isArray(results)) throw new Error(`Moonshot search: no search_results array (keys: ${Object.keys(body as object).join(", ")})`);
  return results as MoonshotSearchResult[];
}
