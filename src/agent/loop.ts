import Anthropic from "@anthropic-ai/sdk";
import type { Message, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { CostGuard } from "../exa";
import { claudeCostDollars, DEFAULT_LIMITS } from "./config";
import { appendEvents, eventInput, makeEvent, type AgentEvent } from "./events";
import { appendRunToMemory } from "./memory";
import { systemPrompt } from "./prompts";
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

function toolUses(response: Message): ToolUseBlock[] {
  return response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

function addClaudeCost(state: RunState, response: Message): number {
  const cost = claudeCostDollars(state.model, response.usage);
  state.spend.claude += cost;
  state.spend.total = state.spend.claude + state.spend.exa;
  return cost;
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
    await handback(state, deps);
  }
  stop(state, status, reason);
  events.push(makeEvent(state, "stop", { reason, status }));
  await appendRunToMemory(state);
}

export async function step(state: RunState, deps: LoopDeps): Promise<StepResult> {
  const events: AgentEvent[] = [];
  if (state.status !== "running") return { state, events };

  const hit = limitReason(state);
  if (hit) {
    await finishRun(state, events, hit.status, hit.reason, deps);
    await appendEvents(state.id, events);
    return { state, events };
  }

  const started = Date.now();
  const beforeProgress = noProgressSnapshot(state);
  const decisionResumed = state.resumedFromDecision === true;
  delete state.resumedFromDecision;
  state.counters.turns += 1;
  try {
    const response = (await deps.client.messages.create({
      model: state.model,
      max_tokens: 8000,
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: agentTools(),
      messages: state.messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: "medium" },
    } as Parameters<typeof deps.client.messages.create>[0])) as Message;
    const latencyMs = Date.now() - started;
    state.messages.push({ role: "assistant", content: response.content } as Anthropic.MessageParam);
    const claudeCost = addClaudeCost(state, response);
    events.push(makeEvent(state, "model_call", { tokens: usageOf(response), claudeCost, latencyMs }));

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
      const guard = new CostGuard(Math.max(0, state.contract.maxCostDollars - state.spend.claude));
      guard.spent = state.spend.exa;
      const executedPreSubmit = await Promise.all(cappedPreSubmit.map((tool) => executeTool(state, { id: tool.id, name: tool.name, input: tool.input }, deps, { guard })));
      const submitExecuted: Awaited<ReturnType<typeof executeTool>>[] = [];
      for (const tool of submit) {
        submitExecuted.push(await executeTool(state, { id: tool.id, name: tool.name, input: tool.input }, deps, { guard }));
      }
      state.spend.exa = guard.spent;
      state.spend.total = state.spend.claude + state.spend.exa;
      const all = [...executedPreSubmit, ...submitExecuted, ...overflowPreSubmit];
      const allResults = [...all.map((item) => item.result), ...extraApprovalResults];
      const ordered = orderedResults(uses, allResults);
      state.counters.toolCalls += uses.length;
      const useById = new Map(uses.map((tool) => [tool.id, tool]));
      for (const item of all) {
        const original = useById.get(item.result.tool_use_id);
        events.push(makeEvent(state, "tool_call", { tool: original?.name, input: eventInput(original?.name, original?.input), is_error: item.result.is_error === true, exaCost: item.exaCost }));
        if (item.verdictEvent) events.push(makeEvent(state, "submit_verdict", item.verdictEvent));
      }
      if (approval) {
        state.pendingApproval = {
          toolUseId: approval.id,
          tool: approval.name,
          input: approval.input,
          otherToolResults: ordered.filter((result) => result.tool_use_id !== approval.id),
          toolUseOrder: uses.map((tool) => tool.id),
        };
        state.status = "awaiting_approval";
        events.push(makeEvent(state, "approval_request", { tool: approval.name, input: approval.input }));
      } else {
        state.messages.push(userToolResultsMessage(state, ordered));
        if (all.some((item) => item.finish)) await finishRun(state, events, "done", "finish", deps);
      }
    } else {
      stop(state, "error", `unknown_stop:${String(response.stop_reason)}`);
    }
  } catch (error) {
    stop(state, "error", "model_or_loop_error");
    events.push(makeEvent(state, "error", { message: error instanceof Error ? error.message : "unknown error" }));
  } finally {
    const elapsed = Date.now() - started;
    state.counters.activeMs += elapsed;
    const progress = madeProgress(state, beforeProgress, decisionResumed);
    state.counters.noProgressTurns = progress ? 0 : state.counters.noProgressTurns + 1;
    await appendEvents(state.id, events);
  }
  return { state, events };
}

export async function decide(
  state: RunState,
  decision: { approve: boolean; note?: string; revisedValue?: unknown },
): Promise<StepResult> {
  const events: AgentEvent[] = [];
  const pending = state.pendingApproval;
  if (!pending) throw new Error("no pending approval");
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
  events.push(makeEvent(state, "decision", { approve: decision.approve, note: decision.note, revisedValue: decision.revisedValue, ...(pending.tool === "request_scope_change" ? { before } : {}), ...(decisionError ? { error: decisionError } : {}) }));
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

export async function handback(state: RunState, deps: LoopDeps): Promise<Handback> {
  const counts = rejectionCounts(state);
  const fallback = codeHandback(state, counts);
  if (state.spend.total < state.contract.maxCostDollars) {
    try {
      // History contains tool_use blocks, so the tool list must still be sent;
      // tool_choice "none" forces a text answer.
      const response = (await deps.client.messages.create({
        model: state.model,
        max_tokens: 1500,
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        tools: agentTools(),
        tool_choice: { type: "none" },
        messages: [
          ...state.messages,
          { role: "user", content: `Return only JSON with exactly this shape: {"shortfall": string, "top_reasons": [{"code","count"}], "suggestions": [{"field","value","why"}] max 2}. Use these computed rejection counts: ${JSON.stringify({ shortfall: fallback.shortfall, top_reasons: fallback.top_reasons })}` },
        ],
        cache_control: { type: "ephemeral" },
        output_config: { effort: "medium" },
      } as Parameters<typeof deps.client.messages.create>[0])) as Message;
      addClaudeCost(state, response);
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

function rejectionCounts(state: RunState): Array<{ code: string; count: number }> {
  const map = new Map<string, number>();
  for (const r of state.rejected) map.set(r.code, (map.get(r.code) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
}

function codeHandback(state: RunState, top: Array<{ code: string; count: number }>): Handback {
  return {
    shortfall: `${state.leads.length} of ${state.contract.targetLeads}`,
    top_reasons: top.slice(0, 2),
    suggestions: top.slice(0, 2).map(({ code }) => {
      if (code === "size") return { field: "employeeRange", value: { ...state.contract.employeeRange, max: state.contract.employeeRange.max * 2 }, why: "Several candidates missed the size range." };
      if (code === "stale_date") return { field: "months", value: Math.min(12, state.contract.months + 3), why: "Several otherwise relevant signals were stale." };
      if (code === "hq") return { field: "hqCountries", value: "any", why: "Several candidates were outside the current HQ countries." };
      if (code.startsWith("required_gate:")) return { field: code.slice("required_gate:".length), value: "relax", why: `Required gate ${code.slice("required_gate:".length)} blocked candidates.` };
      return { field: "scope", value: "review", why: `Rejections clustered around ${code}.` };
    }),
  };
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
