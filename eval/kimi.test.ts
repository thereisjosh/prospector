import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Temp RUNS_DIR / WORKSPACES_DIR; placeholder keys only (no real key is read or needed).
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "kimi-test-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  delete process.env.DEMO_MODE;
  return { root, runs: join(root, "runs") };
});
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODELS, claudeCostDollars, contextBudgetTokens, isAgentModel, MODEL_REGISTRY, providerOf, providers } from "../src/agent/config";
import { clientOptions, createModelClient, KIMI_MAX_TOKENS, ProviderConfigError, ProviderShapeError, shapeKimiRequest } from "../src/agent/providers";
import { measureRequestTokens } from "../src/agent/context";
import { createRunState, type RunState } from "../src/agent/state";
import { step } from "../src/agent/loop";
import type { AgentEvent } from "../src/agent/events";
import type { SearchPlan } from "../src/plan";
import { normalizeArm, runCell } from "./harness/run-cell";
import { ARM_MODELS, type Verdict } from "./harness/types";
import { comparisonTruthRoot, judgeBlind, judgeLead, parseJudgeModelName } from "./harness/judge";
import { fetchPageText, htmlToText, KIMI_JUDGE_MAX_SEARCHES } from "./harness/judge-kimi";
import { moonshotSearch, searchEndpoint } from "../src/judges/moonshot-search";
import { evidenceJudge } from "../src/judges/evidence";
import { fakeVerdictClient, runEvidenceCalibration, type CalibrationSource } from "./online/calibrate-evidence-judge";
import { calibrationDatasetName } from "./online/calibration-set";
import { judgeMessages } from "./online/judge-prompt";
import { truthKey } from "./harness/truth";

afterAll(() => rmSync(tmp.root, { recursive: true, force: true }));

