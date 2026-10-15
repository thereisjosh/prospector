import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { rejectionCounts, type RunState } from "./state";

/**
 * Working memory: what the model sees each turn. `state.messages` stays the full append-only record
 * (replay, resume, the UI); this module decides what part of it is re-sent. When the request would exceed
 * the token budget, the OLDEST whole turns are dropped and replaced by a summary that code writes from the
 * run's structured state. No model call writes it, and no message text is read to build it.
 *
 * Prompt caching: dropping turns changes the prefix, so the turn that trims pays a cache write instead of
 * a cache read. Later turns cache again (the kept window only grows from there until the next trim).
 */

/** The only token estimate in the loop: 4 characters per token (same as recall.ts). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const SUMMARY_MAX_TOKENS = 1500;

type Msg = Anthropic.MessageParam;

export type AssembledContext = {
  messages: Msg[];
  /** The code-written block appended to the first user message; absent when nothing was dropped. */
  summary?: string;
  /** Whole turns dropped (an assistant message plus the user message answering it). */
  dropped: number;
  droppedTokens: number;
  /** Request tokens after trimming, system and tools included. */
  keptTokens: number;
  summaryTokens: number;
};

const messageTokens = (message: Msg) => estimateTokens(JSON.stringify(message.content));

/**
 * Turn boundaries. messages[0] is the approved contract (the system prompt is generic, so the contract
 * lives here) and is never dropped. After it, each assistant message starts a turn that runs up to the
 * next assistant message: the assistant's tool_use blocks and the user message(s) holding their
 * tool_results. Cutting only at those indices means a tool_result never loses its tool_use.
 */
export function turnStarts(messages: Msg[]): number[] {
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i += 1) if (messages[i]!.role === "assistant") starts.push(i);
  return starts;
}

/**
 * @param fixedTokens estimated tokens of the system prompt and tool list (sent on every call, never dropped)
 * @param measuredTokens real count_tokens result for the FULL request; used to calibrate the estimates
 *        (each message's estimate is scaled by measured / estimated-total). Omit to use raw estimates.
 */
export function assembleMessages(
  state: Pick<RunState, "messages" | "contract" | "leads" | "candidates" | "rejected" | "screened" | "handback" | "caches" | "spend" | "counters">,
  opts: { budgetTokens: number; fixedTokens?: number; measuredTokens?: number },
): AssembledContext {
  const messages = state.messages;
  const fixed = opts.fixedTokens ?? 0;
  const raw = messages.map(messageTokens);
  const estimatedTotal = fixed + raw.reduce((a, b) => a + b, 0);
  const total = opts.measuredTokens ?? estimatedTotal;
  const scale = estimatedTotal > 0 ? total / estimatedTotal : 1;
  const untouched: AssembledContext = { messages, dropped: 0, droppedTokens: 0, keptTokens: total, summaryTokens: 0 };
  if (total <= opts.budgetTokens) return untouched;

  const starts = turnStarts(messages);
  // Always keep the newest turn: it holds the results the model is about to react to.
  if (starts.length < 2) return untouched;
  const turnTokens = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : messages.length;
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += raw[j]! * scale;
    return sum;
  });

  const summaryFor = (droppedTurns: number) => buildSummary(state, droppedTurns);
  let dropped = 0;
  let droppedTokens = 0;
  let summary = summaryFor(1);
  let summaryTokens = estimateTokens(summary);
  while (dropped < starts.length - 1) {
    droppedTokens += turnTokens[dropped]!;
    dropped += 1;
    summary = summaryFor(dropped);
    summaryTokens = estimateTokens(summary);
    if (total - droppedTokens + summaryTokens <= opts.budgetTokens) break;
  }

  const first = messages[0]!;
  const firstText = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
  const kept: Msg[] = [{ role: "user", content: `${firstText}\n\n${summary}` }, ...messages.slice(starts[dropped]!)];
  return {
    messages: kept,
    summary,
    dropped,
    droppedTokens: Math.round(droppedTokens),
    keptTokens: Math.round(total - droppedTokens + summaryTokens),
    summaryTokens,
  };
}

const ellipsis = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return ellipsis(url, 40);
  }
}

function dateOf(lead: { details?: Record<string, unknown>; summary?: { signal_date?: string } }): string {
  const fromDetails = lead.details?.event_date;
  return typeof fromDetails === "string" && fromDetails ? fromDetails : lead.summary?.signal_date || "undated";
}

/**
 * The summary block. Every fact comes from structured state (leads, candidates, rejections, spend,
 * counters, query cache), never from message text. Lists are cut to fit SUMMARY_MAX_TOKENS.
 *
 *   ## Earlier in this run (N older turns trimmed to save context)
 *   Written by code from the run's records, not by a model. The approved contract above is unchanged.
 *   - Progress: $0.42 of $1.00 spent · 3/10 leads · turn 12/30
 *   - Accepted leads (3): Acme (acme.com, 2026-10-01); …
 *   - Candidates awaiting evidence (2): Beta (beta.io, 2026-09-20, missing signal_date_quote); …
 *   - Rejected by code, companies per reason: size 4, hq 2, …
 *   - Handback so far: 3 of 10; top reasons size 4, hq 2        (only when one exists)
 *   - Searches already tried (N, newest last): "…"; …
 *   Do not repeat these searches or resubmit these companies.
 */
