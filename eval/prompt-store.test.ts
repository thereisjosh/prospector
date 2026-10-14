import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Langfuse Prompt Management (docs/prompts.md), all with a mocked Langfuse client:
 * fallback, per-run version pinning, generation↔prompt links, and the sync CLI's diff/push/pull.
 */
const tmp = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "prompt-store-"));
  process.env.RUNS_DIR = join(root, "runs");
  process.env.WORKSPACES_DIR = join(root, "workspaces");
  process.env.DATA_DIR = root;
  return { root };
});

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { SearchPlan } from "../src/plan";
import { createRunState, saveState, type RunState } from "../src/agent/state";
import { step } from "../src/agent/loop";
import type { AgentEvent } from "../src/agent/events";
import { __setTraceTestHooks, flush, toObservations } from "../src/agent/trace";
import { AGENT_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT_DEF, PROMPT_VERSION } from "../src/agent/prompts";
import { __setPromptClientForTests, PROMPT_CACHE_TTL_SECONDS, resolvePrompt, type PromptClient } from "../src/agent/prompt-store";
import { CARDS_PROMPT_DEF, CARDS_SYSTEM_PROMPT, suggestCards } from "../src/planner/cards";
import { COMPILE_PROMPT_DEF } from "../src/planner/compile";
import { tracePlanner } from "../src/agent/trace";
import { DEFAULT_MODEL } from "../src/agent/config";
import {
  diffPrompts,
  PROMPT_SOURCES,
  pullPrompts,
  pushPrompts,
  renderBlock,
  replaceBlock,
  templateLiteral,
  type SyncClient,
} from "./langfuse-prompts";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const ON = { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" };

const plan = (): SearchPlan => ({
  label: "Prompt store test",
  months: 3,
  signalQueries: ["warehouse expansion"],
  signalSummaryQuery: "summarize signals",
  companySummaryQuery: "firmographics",
  gateFields: [{ key: "is_operator", question: "Is it an operator?", required: true }],
  employeeRange: { min: 50, max: 500, unknownPolicy: "allow-if-not-enterprise" },
  hqCountries: ["US"],
  excludeDomains: [],
  excludeNames: [],
  signalTypes: ["expansion"],
});

function msg(content: unknown[]) {
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
  };
}
const todo = (id: string) => msg([{ type: "tool_use", id, name: "update_todo", input: { markdown: `- ${id}` } }]);

function anthropic(...responses: unknown[]) {
  return { messages: { create: vi.fn(async (_args: { system: Array<{ text: string; cache_control?: unknown }> }) => responses.shift()) } };
}

/** A Langfuse prompt client whose `production` label can be moved between calls. */
function langfuse(versions: Record<number, string>, production: number) {
  const state = { production };
  const get = vi.fn(async (name: string, options: { label?: string }) => {
    const version = options.label === "production" || options.label === undefined ? state.production : Number.NaN;
    if (!(version in versions)) throw Object.assign(new Error("not found"), { statusCode: 404 });
    return { name, version, type: "text", prompt: versions[version], isFallback: false };
  });
  return { client: { prompt: { get } } as unknown as PromptClient, get, state };
}

function setEnv(on: boolean) {
  process.env.LANGFUSE_PUBLIC_KEY = on ? ON.LANGFUSE_PUBLIC_KEY : "";
  process.env.LANGFUSE_SECRET_KEY = on ? ON.LANGFUSE_SECRET_KEY : "";
  process.env.LANGFUSE_PROMPTS = on ? "" : "off";
}

class FakeExporter implements SpanExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

beforeEach(() => setEnv(false));
afterEach(async () => {
  setEnv(false);
  __setPromptClientForTests(undefined);
  await __setTraceTestHooks(undefined);
});
afterAll(() => rm(tmp.root, { recursive: true, force: true }));

