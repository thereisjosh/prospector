/**
 * The offline lead judge on a model with no Anthropic server tools (kimi-k2.6 via Moonshot's
 * Anthropic-compatible endpoint). The Opus judge gets `web_search` (max 3) and `web_fetch` (max 2) as
 * Anthropic server tools; here the same two names are CLIENT tools run by this file:
 *
 *   web_search -> Moonshot Web Search Pro (src/judges/moonshot-search.ts), at most 3 calls
 *   web_fetch  -> our own SSRF-guarded fetch (src/net/safe-fetch.ts) + HTML-to-text, at most 2 pages, ~6,000 tokens each (24,000 chars)
 *
 * Calls past a cap get an is_error tool_result ("limit reached"), never a silent skip. The model sees the
 * same rubric and instruction text as the Opus judge (judge.ts userPrompt).
 */
import type { Message, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { claudeCostDollars, type AgentModel } from "../../src/agent/config";
import type { ModelClient } from "../../src/agent/providers";
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "../../src/net/safe-fetch";
import { MOONSHOT_SEARCH_DOLLARS_PER_CALL, type MoonshotSearchResult } from "../../src/judges/moonshot-search";

export const KIMI_JUDGE_MAX_SEARCHES = 3;
export const KIMI_JUDGE_MAX_FETCHES = 2;
/** ≈ the Opus judge's web_fetch max_content_tokens 6000, at 4 chars per token. */
export const FETCH_MAX_CHARS = 24_000;
/** Thinking (on by default for K2.6, billed as output) + the JSON verdict. */
export const KIMI_JUDGE_MAX_TOKENS = 8000;
const MAX_TURNS = 8;

export const CLIENT_TOOLS = [
  {
    name: "web_search",
    description: `Search the web. At most ${KIMI_JUDGE_MAX_SEARCHES} calls per lead. Returns up to 5 results: title, url, date, snippet and the passages most relevant to the query.`,
    input_schema: { type: "object" as const, properties: { query: { type: "string", description: "The search query." } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: `Open a web page and read its text. At most ${KIMI_JUDGE_MAX_FETCHES} calls per lead; long pages are cut at ${FETCH_MAX_CHARS} characters.`,
    input_schema: { type: "object" as const, properties: { url: { type: "string", description: "Absolute http(s) URL." } }, required: ["url"] },
  },
];

export type PageFetchResult = { ok: true; url: string; title: string; text: string } | { ok: false; url: string; error: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };

export function htmlToText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (e.startsWith("#") ? String.fromCharCode(Number(e.slice(1)) || 32) : m))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title, text };
}

/** Plain GET of a public http(s) page via safeFetch (SSRF-guarded); HTML reduced to text and capped. Errors are returned, not thrown. */
export async function fetchPageText(rawUrl: string, options: SafeFetchOptions = {}): Promise<PageFetchResult> {
  try {
    const res = await safeFetch(rawUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; prospector-eval-judge/1.0)", Accept: "text/html,text/plain;q=0.9" } }, options);
    if (!res.ok) return { ok: false, url: rawUrl, error: `http_${res.status}` };
    const body = res.text;
    const { title, text } = /<html|<body/i.test(body.slice(0, 2000)) ? htmlToText(body) : { title: "", text: body.trim() };
    if (!text) return { ok: false, url: rawUrl, error: "empty_page" };
    return { ok: true, url: rawUrl, title, text: text.slice(0, FETCH_MAX_CHARS) };
  } catch (error) {
    if (!(error instanceof SafeFetchError)) return { ok: false, url: rawUrl, error: "fetch_failed" };
    const r = error.reason;
    const code = r === "blocked_scheme" || r === "blocked_credentials" || r === "blocked_port" || r === "blocked_address" ? "blocked_host" : r === "bad_content_type" ? "unsupported_content_type" : r === "network" ? "fetch_failed" : r;
    return { ok: false, url: rawUrl, error: code };
  }
}

