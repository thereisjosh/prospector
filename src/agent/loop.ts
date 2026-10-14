import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Message, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { CostGuard } from "../exa";
import { CLAUDE_PRICES_PER_MILLION, claudeCostDollars, DEFAULT_LIMITS } from "./config";
import { appendEvents, eventInput, makeEvent, type AgentEvent } from "./events";
import { parseEmployeeEstimate } from "../gates";
import { countryOfHq } from "../geo";
import { appendRunToMemory, squashName } from "./memory";
import { ensureAgentPrompt } from "./prompts";
import { promptLink } from "./prompt-store";
import type { RunState, Handback } from "./state";
import { APPROVAL_TOOLS, agentTools, executeTool, type ToolDeps } from "./tools";

export type LoopDeps = ToolDeps & {
  client: Pick<Anthropic, "messages">;
};

export type StepResult = { state: RunState; events: AgentEvent[] };

function usageOf(response: Message) {
  return {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cache_read: response.usage.cache_read_input_tokens ?? 0,
    cache_creation: response.usage.cache_creation_input_tokens ?? 0,
  };
}

const RESPONSE_TEXT_LIMIT = 2000;
const TOOL_INPUT_LIMIT = 200;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The system prompt and tool list are the same on almost every call, so their hashes are
 * cached per slot and recomputed only when the text changes (compared by length, then content).
 */
const hashCache = new Map<"system" | "tools", { text: string; hash: string }>();
const hashCacheStats = { hits: 0, misses: 0 };

function cachedSha256(slot: "system" | "tools", text: string): string {
  const cached = hashCache.get(slot);
  if (cached && cached.text.length === text.length && cached.text === text) {
    hashCacheStats.hits += 1;
    return cached.hash;
  }
  hashCacheStats.misses += 1;
  const hash = sha256(text);
  hashCache.set(slot, { text, hash });
  return hash;
}

/** Tests only. */
export function __promptHashCacheStats(): { hits: number; misses: number } {
  return { ...hashCacheStats };
}

/**
 * Trace fields for a model_call event (SPEC-observability §2–§3): model, stop_reason,
 * hashes of the system prompt and tool list (their text is in git), how many messages
 * were sent (history itself stays in state.json), and the response clipped
 * (text 2,000 chars, each tool_use input 200). Thinking text is never recorded (§3).
 */
function modelCallFields(
  state: RunState,
  request: { system: string; tools: unknown; messageCount: number },
  response: Message,
): Record<string, unknown> {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  const uses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
  return {
    model: state.model,
    ...(typeof response.id === "string" ? { responseId: response.id } : {}),
    stop_reason: response.stop_reason ?? null,
    systemSha256: cachedSha256("system", request.system),
    // Links the generation to its Langfuse prompt version (absent for the repo fallback).
    ...(promptLink(state.prompt) ? { prompt: promptLink(state.prompt) } : {}),
    toolsSha256: cachedSha256("tools", JSON.stringify(request.tools)),
    messages: request.messageCount,
    response: {
      text: text.slice(0, RESPONSE_TEXT_LIMIT),
      tool_uses: uses.map((u) => ({ id: u.id, name: u.name, input: (JSON.stringify(u.input ?? null) ?? "null").slice(0, TOOL_INPUT_LIMIT) })),
    },
  };
}

function clipText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function statusSnapshot(state: RunState) {
  return {
    status: state.status,
    turn: state.counters.turns,
    spend: { total: state.spend.total, claude: state.spend.claude, exa: state.spend.exa },
    leads: state.leads.length,
  };
}

function policySnapshot(state: RunState) {
  return {
    spend: state.spend.total,
    maxCostDollars: state.contract.maxCostDollars,
    turns: state.counters.turns,
    maxTurns: DEFAULT_LIMITS.maxTurns,
    activeMs: state.counters.activeMs,
    noProgressTurns: state.counters.noProgressTurns,
    leads: state.leads.length,
    targetLeads: state.contract.targetLeads,
  };
}