const KIMI = AGENT_MODELS.kimi;
const ENV = { KIMI_API_KEY: "kimi-test-key", ANTHROPIC_API_KEY: "anthropic-must-not-leak" };

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function headerMap(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers as HeadersInit).forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function jsonFetch(reply: unknown, captured: Captured[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), headers: headerMap(init), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const kimiMessage = (content: unknown[], stop_reason = "end_turn", usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) =>
  ({ id: "msg_kimi", type: "message", role: "assistant", model: KIMI, content, stop_reason, stop_sequence: null, usage });

describe("provider registry and cost", () => {
  it("selects the provider by model id and refuses unknown ids", () => {
    expect(providerOf("claude-opus-5-5")).toBe("anthropic");
    expect(providerOf("claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOf("kimi-k2.6")).toBe("kimi");
    expect(() => providerOf("kimi-k9")).toThrow(/unknown model/);
    expect(isAgentModel("kimi-k2.6")).toBe(true);
    expect(isAgentModel("gpt-5.5")).toBe(false);
    expect(providers.kimi).toMatchObject({ baseURL: "https://api.moonshot.ai/anthropic", apiKeyEnv: "KIMI_API_KEY", authMode: "authToken", countTokens: false });
    expect(providers.anthropic).toMatchObject({ baseURL: undefined, apiKeyEnv: "ANTHROPIC_API_KEY" });
    expect(MODEL_REGISTRY[KIMI].contextWindow).toBe(262_144);
    expect(contextBudgetTokens(KIMI)).toBe(Math.floor(262_144 * 0.6));
  });

  it("prices usage by model id (Moonshot: $0.95 in, $4 out, $0.16 cached per million)", () => {
    const million = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
    expect(claudeCostDollars(KIMI, million)).toBeCloseTo(0.95 + 4 + 0.16, 10);
    expect(claudeCostDollars("claude-sonnet-5-5", million)).toBeCloseTo(2 + 10 + 0.2, 10);
    expect(claudeCostDollars("claude-opus-5-5", million)).toBeCloseTo(4 + 20 + 0.2, 10);
  });
});

describe("client factory", () => {
  it("anthropic models get a plain new Anthropic() (no behaviour change)", () => {
    expect(createModelClient("claude-opus-5-5")).toBeInstanceOf(Anthropic);
    expect(clientOptions("anthropic", ENV)).toEqual({});
  });

  it("kimi: refuses without KIMI_API_KEY (no fallback, no call)", () => {
    expect(() => createModelClient(KIMI, { env: { ANTHROPIC_API_KEY: "x" } })).toThrow(ProviderConfigError);
  });

  it("kimi: bearer auth to Moonshot's /anthropic base, never the Anthropic key; KIMI_BASE_URL overrides", async () => {
    expect(clientOptions("kimi", ENV)).toEqual({ baseURL: "https://api.moonshot.ai/anthropic", authToken: "kimi-test-key", apiKey: null });
    expect(clientOptions("kimi", { ...ENV, KIMI_BASE_URL: "https://api.moonshot.cn/anthropic" })!.baseURL).toBe("https://api.moonshot.cn/anthropic");
    const captured: Captured[] = [];
    const client = createModelClient(KIMI, { env: ENV, fetch: jsonFetch(kimiMessage([{ type: "text", text: "ok" }]), captured), maxRetries: 0 });
    await client.messages.create({ model: KIMI, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(captured[0]!.url).toBe("https://api.moonshot.ai/anthropic/v1/messages");
    expect(captured[0]!.headers.authorization).toBe("Bearer kimi-test-key");
    expect(captured[0]!.headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(captured[0]!.headers)).not.toContain("anthropic-must-not-leak");
  });
});

describe("kimi request shaping", () => {
  const loopRequest = {
    model: KIMI,
    max_tokens: 64_000,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "lookup_company", description: "d", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, strict: true, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "go", cache_control: { type: "ephemeral" } }] }],
    cache_control: { type: "ephemeral" },
    output_config: { effort: "medium" },
    thinking: { type: "adaptive" },
    temperature: 0.2,
    tool_choice: { type: "tool", name: "lookup_company", disable_parallel_tool_use: true },
  };

  it("drops thinking/effort/sampling, un-forces tool_choice, keeps only the top-level cache marker, clamps max_tokens", () => {
    const { params, changes } = shapeKimiRequest(loopRequest);
    const p = params as Record<string, unknown>;
    expect(p.thinking).toBeUndefined();
    expect(p.temperature).toBeUndefined();
    expect(p.output_config).toBeUndefined();
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify([p.system, p.tools, p.messages])).not.toContain("cache_control");
    expect((p.tools as Array<Record<string, unknown>>)[0]!.strict).toBeUndefined();
    expect((p.tools as Array<Record<string, unknown>>)[0]!.input_schema).toEqual(loopRequest.tools[0]!.input_schema);
    expect(p.max_tokens).toBe(KIMI_MAX_TOKENS);
    expect(changes).toEqual(expect.arrayContaining(["dropped thinking", "dropped output_config.effort=medium", "tool_choice tool -> auto", "stripped block-level cache_control"]));
    // The caller's object is not mutated.
    expect(loopRequest.thinking).toEqual({ type: "adaptive" });
  });

  it("keeps tool_choice none (the handback call) and output_config.format", () => {
    const { params } = shapeKimiRequest({ model: KIMI, max_tokens: 10, messages: [], tool_choice: { type: "none" }, output_config: { effort: "medium", format: { type: "json_schema", schema: {} } } });
    expect((params as Record<string, unknown>).tool_choice).toEqual({ type: "none" });
    expect((params as Record<string, unknown>).output_config).toEqual({ format: { type: "json_schema", schema: {} } });
  });

  it("refuses Anthropic server tools instead of silently dropping them", () => {
    expect(() => shapeKimiRequest({ model: KIMI, max_tokens: 10, messages: [], tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] })).toThrow(ProviderShapeError);
  });

  it("the kimi client sends the shaped request", async () => {
    const captured: Captured[] = [];
    const client = createModelClient(KIMI, { env: ENV, fetch: jsonFetch(kimiMessage([{ type: "text", text: "ok" }]), captured), maxRetries: 0 });
    // Non-streaming: the SDK itself refuses max_tokens above ~21k without streaming (10-minute rule), so 9000 here.
    await client.messages.create({ ...loopRequest, max_tokens: 9000 } as never);
    const body = captured[0]!.body;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.max_tokens).toBe(9000);
    expect(JSON.stringify(body.tools)).not.toContain("strict");
  });
});