export type KimiJudgeDeps = {
  client: ModelClient;
  model: AgentModel;
  search: (query: string) => Promise<MoonshotSearchResult[]>;
  fetchPage?: (url: string) => Promise<PageFetchResult>;
};

export type KimiJudgeResult = {
  /** All text blocks of the final response (the verdict JSON is parsed from it). */
  text: string;
  stopReason: unknown;
  usage: { input: number; output: number; cache_read: number; cache_creation: number };
  /** Model tokens at the model's price + $0.003 per successful Moonshot search. */
  costDollars: number;
  webSearches: number;
  webFetches: number;
  fetchErrors: string[];
  turns: number;
};

function searchResultText(results: MoonshotSearchResult[]): string {
  return JSON.stringify(results.slice(0, 5).map((r) => ({
    title: r.title,
    url: r.url,
    ...(r.date ? { date: r.date } : {}),
    ...(r.snippet ? { snippet: r.snippet } : {}),
    ...(r.chunks?.length ? { passages: r.chunks.slice(0, 3).map((c) => c.text.slice(0, 600)) } : {}),
  })), null, 1);
}

export async function kimiJudgeCall(deps: KimiJudgeDeps, request: { system: string; user: string }): Promise<KimiJudgeResult> {
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchPageText(u));
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: request.user }];
  const out: KimiJudgeResult = { text: "", stopReason: null, usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, costDollars: 0, webSearches: 0, webFetches: 0, fetchErrors: [], turns: 0 };
  let searchesAttempted = 0;
  let fetchesAttempted = 0;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = (await deps.client.messages.create({
      model: deps.model,
      max_tokens: KIMI_JUDGE_MAX_TOKENS,
      system: request.system,
      messages,
      tools: CLIENT_TOOLS,
    } as never)) as unknown as Message;
    out.turns += 1;
    const u = response.usage ?? ({} as Message["usage"]);
    out.usage.input += u.input_tokens ?? 0;
    out.usage.output += u.output_tokens ?? 0;
    out.usage.cache_read += u.cache_read_input_tokens ?? 0;
    out.usage.cache_creation += u.cache_creation_input_tokens ?? 0;
    out.costDollars += claudeCostDollars(deps.model, u);
    const content = Array.isArray(response.content) ? response.content : [];
    out.text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    out.stopReason = response.stop_reason;
    const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) return out;
    messages.push({ role: "assistant", content });
    const results = [];
    for (const use of uses) {
      const input = (use.input ?? {}) as { query?: unknown; url?: unknown };
      if (use.name === "web_search") {
        if (searchesAttempted >= KIMI_JUDGE_MAX_SEARCHES) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `web_search limit reached (${KIMI_JUDGE_MAX_SEARCHES})`, is_error: true });
          continue;
        }
        searchesAttempted += 1;
        try {
          const found = await deps.search(String(input.query ?? ""));
          out.webSearches += 1;
          // Moonshot bills a call only when it succeeds AND returns results.
          if (found.length > 0) out.costDollars += MOONSHOT_SEARCH_DOLLARS_PER_CALL;
          results.push({ type: "tool_result", tool_use_id: use.id, content: found.length ? searchResultText(found) : "no results" });
        } catch (error) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `web_search failed: ${error instanceof Error ? error.message : String(error)}`, is_error: true });
        }
      } else if (use.name === "web_fetch") {
        if (fetchesAttempted >= KIMI_JUDGE_MAX_FETCHES) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `web_fetch limit reached (${KIMI_JUDGE_MAX_FETCHES})`, is_error: true });
          continue;
        }
        fetchesAttempted += 1;
        const page = await fetchPage(String(input.url ?? ""));
        out.webFetches += 1;
        if (page.ok) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `URL: ${page.url}\nTitle: ${page.title}\n\n${page.text}` });
        } else {
          out.fetchErrors.push(page.error);
          results.push({ type: "tool_result", tool_use_id: use.id, content: `web_fetch failed: ${page.error}`, is_error: true });
        }
      } else {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `unknown tool ${use.name}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return out;
}