function toolUses(response: Message): ToolUseBlock[] {
  return response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

function addClaudeCost(state: RunState, response: Message): number {
  const cost = claudeCostDollars(state.model, response.usage);
  state.spend.claude += cost;
  state.spend.total = state.spend.claude + state.spend.exa;
  state.counters.lastModelInputTokens = (response.usage.input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
  return cost;
}

function modelCostDollars(state: RunState, usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  return claudeCostDollars(state.model, usage);
}

function maxTokensForTurn(state: RunState): number | undefined {
  const p = CLAUDE_PRICES_PER_MILLION[state.model];
  const remaining = state.contract.maxCostDollars - state.spend.total;
  const cacheReadCost = ((state.counters.lastModelInputTokens ?? 0) * p.cache_read) / 1_000_000;
  const cacheWriteCost = (3000 * p.cache_write) / 1_000_000;
  const available = remaining - DEFAULT_LIMITS.handbackReserveDollars - 0.05 - cacheReadCost - cacheWriteCost;
  const raw = Math.floor((available * 1_000_000) / p.output);
  if (raw < 1500) return undefined;
  return Math.max(1500, Math.min(8000, raw));
}

function handbackFits(state: RunState): boolean {
  return state.contract.maxCostDollars - state.spend.total >= modelCostDollars(state, {
    cache_read_input_tokens: state.counters.lastModelInputTokens ?? 0,
    output_tokens: 1500,
  });
}

function isRetryableModelError(error: unknown): boolean {
  const rec = error && typeof error === "object" ? error as { name?: unknown; status?: unknown } : {};
  const status = typeof rec.status === "number" ? rec.status : undefined;
  return rec.name === "APIConnectionError" || rec.name === "RateLimitError" || status === 529 || (status !== undefined && status >= 500);
}

function stop(state: RunState, status: "done" | "stopped" | "error", reason: string) {
  state.status = status;
  state.stopReason = reason;
}

function spendLine(state: RunState): string {
  return `Spend: $${state.spend.total.toFixed(2)} of $${state.contract.maxCostDollars.toFixed(2)} · Leads: ${state.leads.length}/${state.contract.targetLeads} · Turn ${state.counters.turns}/${DEFAULT_LIMITS.maxTurns}`;
}

function userToolResultsMessage(state: RunState, results: ToolResultBlockParam[]): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      ...results,
      { type: "text", text: spendLine(state) },
    ],
  } as Anthropic.MessageParam;
}

function orderedResults(uses: ToolUseBlock[], results: ToolResultBlockParam[]): ToolResultBlockParam[] {
  const byId = new Map(results.map((result) => [result.tool_use_id, result]));
  return uses.map((tool) => byId.get(tool.id)).filter((result): result is ToolResultBlockParam => !!result);
}

function noProgressSnapshot(state: RunState) {
  return {
    leads: state.leads.length,
    candidates: state.caches.candidateCompanies.length,
    enrichments: Object.keys(state.caches.enrichmentByName).length,
    reads: state.adaptive.verificationReads,
  };
}

function madeProgress(state: RunState, before: ReturnType<typeof noProgressSnapshot>, decisionResumed: boolean): boolean {
  return (
    decisionResumed ||
    state.leads.length > before.leads ||
    state.caches.candidateCompanies.length > before.candidates ||
    Object.keys(state.caches.enrichmentByName).length > before.enrichments ||
    state.adaptive.verificationReads > before.reads
  );
}