const plan: SearchPlan = {
  label: "Kimi loop",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
};

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("count_tokens preflight and the loop on kimi", () => {
  it("measureRequestTokens never calls count_tokens for kimi: estimate with the reason", async () => {
    const countTokens = vi.fn(async () => ({ input_tokens: 5 }));
    const out = await measureRequestTokens({ model: KIMI, messages: [{ role: "user", content: "hello" }], tokenCount: undefined }, { messages: { countTokens } } as never, { system: "s", tools: [] });
    expect(countTokens).not.toHaveBeenCalled();
    expect(out.source).toBe("estimated");
    expect(out.error).toMatch(/Anthropic-only/);
  });

  it("one streamed turn through the real SDK + Moonshot client: shaped body, thinking block kept, kimi-priced cost, token_count_estimated", async () => {
    const captured: Captured[] = [];
    const body = sse([
      { type: "message_start", message: { id: "msg_k1", type: "message", role: "assistant", model: KIMI, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 300 } },
      { type: "message_stop" },
    ]);
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), headers: headerMap(init), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = createModelClient(KIMI, { env: ENV, fetch: fetchImpl, maxRetries: 0 });
    const state = { ...createRunState({ id: crypto.randomUUID(), workspaceId: `ws-${crypto.randomUUID().slice(0, 8)}`, plan, model: KIMI, createdAt: "2026-10-16T00:00:00.000Z" }), strategyApproved: true, handback: { shortfall: "0 of 10", top_reasons: [], suggestions: [] } } as RunState;
    const result = await step(state, { client, checkLead: () => ({ ok: false, code: "size", reason: "x" }) } as never);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.moonshot.ai/anthropic/v1/messages");
    expect(captured[0]!.body.stream).toBe(true);
    expect(captured[0]!.body.model).toBe(KIMI);
    expect(captured[0]!.body.thinking).toBeUndefined();
    expect(captured[0]!.body.output_config).toBeUndefined();
    expect(captured[0]!.body.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(captured[0]!.body.system)).not.toContain("cache_control");
    const kinds = result.events.map((e: AgentEvent) => e.kind);
    expect(kinds).toContain("token_count_estimated");
    const estimated = result.events.find((e) => e.kind === "token_count_estimated") as unknown as { reason: string };
    expect(estimated.reason).toMatch(/Anthropic-only; provider kimi/);
    const call = result.events.find((e) => e.kind === "model_call") as unknown as { claudeCost: number; model: string };
    expect(call.model).toBe(KIMI);
    expect(call.claudeCost).toBeCloseTo((1000 * 0.95 + 300 * 4) / 1_000_000, 12);
    expect(result.state.status).toBe("done");
    // The thinking block (with its signature) is kept in history, as Moonshot asks.
    const last = result.state.messages[result.state.messages.length - 1] as { content: Array<{ type: string; signature?: string }> };
    expect(last.content[0]).toMatchObject({ type: "thinking", signature: "sig" });
  });
});