export function buildSummary(
  state: Pick<RunState, "contract" | "leads" | "candidates" | "rejected" | "screened" | "handback" | "caches" | "spend" | "counters">,
  droppedTurns: number,
): string {
  const build = (leadLimit: number, queryLimit: number): string => {
    const more = (shown: number, total: number) => (total > shown ? `; …and ${total - shown} more` : "");
    const leads = state.leads.slice(0, leadLimit);
    const candidates = (state.candidates ?? []).slice(0, leadLimit);
    const queries = state.caches.searchQueries.slice(-queryLimit);
    const counts = rejectionCounts(state);
    const lines = [
      `## Earlier in this run (${droppedTurns} older turn${droppedTurns === 1 ? "" : "s"} trimmed to save context)`,
      "Written by code from the run's records, not by a model. The approved contract above is unchanged.",
      `- Progress: $${state.spend.total.toFixed(2)} of $${state.contract.maxCostDollars.toFixed(2)} spent · ${state.leads.length}/${state.contract.targetLeads} leads · turn ${state.counters.turns}`,
      `- Accepted leads (${state.leads.length}): ${state.leads.length === 0 ? "none yet" : leads.map((l) => `${l.company} (${hostOf(l.signal_url)}, ${dateOf(l)})`).join("; ") + more(leads.length, state.leads.length)}`,
    ];
    if ((state.candidates ?? []).length > 0) {
      lines.push(
        `- Candidates awaiting evidence (${state.candidates.length}): ${candidates.map((c) => `${c.company} (${hostOf(c.signal_url)}, ${dateOf(c)}, missing ${c.missing})`).join("; ")}${more(candidates.length, state.candidates.length)}`,
      );
    }
    lines.push(`- Rejected by code, companies per reason: ${counts.length === 0 ? "none yet" : counts.map((c) => `${c.code} ${c.count}`).join(", ")}`);
    if (state.handback) {
      lines.push(`- Handback so far: ${state.handback.shortfall}; top reasons ${state.handback.top_reasons.map((r) => `${r.code} ${r.count}`).join(", ") || "none"}`);
    }
    lines.push(
      `- Searches already tried (${state.caches.searchQueries.length}${state.caches.searchQueries.length > queries.length ? `, newest ${queries.length} shown` : ""}): ${queries.length === 0 ? "none" : queries.map((q) => `"${ellipsis(q, 90)}"`).join("; ")}`,
      "Do not repeat these searches or resubmit these companies.",
    );
    return lines.join("\n");
  };
  // Shrink the lists until the block fits; the counts and progress lines never go.
  for (const [leadLimit, queryLimit] of [[25, 15], [12, 8], [6, 4], [3, 2], [0, 0]] as const) {
    const block = build(leadLimit, queryLimit);
    if (estimateTokens(block) <= SUMMARY_MAX_TOKENS) return block;
  }
  return build(0, 0);
}

/** Cache key for a measured request: any change to model, messages, system or tools forces a new count. */
export function tokenCountKey(model: string, messageCount: number, system: string, tools: unknown): string {
  const digest = createHash("sha256").update(system).update("\u0000").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
  return `${model}|${messageCount}|${digest}`;
}

export type TokenMeasure = { tokens: number; source: "counted" | "cached" | "estimated"; error?: string };

/**
 * Tokens for the full request, measured with the free count_tokens endpoint once per turn BEFORE the
 * model call. A cached count (same key) is reused. On failure it falls back to the 4-chars/token
 * estimate and says so (`source: "estimated"`, `error`), so the caller can emit `token_count_estimated`.
 */
export async function measureRequestTokens(
  state: Pick<RunState, "model" | "messages" | "tokenCount">,
  client: { messages: { countTokens?: (params: never) => PromiseLike<{ input_tokens: number }> } },
  request: { system: string; tools: unknown },
): Promise<TokenMeasure> {
  const key = tokenCountKey(state.model, state.messages.length, request.system, request.tools);
  if (state.tokenCount?.key === key) return { tokens: state.tokenCount.tokens, source: "cached" };
  try {
    if (typeof client.messages.countTokens !== "function") throw new Error("client has no countTokens");
    const result = await client.messages.countTokens({
      model: state.model,
      system: request.system,
      tools: request.tools,
      messages: state.messages,
    } as never);
    if (typeof result?.input_tokens !== "number") throw new Error("count_tokens returned no input_tokens");
    state.tokenCount = { key, tokens: result.input_tokens };
    return { tokens: result.input_tokens, source: "counted" };
  } catch (error) {
    const estimate = estimateTokens(request.system) + estimateTokens(JSON.stringify(request.tools)) + state.messages.reduce((n, m) => n + messageTokens(m), 0);
    return { tokens: estimate, source: "estimated", error: error instanceof Error ? error.message : String(error) };
  }
}