function limitReason(state: RunState): { status: "done" | "stopped"; reason: string } | undefined {
  if (state.spend.total + DEFAULT_LIMITS.handbackReserveDollars >= state.contract.maxCostDollars) return { status: "stopped", reason: "budget" };
  if (state.counters.turns >= DEFAULT_LIMITS.maxTurns) return { status: "stopped", reason: "max_turns" };
  if (state.counters.activeMs >= DEFAULT_LIMITS.maxActiveMs) return { status: "stopped", reason: "max_active_ms" };
  if (state.counters.noProgressTurns >= DEFAULT_LIMITS.noProgressTurns) return { status: "stopped", reason: "no_progress" };
  if (state.leads.length >= state.contract.targetLeads) return { status: "done", reason: "target_leads" };
  return undefined;
}

async function finishRun(state: RunState, events: AgentEvent[], status: "done" | "stopped", reason: string, deps: LoopDeps) {
  if (state.leads.length < state.contract.targetLeads && !state.handback) {
    await handback(state, deps, events);
  }
  stop(state, status, reason);
  events.push(makeEvent(state, "stop", { reason, status }));
  await appendRunToMemory(state);
}

export async function step(state: RunState, deps: LoopDeps): Promise<StepResult> {
  const events: AgentEvent[] = [];
  if (state.status !== "running") return { state, events };
  // Pin before the first event so every event of the run carries the same promptVersion.
  const prompt = await ensureAgentPrompt(state);
  if (state.stopRequested) {
    delete state.stopRequested;
    if (state.leads.length < state.contract.targetLeads && !state.handback) {
      state.handback = codeHandback(state, rejectionCounts(state));
    }
    stop(state, "stopped", "user");
    events.push(makeEvent(state, "stop", { reason: "user", status: "stopped" }));
    await appendRunToMemory(state);
    await appendEvents(state.id, events);
    return { state, events };
  }

  const hit = limitReason(state);
  if (hit) {
    events.push(makeEvent(state, "policy", { scope: "loop", check: "limits", outcome: "stop", reason: hit.reason, status: hit.status, snapshot: policySnapshot(state) }));
    await finishRun(state, events, hit.status, hit.reason, deps);
    await appendEvents(state.id, events);
    return { state, events };
  }

  const started = Date.now();
  const beforeProgress = noProgressSnapshot(state);
  const before = statusSnapshot(state);
  const decisionResumed = state.resumedFromDecision === true;
  delete state.resumedFromDecision;
  state.counters.turns += 1;
  events.push(makeEvent(state, "policy", { scope: "loop", check: "limits", outcome: "pass", snapshot: policySnapshot(state) }));
  try {
    const maxTokens = maxTokensForTurn(state);
    if (maxTokens === undefined) {
      events.push(makeEvent(state, "policy", { scope: "loop", check: "max_tokens", outcome: "stop", reason: "budget", snapshot: policySnapshot(state) }));
      state.handback = codeHandback(state, rejectionCounts(state));
      stop(state, "stopped", "budget");
      events.push(makeEvent(state, "stop", { reason: "budget", status: "stopped" }));
      await appendRunToMemory(state);
      return { state, events };
    }
    const system = prompt.text;
    const tools = agentTools();
    const messageCount = state.messages.length;
    const response = (await deps.client.messages.create({
      model: state.model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages: state.messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: "medium" },
    } as Parameters<typeof deps.client.messages.create>[0])) as Message;
    const latencyMs = Date.now() - started;
    state.messages.push({ role: "assistant", content: response.content } as Anthropic.MessageParam);
    const claudeCost = addClaudeCost(state, response);
    state.counters.consecutiveErrors = 0;
    events.push(makeEvent(state, "model_call", { tokens: usageOf(response), claudeCost, latencyMs, ...modelCallFields(state, { system, tools, messageCount }, response) }));

    if (response.stop_reason === "end_turn") {
      await finishRun(state, events, "done", "end_turn", deps);
    } else if (response.stop_reason === "max_tokens") {
      stop(state, "error", "max_tokens");
      events.push(makeEvent(state, "error", { reason: "max_tokens" }));
    } else if (response.stop_reason === "refusal") {
      stop(state, "stopped", "refusal");
      events.push(makeEvent(state, "stop", { reason: "refusal", stop_details: (response as { stop_details?: unknown }).stop_details }));
    } else if (response.stop_reason === "tool_use") {
      const uses = toolUses(response);
      const approvalUses = uses.filter((tool) => APPROVAL_TOOLS.has(tool.name));
      const approval = approvalUses[0];
      const extraApprovalResults: ToolResultBlockParam[] = approvalUses.slice(1).map((tool) => ({
        type: "tool_result",
        tool_use_id: tool.id,
        content: "one approval request per turn",
        is_error: true,
      }));
      const runnable = uses.filter((tool) => !APPROVAL_TOOLS.has(tool.name));
      const preSubmit = runnable.filter((tool) => tool.name !== "submit_lead");
      const submit = runnable.filter((tool) => tool.name === "submit_lead");
      const cappedPreSubmit = preSubmit.slice(0, DEFAULT_LIMITS.maxParallelTools);
      const overflowPreSubmit: Awaited<ReturnType<typeof executeTool>>[] = preSubmit.slice(DEFAULT_LIMITS.maxParallelTools).map((tool) => ({
        result: {
          type: "tool_result",
          tool_use_id: tool.id,
          content: "too many parallel calls, retry next turn",
          is_error: true,
        } as ToolResultBlockParam,
        exaCost: 0,
      }));
      const guard = new CostGuard(Math.max(0, state.contract.maxCostDollars - state.spend.claude - DEFAULT_LIMITS.handbackReserveDollars));
      guard.spent = state.spend.exa;
      const executedPreSubmit = await Promise.all(cappedPreSubmit.map((tool) => executeTool(state, { id: tool.id, name: tool.name, input: tool.input }, deps, { guard })));
      const submitExecuted: Awaited<ReturnType<typeof executeTool>>[] = [];
      for (const tool of submit) {
        submitExecuted.push(await executeTool(state, { id: tool.id, name: tool.name, input: tool.input }, deps, { guard }));
      }
      state.spend.exa = guard.spent;
      state.spend.total = state.spend.claude + state.spend.exa;
      if (guard.breached) {
        events.push(makeEvent(state, "policy", { scope: "loop", check: "exa_guard", outcome: "stop", reason: "budget", snapshot: policySnapshot(state) }));
        state.handback = codeHandback(state, rejectionCounts(state));
        stop(state, "stopped", "budget");
        events.push(makeEvent(state, "stop", { reason: "budget", status: "stopped" }));
        await appendRunToMemory(state);
        return { state, events };
      }
      const all = [...executedPreSubmit, ...submitExecuted, ...overflowPreSubmit];
      const allResults = [...all.map((item) => item.result), ...extraApprovalResults];
      const ordered = orderedResults(uses, allResults);
      state.counters.toolCalls += uses.length;
      const useById = new Map(uses.map((tool) => [tool.id, tool]));
      for (const item of all) {
        const original = useById.get(item.result.tool_use_id);
        events.push(makeEvent(state, "tool_call", {
          tool: original?.name,
          input: eventInput(original?.name, original?.input),
          is_error: item.result.is_error === true,
          exaCost: item.exaCost,
          toolUseId: item.result.tool_use_id,
          latencyMs: item.latencyMs ?? 0,
          resultSummary: item.resultSummary ?? clipText(String(item.result.content ?? ""), 300),
        }));
        if (item.verdictEvent) events.push(makeEvent(state, "submit_verdict", item.verdictEvent));
      }
      if (approval) {
        const request = makeEvent(state, "approval_request", { tool: approval.name, input: approval.input });
        state.pendingApproval = {
          toolUseId: approval.id,
          tool: approval.name,
          input: approval.input,
          otherToolResults: ordered.filter((result) => result.tool_use_id !== approval.id),
          toolUseOrder: uses.map((tool) => tool.id),
          requestedAt: request.ts,
        };
        state.status = "awaiting_approval";
        events.push(request);
      } else {
        state.messages.push(userToolResultsMessage(state, ordered));
        if (all.some((item) => item.finish)) await finishRun(state, events, "done", "finish", deps);
      }
    } else {
      stop(state, "error", `unknown_stop:${String(response.stop_reason)}`);
    }
  } catch (error) {
    events.push(makeEvent(state, "error", { message: error instanceof Error ? error.message : "unknown error" }));
    if (isRetryableModelError(error)) {
      state.counters.consecutiveErrors = (state.counters.consecutiveErrors ?? 0) + 1;
      if (state.counters.consecutiveErrors >= 3) stop(state, "error", "model_or_loop_error");
      else state.status = "running";
    } else {
      stop(state, "error", "model_or_loop_error");
    }
  } finally {
    if (state.stopRequested && state.status === "running") {
      delete state.stopRequested;
      if (state.leads.length < state.contract.targetLeads && !state.handback) {
        state.handback = codeHandback(state, rejectionCounts(state));
      }
      stop(state, "stopped", "user");
      events.push(makeEvent(state, "stop", { reason: "user", status: "stopped" }));
      await appendRunToMemory(state);
    }
    const elapsed = Date.now() - started;
    state.counters.activeMs += elapsed;
    const progress = madeProgress(state, beforeProgress, decisionResumed);
    state.counters.noProgressTurns = progress ? 0 : state.counters.noProgressTurns + 1;
    events.push(makeEvent(state, "turn_end", {
      durationMs: elapsed,
      before,
      status: state.status,
      ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
      spend: { total: state.spend.total, claude: state.spend.claude, exa: state.spend.exa },
      leads: state.leads.length,
    }));
    await appendEvents(state.id, events);
  }
  return { state, events };
}