describe("prompt store: resolve + fallback", () => {
  it("uses the in-repo text, without touching Langfuse, when the keys are unset", async () => {
    const lf = langfuse({ 3: "remote v3" }, 3);
    __setPromptClientForTests(lf.client);
    const pin = await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: {} });
    expect(pin).toMatchObject({ source: "repo", version: null, id: PROMPT_VERSION, text: AGENT_SYSTEM_PROMPT });
    expect(lf.get).not.toHaveBeenCalled();
  });

  it("LANGFUSE_PROMPTS=off forces the in-repo text even with keys set", async () => {
    const lf = langfuse({ 3: "remote v3" }, 3);
    __setPromptClientForTests(lf.client);
    const pin = await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: { ...ON, LANGFUSE_PROMPTS: "off" } });
    expect(pin.source).toBe("repo");
    expect(lf.get).not.toHaveBeenCalled();
  });

  it("fetches by the production label with the documented 60 s cache TTL and the repo text as SDK fallback", async () => {
    const lf = langfuse({ 3: "remote v3" }, 3);
    __setPromptClientForTests(lf.client);
    const pin = await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: ON });
    expect(pin).toMatchObject({ source: "langfuse", name: "prospector-agent-system", version: 3, label: "production", id: "prospector-agent-system@3", text: "remote v3" });
    expect(PROMPT_CACHE_TTL_SECONDS).toBe(60);
    expect(lf.get).toHaveBeenCalledWith("prospector-agent-system", expect.objectContaining({ label: "production", type: "text", cacheTtlSeconds: 60, fallback: AGENT_SYSTEM_PROMPT }));
  });

  it("falls back to the repo text when Langfuse is unreachable, returns the SDK fallback, or serves a chat prompt", async () => {
    const throwing = { prompt: { get: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) } } as unknown as PromptClient;
    __setPromptClientForTests(throwing);
    expect((await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: ON })).source).toBe("repo");

    const sdkFallback = { prompt: { get: vi.fn(async (name: string) => ({ name, version: 0, type: "text", prompt: AGENT_SYSTEM_PROMPT, isFallback: true })) } } as unknown as PromptClient;
    __setPromptClientForTests(sdkFallback);
    expect(await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: ON })).toMatchObject({ source: "repo", id: PROMPT_VERSION });

    const chat = { prompt: { get: vi.fn(async (name: string) => ({ name, version: 5, type: "chat", prompt: [{ role: "system", content: "x" }], isFallback: false })) } } as unknown as PromptClient;
    __setPromptClientForTests(chat);
    expect((await resolvePrompt(AGENT_SYSTEM_PROMPT_DEF, { env: ON })).source).toBe("repo");
  });

  it("config holds the model/effort defaults the code uses", () => {
    expect(AGENT_SYSTEM_PROMPT_DEF.config).toEqual({ model: DEFAULT_MODEL, effort: "medium" });
    expect(CARDS_PROMPT_DEF.config).toEqual({ model: DEFAULT_MODEL, effort: "medium", max_tokens: 4000 });
    expect(COMPILE_PROMPT_DEF.config).toEqual({ model: DEFAULT_MODEL, effort: "medium", max_tokens: 4000 });
  });
});