describe("arm D", () => {
  it("normalizes D and runs kimi-k2.6 through the same cell path", async () => {
    expect(normalizeArm("D")).toBe("D_agent_kimi");
    expect(normalizeArm("D_agent_kimi")).toBe("D_agent_kimi");
    expect(ARM_MODELS.D_agent_kimi).toBe(KIMI);
    const root = mkdtempSync(join(tmp.root, "cells-"));
    const fakeDrive = vi.fn(async (state: RunState) => {
      state.status = "done";
      state.stopReason = "target_leads";
      state.spend = { exa: 0.1, claude: 0.05, total: 0.15 };
      return state;
    });
    const createClient = vi.fn(() => ({ messages: { create: vi.fn() } }) as never);
    const scenario = { id: "S1", label: "S1", plan, targetLeads: 2, maxCostDollars: 1 };
    const out = await runCell(scenario, "D_agent_kimi", 1, { driveRun: fakeDrive as never, createClient, checkLead: vi.fn() as never, resultsRoot: root, runSetId: "kimi-set" });
    expect(fakeDrive.mock.calls[0]![0].model).toBe(KIMI);
    expect(fakeDrive.mock.calls[0]![0].workspaceId).toBe("eval-S1-D_agent_kimi-1");
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(out.arm).toBe("D_agent_kimi");
    expect(existsSync(join(root, "kimi-set/S1/D_agent_kimi/1/run.json"))).toBe(true);
  });
});

const lead = {
  company: "Acme Freight",
  signal_url: "https://news.example/acme-warehouse",
  why_now: "Opened a new warehouse in Dallas",
  event_date: "2026-09-20",
  size_basis: "quoted",
};