export async function decide(
  state: RunState,
  decision: { approve: boolean; note?: string; revisedValue?: unknown; toolUseId?: string },
): Promise<StepResult> {
  const events: AgentEvent[] = [];
  const pending = state.pendingApproval;
  if (!pending) throw new Error("no pending approval");
  if (state.status !== "awaiting_approval" || (decision.toolUseId !== undefined && decision.toolUseId !== pending.toolUseId)) {
    throw new Error("stale approval decision");
  }
  let content = decision.approve ? `approved${decision.note ? `: ${decision.note}` : ""}` : `declined${decision.note ? `: ${decision.note}` : ""}`;
  let decisionError: string | undefined;
  if (decision.approve && decision.revisedValue !== undefined) content = `revised${decision.note ? `: ${decision.note}` : ""}`;
  if (pending.tool === "propose_strategy") {
    state.strategyApproved = decision.approve;
  }
  let before: unknown;
  if (pending.tool === "request_scope_change") before = contractFieldBefore(state, pending.input);
  if (decision.approve && pending.tool === "request_scope_change") {
    try {
      applyScopeChange(state, pending.input, decision.revisedValue);
    } catch (error) {
      decisionError = error instanceof Error ? error.message : "invalid value";
      content = `declined: invalid value — ${decisionError}`;
    }
  }
  const approvalResult = { type: "tool_result", tool_use_id: pending.toolUseId, content } as ToolResultBlockParam;
  const otherById = new Map(pending.otherToolResults.map((result) => [result.tool_use_id, result]));
  const results = pending.toolUseOrder
    ? pending.toolUseOrder.map((id) => (id === pending.toolUseId ? approvalResult : otherById.get(id))).filter((result): result is ToolResultBlockParam => !!result)
    : [...pending.otherToolResults, approvalResult];
  state.messages.push({
    role: "user",
    content: [
      ...results,
      { type: "text", text: spendLine(state) },
    ],
  } as Anthropic.MessageParam);
  delete state.pendingApproval;
  state.status = "running";
  state.counters.noProgressTurns = 0;
  state.resumedFromDecision = true;
  const decidedAt = new Date().toISOString();
  events.push({
    ...makeEvent(state, "decision", { approve: decision.approve, note: decision.note, revisedValue: decision.revisedValue, ...(pending.tool === "request_scope_change" ? { before } : {}), ...(decisionError ? { error: decisionError } : {}) }),
    ts: decidedAt,
    tool: pending.tool,
    ...(pending.requestedAt ? { requestTs: pending.requestedAt, waitMs: Math.max(0, Date.parse(decidedAt) - Date.parse(pending.requestedAt)) } : {}),
  });
  await appendEvents(state.id, events);
  return { state, events };
}