describe("prompt store: one version per run", () => {
  it("pins the fetched version for every turn; a label move mid-run changes nothing; events and generations carry the link", async () => {
    setEnv(true);
    const exporter = new FakeExporter();
    await __setTraceTestHooks({ exporter, onScore: () => undefined });
    const lf = langfuse({ 3: "SYSTEM v3", 4: "SYSTEM v4" }, 3);
    __setPromptClientForTests(lf.client);

    const s: RunState = createRunState({ id: crypto.randomUUID(), workspaceId: "ws", plan: plan(), createdAt: NOW.toISOString() });
    await saveState(s);
    expect(s.prompt).toBeUndefined();
    const c = anthropic(todo("t1"), todo("t2"), todo("t3"));
    const deps = { client: c as never, checkLead: (() => ({ ok: false, code: "x", reason: "x" })) as never, now: NOW };

    await step(s, deps);
    expect(s.prompt).toMatchObject({ name: "prospector-agent-system", version: 3, source: "langfuse", text: "SYSTEM v3" });

    lf.state.production = 4; // someone promotes v4 while the run is in flight
    await step(s, deps);
    await step(s, deps);

    // Resolved once, at the first step; never re-fetched.
    expect(lf.get).toHaveBeenCalledTimes(1);
    const systems = c.messages.create.mock.calls.map(([args]) => args.system);
    expect(systems).toHaveLength(3);
    for (const system of systems) expect(system).toEqual([{ type: "text", text: "SYSTEM v3", cache_control: { type: "ephemeral" } }]);

    // The pin survives a save/load (another process continuing the run).
    const persisted = JSON.parse(JSON.stringify(s)) as RunState;
    expect(persisted.prompt?.text).toBe("SYSTEM v3");

    // Every event carries the pinned id; model_call events carry the Langfuse link.
    const { readLastEvents } = await import("../src/agent/events");
    const events = (await readLastEvents(s.id, 200)) as AgentEvent[];
    expect(new Set(events.map((e) => e.promptVersion))).toEqual(new Set(["prospector-agent-system@3"]));
    const calls = events.filter((e) => e.kind === "model_call");
    expect(calls).toHaveLength(3);
    for (const e of calls) expect(e.prompt).toEqual({ name: "prospector-agent-system", version: 3 });

    // Mapped generations carry it, and the exported OTel spans hold the SDK prompt attributes.
    const generations = toObservations(events).flatMap((t) => t.observations).filter((o) => o.type === "generation");
    expect(generations.map((g) => g.prompt)).toEqual([1, 2, 3].map(() => ({ name: "prospector-agent-system", version: 3 })));
    await flush();
    const spans = exporter.spans.filter((sp) => sp.attributes["langfuse.observation.type"] === "generation");
    expect(spans).toHaveLength(3);
    for (const sp of spans) {
      expect(sp.attributes["langfuse.observation.prompt.name"]).toBe("prospector-agent-system");
      expect(sp.attributes["langfuse.observation.prompt.version"]).toBe(3);
    }
  });

  it("a run already in flight without a pin keeps the in-repo text instead of fetching", async () => {
    setEnv(true);
    await __setTraceTestHooks({ exporter: new FakeExporter(), onScore: () => undefined });
    const lf = langfuse({ 9: "SYSTEM v9" }, 9);
    __setPromptClientForTests(lf.client);
    const s: RunState = createRunState({ id: crypto.randomUUID(), workspaceId: "ws", plan: plan(), createdAt: NOW.toISOString() });
    s.counters.turns = 2;
    s.messages.push({ role: "assistant", content: [{ type: "text", text: "earlier" }] }, { role: "user", content: "go on" });
    const c = anthropic(todo("t1"));
    await step(s, { client: c as never, checkLead: (() => ({ ok: false, code: "x", reason: "x" })) as never, now: NOW });
    expect(lf.get).not.toHaveBeenCalled();
    expect(s.prompt).toMatchObject({ source: "repo", id: PROMPT_VERSION });
    expect(c.messages.create.mock.calls[0]![0].system[0]!.text).toBe(AGENT_SYSTEM_PROMPT);
  });

  it("repo fallback: generations carry no prompt link (docs: fallback prompts are not linked)", async () => {
    const s: RunState = createRunState({ id: crypto.randomUUID(), workspaceId: "ws", plan: plan(), createdAt: NOW.toISOString() });
    const c = anthropic(todo("t1"));
    await step(s, { client: c as never, checkLead: (() => ({ ok: false, code: "x", reason: "x" })) as never, now: NOW });
    const { readLastEvents } = await import("../src/agent/events");
    const events = (await readLastEvents(s.id, 50)) as AgentEvent[];
    expect(events.every((e) => e.promptVersion === PROMPT_VERSION)).toBe(true);
    const call = events.find((e) => e.kind === "model_call")!;
    expect(call).not.toHaveProperty("prompt");
    expect(toObservations(events).flatMap((t) => t.observations).find((o) => o.type === "generation")).not.toHaveProperty("prompt");
  });
});