describe("offline judge --model kimi", () => {
  it("parses --model", () => {
    expect(parseJudgeModelName(undefined)).toBe("opus");
    expect(parseJudgeModelName("kimi")).toBe("kimi");
    expect(() => parseJudgeModelName("gpt")).toThrow();
  });

  it("round trip: web_search (Moonshot, fake) + web_fetch (fake) as client tools, last JSON parsed, cost by model + search, written outside eval/truth", async () => {
    const root = mkdtempSync(join(tmp.root, "judge-"));
    const truthRoot = comparisonTruthRoot("kimi", "set1", root);
    const verdictJson = { q1: "yes", q1_source: "acme.example", q2: "yes", q2_source: "linkedin", q3: "yes", q3_source: lead.signal_url, note: "ok" };
    const usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const replies = [
      kimiMessage([{ type: "thinking", thinking: "t", signature: "s" }, { type: "tool_use", id: "t1", name: "web_search", input: { query: "Acme Freight employees" } }], "tool_use", usage),
      kimiMessage([{ type: "tool_use", id: "t2", name: "web_fetch", input: { url: lead.signal_url } }], "tool_use", usage),
      kimiMessage([{ type: "text", text: `draft {"q1":"no","q2":"no","q3":"no"}\nfinal ${JSON.stringify(verdictJson)}` }], "end_turn", usage),
    ];
    const requests: Array<Record<string, unknown>> = [];
    const client = { messages: { create: vi.fn(async (p: Record<string, unknown>) => { requests.push(JSON.parse(JSON.stringify(p))); return replies.shift(); }) } };
    const search = vi.fn(async () => [{ title: "Acme Freight", url: "https://acme.example/about", snippet: "200 employees", chunks: [{ text: "Acme Freight has 200 employees", score: 0.9 }] }]);
    const fetchPage = vi.fn(async (url: string) => ({ ok: true as const, url, title: "Acme opens Dallas warehouse", text: "Acme Freight opened a warehouse on 2026-09-20." }));
    const verdict = await judgeLead({ scenarioId: "S1", lead: lead as never, client: client as never, rubricText: "RUBRIC", truthRoot, model: "kimi", search, fetchPage, setId: "set1", resultsRoot: root });
    expect(verdict).toMatchObject({ judge: "kimi", q1: "yes", q2: "yes", q3: "yes", good: true, webSearches: 1, webFetches: 1, q3_basis: "fetched" });
    expect(search).toHaveBeenCalledWith("Acme Freight employees");
    expect(fetchPage).toHaveBeenCalledWith(lead.signal_url);
    expect(verdict.costDollars).toBeCloseTo(3 * claudeCostDollars(KIMI, usage) + 0.003, 12);
    // Same rubric + same user prompt; client tools named like the Opus judge's server tools.
    expect(requests[0]!.model).toBe(KIMI);
    expect((requests[0]!.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
    expect(requests[0]!.system).toBe("RUBRIC");
    // The tool results went back as tool_result blocks after the assistant turn (thinking block included).
    const third = requests[2]!.messages as Array<{ role: string; content: unknown }>;
    expect(third.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(JSON.stringify(third[2]!.content)).toContain("200 employees");
    expect(JSON.stringify(third[4]!.content)).toContain("opened a warehouse");
    const file = join(truthRoot, "S1", `${truthKey(lead.company, lead.signal_url)}.json`);
    expect(JSON.parse(readFileSync(file, "utf8")).judge).toBe("kimi");
  });

  it("caps web_search at 3 (the 4th call gets an error result) and refuses to write eval/truth", async () => {
    const root = mkdtempSync(join(tmp.root, "judge-cap-"));
    const searchUse = (id: string) => kimiMessage([{ type: "tool_use", id, name: "web_search", input: { query: id } }], "tool_use");
    const replies = [searchUse("a"), searchUse("b"), searchUse("c"), searchUse("d"), kimiMessage([{ type: "text", text: '{"q1":"yes","q1_source":"x","q2":"cannot_verify","q2_source":"","q3":"yes","q3_source":"y","note":"via corroborating source"}' }])];
    const requests: Array<Record<string, unknown>> = [];
    const client = { messages: { create: vi.fn(async (p: Record<string, unknown>) => { requests.push(JSON.parse(JSON.stringify(p))); return replies.shift(); }) } };
    const search = vi.fn(async () => [{ title: "t", url: "https://x.example" }]);
    const verdict = await judgeLead({ scenarioId: "S1", lead: lead as never, client: client as never, rubricText: "R", truthRoot: comparisonTruthRoot("kimi", "s", root), model: "kimi", search, fetchPage: vi.fn() });
    expect(search).toHaveBeenCalledTimes(KIMI_JUDGE_MAX_SEARCHES);
    expect(verdict.webSearches).toBe(3);
    const lastMessages = requests[4]!.messages as Array<{ content: unknown }>;
    expect(JSON.stringify(lastMessages[lastMessages.length - 1]!.content)).toContain("web_search limit reached (3)");
    expect(verdict.q3_basis).toBe("corroborated");
    await expect(judgeLead({ scenarioId: "S1", lead: lead as never, client: client as never, model: "kimi" })).rejects.toThrow(/outside eval\/truth/);
  });

  it("judgeBlind --model kimi writes judge-cost-kimi.json and an agreement report against the stored Opus verdicts", async () => {
    const root = mkdtempSync(join(tmp.root, "blind-"));
    const authority = join(root, "truth");
    await mkdir(join(root, "set1/S1"), { recursive: true });
    await writeFile(join(root, "set1/S1/blind.json"), JSON.stringify([lead]));
    const opus: Verdict = { company: lead.company, signal_url: lead.signal_url, scenarioId: "S1", q1: "yes", q1_source: "", q2: "no", q2_source: "", q3: "yes", q3_source: "", good: false, judgedAt: "2026-10-14T00:00:00Z", judge: "opus" };
    await mkdir(join(authority, "S1"), { recursive: true });
    await writeFile(join(authority, "S1", `${truthKey(lead.company, lead.signal_url)}.json`), JSON.stringify(opus));
    const client = { messages: { create: vi.fn(async () => kimiMessage([{ type: "text", text: '{"q1":"yes","q1_source":"a","q2":"yes","q2_source":"b","q3":"cannot_verify","q3_source":"","note":""}' }])) } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await judgeBlind({ setId: "set1", scenarioId: "S1", resultsRoot: root, client: client as never, model: "kimi", authorityRoot: authority, search: vi.fn(), fetchPage: vi.fn() });
    log.mockRestore();
    const agreement = JSON.parse(readFileSync(join(root, "set1/S1/judge-agreement-kimi.json"), "utf8"));
    expect(agreement).toMatchObject({ model: KIMI, compared: 1, fields: { q1: { agree: 1, total: 1 }, q2: { agree: 0, total: 1 }, q3: { agree: 0, total: 1 }, good: { agree: 1, total: 1 } } });
    expect(JSON.parse(readFileSync(join(root, "set1/S1/judge-cost-kimi.json"), "utf8")).model).toBe(KIMI);
    expect(existsSync(join(root, "set1/S1/judge-cost.json"))).toBe(false);
    // The authority file is untouched.
    expect(JSON.parse(readFileSync(join(authority, "S1", `${truthKey(lead.company, lead.signal_url)}.json`), "utf8")).judge).toBe("opus");
  });

  it("moonshotSearch posts to /v1/tools/search_pro with bearer auth and errors on an unexpected shape", async () => {
    expect(searchEndpoint("https://api.moonshot.ai/anthropic")).toBe("https://api.moonshot.ai/v1/tools/search_pro");
    const captured: Captured[] = [];
    const results = await moonshotSearch("acme", { apiKey: "k", fetch: jsonFetch({ search_results: [{ title: "A", url: "https://a.example", chunks: [] }] }, captured) });
    expect(results).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.moonshot.ai/v1/tools/search_pro");
    expect(captured[0]!.headers.authorization).toBe("Bearer k");
    expect(captured[0]!.body).toMatchObject({ text_query: "acme", limit: 5 });
    await expect(moonshotSearch("acme", { apiKey: "k", fetch: jsonFetch({ data: [] }, []) })).rejects.toThrow(/no search_results/);
    await expect(moonshotSearch("acme", { apiKey: "", fetch: jsonFetch({}, []) })).rejects.toThrow(/KIMI_API_KEY is not set/);
  });

  it("fetchPageText reduces HTML to text, reports HTTP errors and blocks private hosts", async () => {
    const page = htmlToText("<html><head><title>T</title><style>x{}</style></head><body><p>Hello &amp; welcome</p><script>bad()</script></body></html>");
    expect(page.title).toBe("T");
    expect(page.text).toContain("Hello & welcome");
    expect(page.text).not.toMatch(/bad\(\)|x\{\}|<p>/);
    const ok = await fetchPageText("https://a.example/p", (async () => new Response("<html><body>Acme</body></html>", { status: 200, headers: { "content-type": "text/html" } })) as never);
    expect(ok).toMatchObject({ ok: true, text: "Acme" });
    const notFound = await fetchPageText("https://a.example/p", (async () => new Response("", { status: 404 })) as never);
    expect(notFound).toEqual({ ok: false, url: "https://a.example/p", error: "http_404" });
    expect(await fetchPageText("http://127.0.0.1/admin", vi.fn() as never)).toMatchObject({ ok: false, error: "blocked_host" });
  });
});

describe("evidence-only judge", () => {
  const payload = { company: "Acme Freight", signal_url: lead.signal_url, why_now: lead.why_now, contract: {}, contract_summary: {}, evidence: {} };

  it("evidenceJudge(payload, { model: 'kimi' }) asks each question with the repo prompt and returns yes/no/cannot_verify", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const scores = ["yes", "no", "cannot_verify"];
    const client = { messages: { create: vi.fn(async (p: Record<string, unknown>) => {
      requests.push(p);
      return kimiMessage([{ type: "tool_use", id: "v", name: "verdict", input: { reasoning: "evidence says so", score: scores[requests.length - 1] } }], "tool_use", { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    }) } };
    const out = await evidenceJudge(payload as never, { model: "kimi", client: client as never, rubric: "RUBRIC TEXT" });
    expect(out.model).toBe(KIMI);
    expect(out.answers.judge_q1?.score).toBe("yes");
    expect(out.answers.judge_q2?.score).toBe("no");
    expect(out.answers.judge_q3?.score).toBe("cannot_verify");
    expect(out.costDollars).toBeCloseTo(3 * claudeCostDollars(KIMI, { input_tokens: 3000, output_tokens: 400 }), 12);
    expect(requests[0]!.system).toBe("RUBRIC TEXT");
    expect(requests[0]!.max_tokens).toBe(4000);
    expect(requests[0]!.tool_choice).toBeUndefined();
    const user = (requests[0]!.messages as Array<{ content: string }>)[0]!.content;
    expect(user).toContain(judgeMessages("judge_q1", "RUBRIC TEXT")[1]!.content.split("{{lead}}")[0]);
    expect(user).toContain('"company": "Acme Freight"');
    expect(user.endsWith("Answer by calling the `verdict` tool exactly once.")).toBe(true);
  });

  it("a reply without the verdict tool is 'invalid', not a guess", async () => {
    const client = { messages: { create: vi.fn(async () => kimiMessage([{ type: "text", text: "I think yes" }])) } };
    const out = await evidenceJudge(payload as never, { model: "sonnet", client: client as never, rubric: "R", questions: ["judge_q2"] });
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.answers.judge_q2?.score).toBe("invalid");
  });
});

describe("calibrate-evidence-judge", () => {
  const rubric = "RUBRIC";
  const source = (promptMatches: boolean): CalibrationSource => ({
    dataset: {
      get: vi.fn(async (name: string) => ({
        items: [
          { id: `${name}-1`, input: { company: "Acme", signal_url: "https://a.example" }, expectedOutput: "yes" },
          { id: `${name}-2`, input: { company: "Beta", signal_url: "https://b.example" }, expectedOutput: "no" },
        ],
      })),
    },
    api: { prompts: { get: vi.fn(async (name: string) => ({ version: 3, prompt: promptMatches ? judgeMessages(name.replace("judge-calibration/", "") as never, rubric) : [{ role: "user", content: "old" }] })) } },
  });

  it("dry run: fetches the three sets, judges every item with a fake client, prints accuracy + mismatches, writes nothing", async () => {
    const lines: string[] = [];
    const out = await runEvidenceCalibration(source(true), { model: "kimi", mode: "dry-run", rubric, log: (l) => lines.push(l), resultsRoot: join(tmp.root, "never") });
    expect(out.model).toBe(KIMI);
    expect(out.reports.map((r) => [r.judge, r.correct, r.total, r.errors])).toEqual([["judge_q1", 1, 2, 0], ["judge_q2", 1, 2, 0], ["judge_q3", 1, 2, 0]]);
    expect(out.reports.every((r) => r.promptMatchesLangfuse)).toBe(true);
    expect(lines.some((l) => l.includes("judge_q1: 1/2 correct, 0 errors"))).toBe(true);
    expect(lines.some((l) => l.includes("| Beta · https://b.example | no | yes"))).toBe(true);
    expect(existsSync(join(tmp.root, "never"))).toBe(false);
    expect(out.spent).toBe(0);
    expect(calibrationDatasetName("judge_q1")).toBe("judge-calibration/judge_q1");
  });

  it("reports a Langfuse/repo prompt drift and refuses --run without the provider key before touching Langfuse", async () => {
    const lines: string[] = [];
    await runEvidenceCalibration(source(false), { model: "kimi", mode: "estimate", rubric, log: (l) => lines.push(l), questions: ["judge_q1"] });
    expect(lines[0]).toMatch(/DIFFERS from the repo prompt/);
    const src = source(true);
    await expect(runEvidenceCalibration(src, { model: "kimi", mode: "run", maxDollars: 1, rubric, env: {} })).rejects.toThrow(ProviderConfigError);
    expect(src.dataset.get).not.toHaveBeenCalled();
  });

  it("--run with a client writes the per-model report and sums cost", async () => {
    const root = mkdtempSync(join(tmp.root, "cal-"));
    const out = await runEvidenceCalibration(source(true), { model: "sonnet", mode: "run", maxDollars: 5, rubric, client: fakeVerdictClient("no"), resultsRoot: root, log: () => undefined, questions: ["judge_q3"] });
    expect(out.reports[0]!.path).toMatch(/calibration\/\d{4}-\d{2}-\d{2}\/judge_q3\.evidence-claude-sonnet-5-5\.json$/);
    expect(JSON.parse(readFileSync(out.reports[0]!.path!, "utf8"))).toMatchObject({ judge: "judge_q3", model: "claude-sonnet-5-5", correct: 1, total: 2 });
  });
});