/** The contract field's value before a scope change (null for fields with no stored value, e.g. industry). */
function contractFieldBefore(state: RunState, input: unknown): unknown {
  const field = (input as { change?: { field?: unknown } } | null)?.change?.field;
  if (field === "employeeRange" || field === "months" || field === "hqCountries" || field === "maxCostDollars") {
    return structuredClone(state.contract[field]);
  }
  return null;
}

function applyScopeChange(state: RunState, input: unknown, revisedValue?: unknown) {
  const record = input && typeof input === "object" ? (input as { change?: { field?: string; value?: unknown } }) : {};
  const field = record.change?.field;
  let value = revisedValue ?? record.change?.value;
  // The tool schema carries `value` as a JSON-encoded string (strict schemas
  // cannot express "any"); decode it, keeping plain strings (e.g. industry).
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* not JSON: keep the string */
    }
  }
  if (field === "employeeRange") {
    if (!value || typeof value !== "object") throw new Error("invalid employeeRange");
    const range = value as { min?: unknown; max?: unknown; unknownPolicy?: unknown };
    if (typeof range.min !== "number" || typeof range.max !== "number" || range.min > range.max) throw new Error("invalid employeeRange");
    state.contract.employeeRange = {
      min: range.min,
      max: range.max,
      unknownPolicy: range.unknownPolicy === "reject" ? "reject" : "allow-if-not-enterprise",
    };
  } else if (field === "months") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) throw new Error("invalid months");
    state.contract.months = value;
  } else if (field === "hqCountries") {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && /^[A-Z]{2}$/.test(v))) throw new Error("invalid hqCountries");
    state.contract.hqCountries = value;
  } else if (field === "maxCostDollars") {
    if (typeof value !== "number" || value <= 0 || value > 5) throw new Error("invalid maxCostDollars");
    state.contract.maxCostDollars = value;
  } else if (field === "industry") {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error("invalid industry");
    state.contract.companySummaryQuery = `${state.contract.companySummaryQuery} Prefer industry: ${value.trim()}.`;
  } else {
    throw new Error("invalid scope change field");
  }
}