describe("planner prompts", () => {
  const profile = { offering: "Payment terminals for cafes", buyer_roles: [], geo_served: [], competitors: [], existing_customers: [] };
  const cards = {
    who: { industry: "cafes", descriptor: "independent cafes" },
    whyNow: { signalTypes: ["new_location", "hiring_ops"], description: "opening outlets" },
    size: { min: 5, max: 200, unknownPolicy: "allow-if-not-enterprise" },
    geo: { hqCountries: ["SG"] },
    recency: { months: 6 },
    exclusions: { names: [], domains: [] },
    rationale: {},
    alternatives: [],
  };

  it("one fetched version serves the call and its retry, the retry repeats that version's format section, and the generation is linked", async () => {
    setEnv(true);
    const exporter = new FakeExporter();
    await __setTraceTestHooks({ exporter, onScore: () => undefined });
    const remote = CARDS_SYSTEM_PROMPT.replace("You suggest lead-search cards", "V2: You suggest lead-search cards").replace("no markdown fences.", "no markdown fences (v2).");
    const lf = langfuse({ 2: remote }, 2);
    __setPromptClientForTests(lf.client);
    const responses = [{ ...cards, size: { ...cards.size, unknownPolicy: "maybe" } }, cards].map((c) => ({ content: [{ type: "text", text: JSON.stringify(c) }], usage: { input_tokens: 10, output_tokens: 10 } }));
    const create = vi.fn(async (_args: { system: string; messages: { content: string }[] }) => responses.shift()!);
    await tracePlanner("cards", "ws", profile, () => suggestCards(profile, { client: { messages: { create } } as never }), (r) => r);
    await flush();
    expect(lf.get).toHaveBeenCalledTimes(1);
    expect(create.mock.calls.map(([a]) => a.system)).toEqual([remote, remote]);
    expect(create.mock.calls[1]![0].messages[0]!.content).toContain("no markdown fences (v2).");
    const gens = exporter.spans.filter((sp) => sp.name === "planner-model");
    expect(gens).toHaveLength(2);
    for (const sp of gens) {
      expect(sp.attributes["langfuse.observation.prompt.name"]).toBe("prospector-planner-cards");
      expect(sp.attributes["langfuse.observation.prompt.version"]).toBe(2);
    }
  });
});

