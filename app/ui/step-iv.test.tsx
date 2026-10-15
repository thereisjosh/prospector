/**
 * UI step (iv): the memory panel (groups, provenance, the budget-stop line) and the handback's gate-code
 * translation. The run view is rendered from the demo recording (eval/demo/run) at every stage it shows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events";
import { codeHandback } from "../../src/agent/loop";
import type { RunState } from "../../src/agent/state";
import type { CardSet } from "../../src/planner/cards";
import { HANDBACK, MEMORY_COPY, REASON_CODES, handbackReason, handbackWhy, plainText, reasonGroup } from "./copy";
import { MemoryPanel, budgetStoppedWithoutNote, type LastRun } from "./Memory";
import { RunView } from "./RunView";
import type { MemoryView, RunSnapshot } from "./types";

const ROOT = join(import.meta.dirname, "..", "..");
const DEMO = join(ROOT, "eval", "demo", "run");
const events = readFileSync(join(DEMO, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
const state = JSON.parse(readFileSync(join(DEMO, "state.json"), "utf8"));
const contract = state.initialContract ?? state.contract;
const cards = JSON.parse(readFileSync(join(ROOT, "eval", "demo", "planner", "cards.json"), "utf8")).cards as CardSet;
const noop = () => undefined;

/** Every GateCode in src/gates.ts, read from the source so a new code is covered the day it is added. */
const GATE_CODES = (() => {
  const src = readFileSync(join(ROOT, "src", "gates.ts"), "utf8");
  const union = /export type GateCode =([\s\S]*?);/.exec(src)?.[1] ?? "";
  return [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
})();

/** All text a user can read or hear: text nodes plus aria-label / title / placeholder values. */
function readable(html: string): string {
  const attrs = [...html.matchAll(/\s(?:aria-label|title|placeholder|aria-valuetext)="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, " ");
  return [text, ...attrs].join(" \n ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** A code leaks raw ("quote_not_in_page"), as "required_gate:", or humanized ("quote not in page") where its own phrase doesn't say so. */
function leaks(text: string): string[] {
  const found: string[] = [];
  if (/required_gate:/.test(text)) found.push("required_gate:");
  for (const code of GATE_CODES) {
    if (!code.includes("_")) continue; // "size", "hq", "duplicate", "enterprise" are ordinary words
    if (new RegExp(`\\b${code}\\b`).test(text)) found.push(code);
    const spaced = code.replace(/_/g, " ");
    const ownPhrase = reasonGroup(code, "").toLowerCase();
    if (!ownPhrase.includes(spaced) && new RegExp(`\\b${spaced}\\b`, "i").test(text)) found.push(spaced);
  }
  return found;
}

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "demo-x",
    status: "stopped",
    stopReason: state.stopReason,
    summary: state.summary,
    spend: state.spend,
    counters: state.counters,
    contract,
    leads: state.leads,
    candidates: state.candidates ?? [],
    rejected: state.rejected,
    screened: [],
    todo: state.todo,
    handback: state.handback,
    ...over,
  } as RunSnapshot;
}

function run(snap: RunSnapshot, evs: AgentEvent[], extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(RunView, {
      demo: true, snapshot: snap, events: evs, screened: { skipped: [], lookedUp: [] }, stepping: false, pausedByUser: false,
      runError: "", deciding: false, decisionError: "", onStop: noop, onResume: noop, onDecide: noop, feedback: {}, onFeedback: noop,
      cards: null, maxSpend: 1, onApply: noop, applying: false, onEditTargeting: noop, onNewSearch: noop, ...extra,
    }),
  );
}

describe("handback: gate codes are translated, never shown", () => {
  it("the gate-code list is read from src/gates.ts and every code has a phrase", () => {
    expect(GATE_CODES).toContain("quote_not_in_page");
    expect(GATE_CODES.length).toBeGreaterThan(15);
    for (const code of GATE_CODES) expect(REASON_CODES, code).toContain(code);
  });

  it("the demo recording's legacy prose renders as words (the leak that shipped)", () => {
    const legacy = state.handback.suggestions.find((s: { why: string }) => s.why.includes("quote_not_in_page"));
    expect(legacy).toBeDefined(); // the fixture still carries the old prose: this is the backwards-compatible path
    expect(handbackReason(legacy, state.handback)).toEqual({ code: "quote_not_in_page", count: 3 });
    const why = handbackWhy(legacy, contract, state.handback);
    expect(why).toBe("3 candidates were turned down because: quote not found on the source page. No single change to the plan addresses that.");
    expect(leaks(why)).toEqual([]);
  });

  it("the loop emits { code, count } next to the prose, and the UI words it from the code", () => {
    const hb = codeHandback(state as RunState);
    const generic = hb.suggestions.find((s) => s.reason?.code === "quote_not_in_page");
    expect(generic).toMatchObject({ field: "none", reason: { code: "quote_not_in_page", count: 3 } });
    expect(generic!.why).toContain("quote_not_in_page"); // kept for older readers
    expect(handbackWhy(generic!, contract, hb)).toBe(HANDBACK.reasonWhy({ code: "quote_not_in_page", count: 3 }, contract));
    // A required gate is worded from the contract's own question.
    const gate = contract.gateFields[0];
    const gateWhy = HANDBACK.reasonWhy({ code: `required_gate:${gate.key}`, count: 4 }, contract);
    expect(gateWhy).toMatch(/^4 candidates failed the required question "/);
    expect(leaks(gateWhy)).toEqual([]);
  });

  it("plainText swaps any bare gate code in model-written advice for its phrase", () => {
    expect(plainText("Several were unquoted_signal and some non_event_page.", contract)).not.toMatch(/_|unquoted signal|non event page/);
    expect(plainText("Rejections clustered around enterprise.", contract)).toBe("Rejections clustered around large enterprise or public company.");
  });

  it("no gate code appears anywhere in the rendered run view for the demo run (results, with and without a one-click patch)", () => {
    for (const html of [run(snapshot(), events), run(snapshot(), events, { cards })]) {
      const text = readable(html);
      expect(leaks(text)).toEqual([]);
      expect(text).toContain("What the agent suggests");
      expect(text).toContain("quote not found on the source page");
    }
  });

  it("no gate code in the live and approval views either", () => {
    const request = events.find((e) => e.kind === "approval_request")!;
    const upTo = events.indexOf(request) + 1;
    const live = run(snapshot({ status: "running", handback: undefined, summary: undefined }), events.filter((e) => e.turn <= 8), { stepping: true });
    const approval = run(
      snapshot({ status: "awaiting_approval", handback: undefined, summary: undefined, pendingApproval: { toolUseId: "u1", tool: String(request.tool), input: request.input } }),
      events.slice(0, upTo),
    );
    expect(leaks(readable(live))).toEqual([]);
    expect(leaks(readable(approval))).toEqual([]);
  });

  it("handback suggestions are Suggestion rows: one-click when a patch exists, never a primary button per row", () => {
    const html = run(snapshot(), events, { cards });
    expect(html).toContain('class="pr-handback-row"');
    expect(html).toMatch(/pr-suggestion[^"]*"[^>]*>Apply and run again<\/button>/);
    const outcome = html.slice(html.indexOf('id="outcome-h"'), html.indexOf('id="leads-h"'));
    expect(outcome).not.toContain("primary-btn");
  });
});

describe("MemoryPanel (SSR): groups, provenance, budget-stop line", () => {
  const view: MemoryView = {
    seenCount: 3,
    seen: [
      { id: "s1", name: "Acme Corp", squashed: "acmecorp", verdict: "accepted", reason: "accepted", runId: "9cb72d3f-844f-4571", at: "2026-10-15T09:00:00.000Z" },
      { id: "s2", name: "Bolt Ltd", squashed: "boltltd", verdict: "rejected", reason: "size: x", runId: "9cb72d3f-844f-4571", at: "2026-10-03T09:00:00.000Z" },
    ],
    preferences: [{ id: "p1", company: "Acme Corp", verdict: "up", reason: "right size", runId: "run-2", at: "2026-10-13T09:00:00.000Z" }],
    notes: [{ id: "n1", text: "Lease news found mid-size 3PLs.", tags: ["3pl"], runId: "9cb72d3f-844f-4571", at: "2026-10-12T09:00:00.000Z", expiresAt: "2026-12-11T09:00:00.000Z" }],
    preferenceNotes: [],
  };
  const panel = (v: MemoryView | null, lastRun?: LastRun) =>
    renderToStaticMarkup(h(MemoryPanel, { memory: v, error: false, onClear: noop, onForget: noop, disabled: false, lastRun }));
  const groups = (html: string) => [...html.matchAll(/<section class="memory-group" aria-label="([^"]+)"/g)].map((m) => m[1]);

  it("three Trace sections, in order, one line per item with provenance as the description", () => {
    const html = panel(view);
    expect(groups(html)).toEqual([MEMORY_COPY.seenHeading, MEMORY_COPY.feedbackHeading, MEMORY_COPY.learnedHeading]);
    expect(html).toContain('data-slot="trace"');
    expect(html.match(/data-slot="trace-line"/g)).toHaveLength(4);
    expect(html).toMatch(/data-slot="trace-description"[^>]*>delivered 15 Oct · run 9cb72d3f</);
    expect(html).toMatch(/>turned down 3 Oct · run 9cb72d3f</);
    expect(html).toMatch(/>Liked 13 Oct · run run-2</);
    expect(html).toMatch(/>saved 12 Oct · expires 11 Dec · run 9cb72d3f</);
    expect(html).toContain("3 companies already seen. Future runs skip them.");
    expect(html).toContain("Showing the latest 2 of 3.");
  });

  it("forget is an icon button per item with its label; clear-all asks first (no window.confirm)", () => {
    const html = panel(view);
    expect(html.match(/class="memory-forget"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="Forget your feedback on Acme Corp"');
    expect(html).toMatch(/class="memory-forget"[^>]*><svg/);
    expect(html).toContain(">Clear memory</button>");
    expect(html).not.toContain(MEMORY_COPY.clearQuestion); // the Confirmation appears only after a click
    const src = readFileSync(join(ROOT, "app", "ui", "Memory.tsx"), "utf8");
    expect(src).not.toMatch(/window\.confirm|\bconfirm\(/);
  });

  it("is a Collapsible whose panel stays mounted (closed by default; the open state is restored from localStorage)", () => {
    const html = panel(view);
    const tag = (slot: string, out: string) => new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`).exec(out)?.[0] ?? "";
    expect(tag("collapsible-trigger", html)).toContain('aria-expanded="false"');
    expect(tag("collapsible-content", html)).toContain('hidden=""');
    const open = renderToStaticMarkup(h(MemoryPanel, { memory: view, error: false, onClear: noop, onForget: noop, disabled: false, defaultOpen: true }));
    expect(tag("collapsible-trigger", open)).toContain('aria-expanded="true"');
  });

  it("a budget stop with no self-note says why there is no note, and only then", () => {
    const line = MEMORY_COPY.noNoteBudget;
    expect(line).toBe("No note this time; the run stopped at its budget before the agent could save one.");
    const none = { ...view, notes: [] };
    // budget + 0 notes: the learned group appears just for the line
    const budget = panel(none, { stopReason: "budget", selfNotes: 0 });
    expect(groups(budget)).toContain(MEMORY_COPY.learnedHeading);
    expect(budget).toContain(line);
    // every other ending: no line, and the empty group stays hidden
    for (const lastRun of [{ stopReason: "finish", selfNotes: 0 }, { stopReason: "target_leads", selfNotes: 0 }, { stopReason: "budget", selfNotes: 1 }, undefined]) {
      const html = panel(none, lastRun);
      expect(html).not.toContain(line);
      expect(groups(html)).not.toContain(MEMORY_COPY.learnedHeading);
    }
    // older notes stay listed under the line
    const withOld = panel(view, { stopReason: "budget", selfNotes: 0 });
    expect(withOld.indexOf(line)).toBeLessThan(withOld.indexOf("Lease news found mid-size 3PLs."));
    // an otherwise empty memory still says it, instead of "Nothing yet"
    const empty = panel({ ...view, seen: [], seenCount: 0, preferences: [], notes: [] }, { stopReason: "budget", selfNotes: 0 });
    expect(empty).toContain(line);
    expect(empty).not.toContain("Nothing yet.");
    expect(budgetStoppedWithoutNote({ stopReason: "budget", selfNotes: 0 })).toBe(true);
  });

  it("the demo recording saved one note, so the demo shows no budget line", () => {
    const selfNotes = events.filter((e) => e.kind === "tool_call" && e.tool === "remember" && e.is_error !== true).length;
    expect(state.stopReason).toBe("budget");
    expect(selfNotes).toBe(1);
    expect(budgetStoppedWithoutNote({ stopReason: state.stopReason, selfNotes })).toBe(false);
  });
});