/**
 * Server-side stop (the user's Stop button). No model call: the handback is
 * computed from the recorded rejections. Idempotent on finished runs.
 */
export async function stopRun(state: RunState): Promise<StepResult> {
  const events: AgentEvent[] = [];
  if (state.status !== "running" && state.status !== "awaiting_approval") return { state, events };
  if (state.leads.length < state.contract.targetLeads && !state.handback) {
    state.handback = codeHandback(state, rejectionCounts(state));
  }
  delete state.pendingApproval;
  stop(state, "stopped", "user");
  events.push(makeEvent(state, "stop", { reason: "user", status: "stopped" }));
  await appendEvents(state.id, events);
  await appendRunToMemory(state);
  return { state, events };
}

/**
 * Ask the model for a structured handback. With `events`, the model_call event joins the
 * caller's batch (so it lands in the same append, in order); without, it is appended now.
 */
export async function handback(state: RunState, deps: LoopDeps, events?: AgentEvent[]): Promise<Handback> {
  const counts = rejectionCounts(state);
  const fallback = codeHandback(state, counts);
  if (handbackFits(state)) {
    try {
      // History contains tool_use blocks, so the tool list must still be sent;
      // tool_choice "none" forces a text answer.
      const system = (await ensureAgentPrompt(state)).text;
      const tools = agentTools();
      const messages = [
        ...state.messages,
        { role: "user", content: `Return only JSON with exactly this shape: {"shortfall": string, "top_reasons": [{"code","count"}], "suggestions": [{"field","value","why"}] max 2}. Use these computed rejection counts: ${JSON.stringify({ shortfall: fallback.shortfall, top_reasons: fallback.top_reasons })}` },
      ];
      const started = Date.now();
      const response = (await deps.client.messages.create({
        model: state.model,
        max_tokens: 1500,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        tool_choice: { type: "none" },
        messages,
        cache_control: { type: "ephemeral" },
        output_config: { effort: "medium" },
      } as Parameters<typeof deps.client.messages.create>[0])) as Message;
      const latencyMs = Date.now() - started;
      const claudeCost = addClaudeCost(state, response);
      const event = makeEvent(state, "model_call", { tokens: usageOf(response), claudeCost, latencyMs, handback: true, ...modelCallFields(state, { system, tools, messageCount: messages.length }, response) });
      if (events) events.push(event);
      else await appendEvents(state.id, [event]);
      const text = response.content.find((b) => b.type === "text")?.text ?? "";
      state.handback = parseHandback(text) ?? fallback;
      return state.handback;
    } catch {
      state.handback = fallback;
      return fallback;
    }
  }
  state.handback = fallback;
  return fallback;
}