describe("sync CLI (eval/langfuse-prompts.ts)", () => {
  type Remote = { version: number; type: string; prompt: unknown; config: unknown; labels: string[] };
  function server(initial: Record<string, Remote[]> = {}) {
    const store: Record<string, Remote[]> = structuredClone(initial);
    const client: SyncClient = {
      api: {
        prompts: {
          get: vi.fn(async (name: string, { label }: { label: string }) => {
            const versions = store[name] ?? [];
            const hit = label === "latest" ? versions.at(-1) : versions.find((v) => v.labels.includes(label));
            if (!hit) throw Object.assign(new Error("Prompt not found"), { statusCode: 404 });
            return structuredClone(hit);
          }),
        },
      },
      prompt: {
        create: vi.fn(async (body) => {
          const versions = (store[body.name] ??= []);
          for (const v of versions) v.labels = v.labels.filter((l) => !body.labels.includes(l));
          const created = { version: versions.length + 1, type: body.type, prompt: body.prompt, config: body.config, labels: body.labels };
          versions.push(created);
          return { version: created.version };
        }),
        update: vi.fn(async ({ name, version, newLabels }) => {
          for (const v of store[name] ?? []) v.labels = v.version === version ? newLabels : v.labels.filter((l) => !newLabels.includes(l));
          return {};
        }),
      },
    };
    return { client, store };
  }
  const inSync = () =>
    Object.fromEntries(PROMPT_SOURCES.map((s) => [s.def.name, [{ version: 1, type: "text", prompt: s.def.text, config: s.def.config, labels: ["production"] }]]));

  it("diff reports same when Langfuse matches the repo, and detects text, config and missing divergence", async () => {
    expect((await diffPrompts(server(inSync()).client, "production")).map((r) => r.status)).toEqual(["same", "same", "same"]);

    const drifted = inSync();
    drifted["prospector-agent-system"]![0]!.prompt = AGENT_SYSTEM_PROMPT.replace("research agent", "research assistant");
    drifted["prospector-planner-cards"]![0]!.config = { model: "claude-sonnet-5-5", effort: "medium", max_tokens: 4000 };
    delete drifted["prospector-planner-compile"];
    const results = await diffPrompts(server(drifted).client, "production");
    expect(results.map((r) => r.status)).toEqual(["differs", "differs", "missing"]);
    expect(results[0]!.details[0]).toMatch(/line 1/);
    expect(results[1]!.details[0]).toMatch(/config differs/);
  });

  it("push creates a version only when text/config differ, and re-labels instead of duplicating", async () => {
    const empty = server();
    expect((await pushPrompts(empty.client, "production")).map((r) => [r.action, r.version])).toEqual([["created", 1], ["created", 1], ["created", 1]]);
    expect((await pushPrompts(empty.client, "production")).map((r) => r.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(empty.client.prompt.create).toHaveBeenCalledTimes(3);
    expect(await diffPrompts(empty.client, "production")).toSatisfy((rs: Array<{ status: string }>) => rs.every((r) => r.status === "same"));

    // Production moved to an edited v2; v1 (the repo text) is no longer the latest → a new version.
    const moved = inSync();
    moved["prospector-agent-system"]!.push({ version: 2, type: "text", prompt: "edited in Langfuse", config: {}, labels: ["production"] });
    moved["prospector-agent-system"]![0]!.labels = [];
    const s1 = server(moved);
    expect((await pushPrompts(s1.client, "production"))[0]).toEqual({ name: "prospector-agent-system", action: "created", version: 3 });

    // Repo text is already the latest version (e.g. pushed to staging): only the label moves.
    const staged = inSync();
    staged["prospector-agent-system"]![0]!.labels = ["staging"];
    staged["prospector-agent-system"]!.unshift({ version: 0, type: "text", prompt: "old", config: {}, labels: ["production"] });
    const s2 = server(staged);
    expect((await pushPrompts(s2.client, "production"))[0]).toEqual({ name: "prospector-agent-system", action: "labelled", version: 1 });
    expect(s2.client.prompt.update).toHaveBeenCalledWith({ name: "prospector-agent-system", version: 1, newLabels: ["staging", "production"] });
  });

  it("pull rewrites only the prompt block, byte-exactly, and refuses a planner prompt without its format section", async () => {
    const { readFile } = await import("node:fs/promises");
    const files: Record<string, string> = {};
    for (const s of PROMPT_SOURCES) files[s.file] = await readFile(s.file, "utf8");
    const io = { read: async (f: string) => files[f]!, write: vi.fn(async (f: string, t: string) => { files[f] = t; }) };

    // In sync: nothing written (the rendered block equals the committed one).
    expect((await pullPrompts(server(inSync()).client, "production", PROMPT_SOURCES, io)).map((r) => r.changed)).toEqual([false, false, false]);
    expect(io.write).not.toHaveBeenCalled();

    // A remote edit with characters that need escaping round-trips exactly.
    const tricky = AGENT_SYSTEM_PROMPT + "\nUse `code`, ${not_a_var}, a backslash \\ and {{langfuse_var}}.";
    const edited = inSync();
    edited["prospector-agent-system"]![0]!.prompt = tricky;
    const results = await pullPrompts(server(edited).client, "production", PROMPT_SOURCES, io);
    expect(results.map((r) => r.changed)).toEqual([true, false, false]);
    const literal = /export const AGENT_SYSTEM_PROMPT = (`[\s\S]*?`);\nexport const AGENT_SYSTEM_CONFIG/.exec(files["src/agent/prompts.ts"]!)![1]!;
    expect(new Function(`return ${literal};`)()).toBe(tricky);
    expect(files["src/agent/prompts.ts"]!.replace(literal, templateLiteral(AGENT_SYSTEM_PROMPT))).toBe(await readFile("src/agent/prompts.ts", "utf8"));

    const broken = inSync();
    broken["prospector-planner-cards"]![0]!.prompt = "no format section";
    await expect(pullPrompts(server(broken).client, "production", PROMPT_SOURCES, io)).rejects.toThrow(/must contain/);
  });

  it("renderBlock/replaceBlock are the exact inverse for every committed prompt", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const s of PROMPT_SOURCES) {
      const text = await readFile(s.file, "utf8");
      expect(text).toContain(renderBlock(s, s.def.text, s.def.config));
      expect(replaceBlock(text, s, s.def.text, s.def.config)).toBe(text);
    }
  });
});