/** Submit-stage rejections plus lookup-stage screening, one count per (company, code). */
export function rejectionCounts(state: RunState): Array<{ code: string; count: number }> {
  const seen = new Set<string>();
  const map = new Map<string, number>();
  for (const r of [...state.rejected, ...(state.screened ?? [])]) {
    const id = `${squashName(r.company)}|${r.code}`;
    if (seen.has(id)) continue;
    seen.add(id);
    map.set(r.code, (map.get(r.code) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
}

// Country resolution lives in src/geo.ts (one table, state-code aware).
const countryOf = countryOfHq;

function enrichmentOf(state: RunState, company: string) {
  return state.caches.enrichmentByName[squashName(company)]?.summary;
}

function companiesWithCode(state: RunState, code: string): string[] {
  const names = new Map<string, string>();
  for (const r of [...state.rejected, ...(state.screened ?? [])]) {
    if (r.code === code) names.set(squashName(r.company), r.company);
  }
  return [...names.values()];
}

function suggestionFor(state: RunState, code: string): Handback["suggestions"][number] {
  const c = state.contract;
  const companies = companiesWithCode(state, code);
  if (code === "size") {
    const counts = companies
      .map((name) => parseEmployeeEstimate(enrichmentOf(state, name)?.employee_estimate))
      .filter((n): n is number => n !== undefined);
    const below = counts.filter((n) => n < c.employeeRange.min).length;
    const above = counts.filter((n) => n > c.employeeRange.max).length;
    if (counts.length > 0 && below > counts.length / 2) {
      return { field: "employeeRange", value: { min: Math.floor(c.employeeRange.min / 2), max: c.employeeRange.max }, why: `Most candidates turned down on size (${below} of ${counts.length}) were smaller than ${c.employeeRange.min} employees.` };
    }
    if (counts.length > 0 && above > counts.length / 2) {
      return { field: "employeeRange", value: { min: c.employeeRange.min, max: Math.ceil(c.employeeRange.max * 1.5) }, why: `Most candidates turned down on size (${above} of ${counts.length}) were larger than ${c.employeeRange.max} employees.` };
    }
    return { field: "none", value: "", why: counts.length > 0 ? "Candidates turned down on size fall on both sides of the range, so one change would not help." : "Not enough size data on the turned-down candidates to suggest a new range." };
  }
  if (code === "stale_date") {
    return c.months >= 12
      ? { field: "none", value: "", why: "Several signals were too old, but the look-back is already the 12-month maximum." }
      : { field: "months", value: Math.min(12, c.months + 3), why: "Several otherwise relevant signals were older than the look-back window." };
  }
  if (code === "hq") {
    const tally = new Map<string, number>();
    for (const name of companies) {
      const hq = enrichmentOf(state, name)?.hq;
      const country = typeof hq === "string" ? countryOf(hq) : undefined;
      if (country) tally.set(country, (tally.get(country) ?? 0) + 1);
    }
    if (tally.size >= 3) return { field: "hqCountries", value: "any", why: `Turned-down candidates were headquartered in ${tally.size} different countries.` };
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top && !c.hqCountries.includes(top)) {
      return { field: "hqCountries", value: [...c.hqCountries, top], why: `Most candidates turned down on location are headquartered in ${top}.` };
    }
    return { field: "none", value: "", why: "Candidates turned down on location are not concentrated in one country." };
  }
  if (code.startsWith("required_gate:")) {
    const key = code.slice("required_gate:".length);
    const question = c.gateFields.find((g) => g.key === key)?.question;
    return { field: "none", value: "", why: `${companies.length} candidates failed the required question "${question ?? key}". If it is too strict, edit that question in the plan.` };
  }
  if (code === "enterprise") {
    return { field: "none", value: "", why: "These are large companies; the contract is working as intended." };
  }
  return { field: "none", value: "", why: `Candidates were turned down for ${code}; no single plan change addresses it.` };
}

const UNVERIFIABLE_CODES = new Set(["no_enrichment", "entity_mismatch"]);
export const UNVERIFIABLE_WHY = "Most candidates couldn't be verified from public sources (no reliable company page, or records matched a similarly named company elsewhere). Widening size or recency won't help; this buyer type needs a different evidence source.";

export function codeHandback(state: RunState, top: Array<{ code: string; count: number }> = rejectionCounts(state)): Handback {
  const all = rejectionCounts(state);
  const unverifiable = all.filter((r) => UNVERIFIABLE_CODES.has(r.code)).reduce((n, r) => n + r.count, 0);
  const size = all.find((r) => r.code === "size")?.count ?? 0;
  const topTwo = top.slice(0, 2);
  if (unverifiable > size) {
    // Unverifiable candidates dominate size rejections: widening the range cannot help.
    const rest = topTwo
      .filter((r) => !UNVERIFIABLE_CODES.has(r.code) && r.code !== "size")
      .map(({ code }) => suggestionFor(state, code));
    return {
      shortfall: `${state.leads.length} of ${state.contract.targetLeads}`,
      top_reasons: topTwo,
      suggestions: [{ field: "none", value: "", why: UNVERIFIABLE_WHY }, ...rest].slice(0, 2),
    };
  }
  return {
    shortfall: `${state.leads.length} of ${state.contract.targetLeads}`,
    top_reasons: topTwo,
    suggestions: topTwo.map(({ code }) => suggestionFor(state, code)),
  };
}

/** Handback for a run stopped because the visitor's dollar allowance ran out. */
export function allowanceHandback(state: RunState): Handback {
  const base = codeHandback(state, rejectionCounts(state));
  return { ...base, top_reasons: [{ code: "visitor_allowance", count: 1 }, ...base.top_reasons].slice(0, 2) };
}

function parseHandback(text: string): Handback | undefined {
  try {
    const parsed = JSON.parse(text) as Handback;
    if (typeof parsed.shortfall !== "string" || !Array.isArray(parsed.top_reasons) || !Array.isArray(parsed.suggestions)) return undefined;
    if (parsed.suggestions.length > 2) return undefined;
    if (!parsed.top_reasons.every((r) => typeof r?.code === "string" && typeof r.count === "number")) return undefined;
    if (!parsed.suggestions.every((s) => typeof s?.field === "string" && "value" in s && typeof s.why === "string")) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
