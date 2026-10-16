import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events";
import { checklistModel, candidatesModel, evidenceFor, rejectionsModel, traceModel, type TraceLine, type TraceSnapshot, type TraceTree } from "./trace-model";

const ROOT = join(import.meta.dirname, "..", "..");
// The pre-quote recording the demo replayed until 2026-10-15 (eval/demo/run/ is now the memory-eval run below).
const DEMO = join(ROOT, "eval", "results", "pilot-2026-10-12", "S1", "B_agent_opus", "2");
const DEMO_NOW = join(ROOT, "eval", "demo", "run");
const MEM = join(ROOT, "eval", "results", "memory-eval-2026-10-15b", "S1", "B_agent_opus", "2");

function load(dir: string) {
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  // The same shape GET /api/runs/:id returns: screened grouped by reason.
  const groups = new Map<string, { code: string; count: number; companies: string[] }>();
  for (const s of (state.screened ?? []) as Array<{ code: string; company: string }>) {
    const g = groups.get(s.code) ?? { code: s.code, count: 0, companies: [] };
    g.count += 1;
    g.companies.push(s.company);
    groups.set(s.code, g);
  }
  const snapshot = {
    status: state.status,
    leads: state.leads,
    candidates: state.candidates ?? [],
    rejected: state.rejected,
    screened: [...groups.values()],
    todo: state.todo ?? "",
    contract: state.initialContract ?? state.contract,
    counters: state.counters,
    handback: state.handback,
  } as TraceSnapshot;
  return { events, snapshot };
}

const demo = load(DEMO);
const mem = load(MEM);

function all(lines: TraceLine[]): TraceLine[] {
  return lines.flatMap((l) => [l, ...all(l.children ?? [])]);
}
const flat = (tree: TraceTree) => all(tree.turns.flatMap((t) => t.lines));
const CODE = /\b[a-z]+_[a-z_]+\b|required_gate|\bgate\b|schema|json/i;

/** The snapshot status a viewer would have seen after the first k events. */
function statusAt(events: AgentEvent[], k: number): TraceSnapshot["status"] {
  const seen = events.slice(0, k);
  if (seen.some((e) => e.kind === "stop")) return "stopped"; // turn_end can follow the stop event
  const pending = seen.filter((e) => e.kind === "approval_request").length > seen.filter((e) => e.kind === "decision").length;
  return pending ? "awaiting_approval" : "running";
}

describe.each([
  ["pilot 2026-10-12 S1/B_agent_opus/2 (the pre-quote recording)", demo],
  ["memory-eval 2026-10-15b S1/B_agent_opus/2", mem],
])("traceModel: %s", (_name, { events, snapshot }) => {
  const tree = traceModel(events, snapshot);

  it("drops no event kind: nothing unmapped, every other event is a line or counted as internal", () => {
    expect(tree.unmapped).toBe(0);
    expect(tree.unmappedKinds).toEqual([]);
    expect(flat(tree).length).toBeGreaterThan(10);
  });

  it("renders titles and descriptions in plain words, no internal codes", () => {
    for (const l of flat(tree)) {
      if (l.kind === "search") continue; // the agent's own query text
      expect(l.title, l.id).not.toMatch(CODE);
      if (l.description) expect(l.description, l.id).not.toMatch(CODE);
    }
  });

  it("has at most one running line at every point of the run, exactly one while it is running", () => {
    for (let k = 1; k <= events.length; k += 1) {
      const status = statusAt(events, k);
      const t = traceModel(events.slice(0, k), { ...snapshot, status });
      const running = flat(t).filter((l) => l.status === "running");
      expect(running.length, `after ${k} events (${status})`).toBe(status === "running" ? 1 : 0);
    }
  });

  it("sums a turn header from its own events", () => {
    const withWork = tree.turns.filter((t) => t.description);
    expect(withWork.length).toBeGreaterThan(0);
    for (const t of withWork) expect(t.title).toBe(`Step ${t.turn}`);
  });

  it("builds evidence for every accepted lead without crashing", () => {
    const ok = flat(tree).filter((l) => l.kind === "verdict_ok");
    expect(ok.length).toBe(snapshot.leads.length);
    for (const l of ok) expect(l.children?.[0]?.detail?.kind).toBe("evidence");
  });

  it("candidates and rejections sections sum to the snapshot counts", () => {
    const cands = candidatesModel(snapshot);
    expect(cands.reduce((n, s) => n + s.count, 0)).toBe((snapshot.candidates ?? []).length);
    const rej = rejectionsModel(snapshot);
    const expected = snapshot.rejected.length + (snapshot.screened ?? []).reduce((n, g) => n + g.count, 0);
    expect(rej.reduce((n, s) => n + s.count, 0)).toBe(expected);
    for (const s of rej) expect(s.label).not.toMatch(CODE);
  });
});

describe("traceModel: memory-eval run (new event kinds)", () => {
  const tree = traceModel(mem.events, mem.snapshot);
  const lines = flat(tree);

  it("starts with the memory line, with counts and included ids in the detail", () => {
    const first = tree.turns[0]!.lines[0]!;
    expect(first.kind).toBe("memory_recalled");
    expect(first.title).toBe("Recalled memory: 7 companies already seen, 0 notes, 0 pieces of your feedback");
    expect(first.detail).toMatchObject({ kind: "json", value: { seen: 7, includedIds: [] } });
  });

  it("renders both skipped lookups with the provenance date", () => {
    const skipped = lines.filter((l) => l.kind === "lookup_seen");
    expect(skipped.map((l) => l.title)).toEqual([
      "Skipped Wagner Logistics, delivered 15 Oct in an earlier run, lookup saved",
      "Skipped Spartan Logistics, delivered 15 Oct in an earlier run, lookup saved",
    ]);
  });

  it("nests the lookup_retry under its lookup and shows the outcome", () => {
    const lookup = lines.find((l) => l.kind === "lookup" && l.title === "Looking up Cleveland Group")!;
    const retry = lookup.children?.find((c) => c.kind === "lookup_retry");
    expect(retry?.title).toBe("Retried the lookup for Cleveland Group: a quote wasn't on the page. Kept the first result.");
    expect(retry?.description).toBe("didn't fit → didn't fit");
    expect(retry?.status).toBeUndefined();
    // and it is not also a top-level line
    expect(lines.filter((l) => l.kind === "lookup_retry")).toHaveLength(1);
  });

  it("splits skipped non-fits into a child and notes lookup screening", () => {
    const g10 = lines.find((l) => l.title === "Looking up G10 Fulfillment")!;
    expect(g10.description).toBe("Ruled out at lookup: outside the size range");
    const withSkips = lines.find((l) => l.title === "Looking up Cleveland Group")!;
    expect(withSkips.children?.some((c) => c.kind === "skipped" && c.title === "Skipped 3 obvious non-fits")).toBe(true);
  });

  it("shows the approval as a resolved line, a rejection as neutral, and the saved note", () => {
    expect(lines.filter((l) => l.kind === "approval_request")).toHaveLength(0);
    expect(lines.find((l) => l.kind === "decision")?.title).toBe("You approved.");
    const rejected = lines.find((l) => l.kind === "verdict_rejected")!;
    expect(rejected.status).toBeUndefined();
    expect(rejected.icon).toBe("x");
    expect(lines.some((l) => l.kind === "remember")).toBe(true);
  });

  it("reports cache share from model_call tokens", () => {
    expect(tree.cache?.share).toBeGreaterThan(0.5);
    expect(tree.cache?.text).toMatch(/^\d+% of the agent's reading came from cache$/);
  });

  it("ends with the stop sentence and the handback headline", () => {
    const last = tree.turns[tree.turns.length - 1]!.lines;
    expect(last.some((l) => l.kind === "stop" && l.title === "Stopped before the next step could go over your spending limit.")).toBe(true);
    expect(last[last.length - 1]!.kind).toBe("handback");
    expect(last[last.length - 1]!.title).toBe("Found 8 of the 10 leads you asked for");
  });

  it("every accepted lead has at least 3 verbatim quotes", () => {
    expect(mem.snapshot.leads).toHaveLength(8);
    for (const lead of mem.snapshot.leads) {
      const ev = evidenceFor(lead, mem.snapshot.contract);
      expect(ev.quotes.length, lead.company).toBeGreaterThanOrEqual(3);
      expect(ev.gates.length, lead.company).toBeGreaterThan(0);
      expect(ev.sizeQuoteMatch, lead.company).toBeDefined();
      for (const q of ev.quotes) expect(q.quote.trim().length).toBeGreaterThan(0);
    }
    const southern = evidenceFor(mem.snapshot.leads[0]!, mem.snapshot.contract);
    expect(southern.source).toBe("choosealbany.com");
    expect(southern.published).toBe("Sep 18, 2026");
    expect(southern.quotes.map((q) => q.label).slice(0, 4)).toEqual(["Why now", "When", "Size", "Based in"]);
    expect(southern.quotes[4]!.label).toMatch(/^provides warehousing/);
    expect(southern.quotes[4]!.quote).toMatch(/^SOAG CARRIERS is a logistics company/);
    expect(southern.size).toMatchObject({ employees: 119, basis: "quoted", inRange: true });
  });
});

describe("evidence without quotes", () => {
  it("yields an empty list for the pilot recording (older run), not a crash", () => {
    for (const lead of demo.snapshot.leads) {
      const ev = evidenceFor(lead, demo.snapshot.contract);
      expect(ev.kind).toBe("evidence");
      expect(ev.quotes.length).toBeLessThanOrEqual(1);
      expect(ev.missing.length).toBeGreaterThan(0);
    }
    const bare = { company: "X", signal_url: "javascript:alert(1)", why_now: "", summary: undefined, details: {}, turn: 1 } as never;
    expect(evidenceFor(bare)).toMatchObject({ quotes: [], gates: [] });
    expect(evidenceFor(bare).source).toBeUndefined();
  });
});

describe("checklistModel", () => {
  it("reflects the agent's last todo, labels its bold-key prose, and flags staleness", () => {
    const m = checklistModel(demo.events, demo.snapshot);
    expect(m.items.map((i) => i.kind)).toEqual(["note", "note", "note"]);
    expect(m.items[0]).toEqual({ kind: "note", label: "Leads found", text: "5 of 10" });
    expect(m.updatedAtTurn).toBe(7);
    expect(m.currentTurn).toBe(13);
    expect(m.stepsAgo).toBe(6);
    expect(m.updatedLine).toBe("Updated at step 7 · 6 steps ago");
    expect(m.agentLeadsFound).toBe(5);
    expect(m.agentLeadsTarget).toBe(10);
    expect(demo.snapshot.leads.length).toBeGreaterThan(5);
    expect(m.stale).toBe(true);
    expect(m.staleLine).toBe(`Leads found: 5 of 10 (agent's note) · ${demo.snapshot.leads.length} accepted`);
  });

  it("is not stale when the note matches or leads are fewer, and handles checkbox items and no todo", () => {
    const events = [{ ts: "", runId: "r", turn: 3, kind: "tool_call", promptVersion: "", tool: "update_todo", input: { markdown: "- [x] Search US\n- [ ] Search UK\n**Leads found:** 2" } }] as AgentEvent[];
    const ok = checklistModel(events, { todo: "", leads: [{}, {}] as never, counters: { turns: 4 } });
    expect(ok.items).toEqual([{ kind: "done", text: "Search US" }, { kind: "todo", text: "Search UK" }, { kind: "note", label: "Leads found", text: "2" }]);
    expect(ok.stale).toBe(false);
    expect(ok.stepsAgo).toBe(1);
    expect(ok.updatedLine).toBe("Updated at step 3 · 1 step ago");
    const none = checklistModel(mem.events, mem.snapshot);
    expect(none.items).toEqual([]);
    expect(none.updatedAtTurn).toBeUndefined();
    expect(none.stale).toBe(false);
  });
});

describe("candidatesModel and rejectionsModel", () => {
  it("sections candidates by missing fact and keeps unsafe links off", () => {
    const snap = {
      contract: demo.snapshot.contract,
      candidates: [
        { company: "A", signal_url: "https://a.com/x", why_now: "w", code: "quote_not_in_page", missing: "funding stage not stated on a.com" },
        { company: "B", signal_url: "javascript:void(0)", why_now: "w", code: "quote_not_in_page", missing: "x" },
        { company: "C", signal_url: "https://c.com", why_now: "w", code: "required_gate:is_x", missing: "y" },
      ],
    } as never;
    const sections = candidatesModel(snap);
    expect(sections.map((s) => [s.label, s.count])).toEqual([["A quote wasn't found on the page", 2], ["Page doesn't state: is x", 1]]);
    expect(sections[0]!.items[0]).toMatchObject({ company: "A", reason: "Not counted: funding stage not stated on a.com", sourceHost: "a.com" });
    expect(sections[0]!.items[1]!.sourceUrl).toBeUndefined();
  });

  it("adds the after-the-run extras when given", () => {
    const base = { rejected: [], screened: [], contract: demo.snapshot.contract };
    const sections = rejectionsModel(base, { dropped: ["A"], skipped: ["B", "C"] });
    expect(sections.map((s) => [s.kind, s.count])).toEqual([["dropped", 1], ["skipped", 2]]);
  });
});

describe("turn cost", () => {
  it("does not count a lookup retry twice: the lookup's exaCost already includes it (src/agent/tools.ts)", () => {
    const base = { ts: "", runId: "r", turn: 2, promptVersion: "" };
    const events = [
      { ...base, kind: "tool_call", tool: "lookup_company", input: { name: "Cleveland Group" }, exaCost: 0.018, toolUseId: "u1" },
      { ...base, kind: "lookup_retry", toolUseId: "u1", company: "Cleveland Group", reason: "quote_not_in_page", outcome: "kept_first", retryExaCost: 0.009 },
    ] as AgentEvent[];
    const tree = traceModel(events, { ...mem.snapshot, status: "stopped", handback: undefined });
    expect(tree.turns[0]!.description).toBe("1 lookup · $0.02");
  });
});

describe("the demo fixture", () => {
  it("is the memory-eval run, byte for byte", () => {
    for (const f of ["events.jsonl", "state.json"]) expect(readFileSync(join(DEMO_NOW, f), "utf8")).toBe(readFileSync(join(MEM, f), "utf8"));
  });
});

describe("unknown events", () => {
  it("become a generic line and are counted", () => {
    const events = [
      { ts: "", runId: "r", turn: 1, kind: "brand_new_kind", promptVersion: "" },
      { ts: "", runId: "r", turn: 1, kind: "tool_call", promptVersion: "", tool: "mystery", input: {} },
    ] as unknown as AgentEvent[];
    const tree = traceModel(events, { ...demo.snapshot, status: "stopped", handback: undefined });
    expect(tree.unmapped).toBe(2);
    expect(tree.unmappedKinds).toEqual(["brand_new_kind", "tool:mystery"]);
    expect(flat(tree)).toHaveLength(2);
  });
});

/* ---------- live: tool calls in flight, streamed text ---------- */

import { pacedSchedule } from "../../src/demo/replay";

describe("traceModel: tool_started (live ledger)", () => {
  const base = (over: Partial<AgentEvent>): AgentEvent => ({ ts: "2026-10-16T00:00:00.000Z", runId: "r", turn: 3, kind: "policy", promptVersion: "p", ...over }) as AgentEvent;
  const started = (id: string, name: string) => base({ kind: "tool_started", tool: "lookup_company", toolUseId: id, input: { name } });
  const called = (id: string, name: string) => base({ kind: "tool_call", tool: "lookup_company", toolUseId: id, input: { name }, is_error: false, exaCost: 0.01, resultSummary: `${name} · ok` });
  const log: AgentEvent[] = [
    base({ kind: "policy" }),
    base({ kind: "model_call", claudeCost: 0.01, latencyMs: 900 }),
    started("a", "Hadrius"),
    started("b", "Wagner Logistics"),
    started("c", "Spartan"),
    called("b", "Wagner Logistics"),
    called("a", "Hadrius"),
    called("c", "Spartan"),
    base({ kind: "turn_end" }),
  ];
  const snap = (status: TraceSnapshot["status"] = "running") => ({ ...mem.snapshot, status, handback: undefined, leads: [], candidates: [] });
  const turnLines = (tree: TraceTree) => tree.turns.find((t) => t.turn === 3)!.lines;

  it("a started call is the single running line, in place of the synthetic working line; the rest of its batch waits", () => {
    const tree = traceModel(log.slice(0, 5), snap());
    const lines = turnLines(tree);
    expect(lines.map((l) => [l.title, l.status])).toEqual([
      ["Looking up Hadrius…", "running"],
      ["Looking up Wagner Logistics…", "pending"],
      ["Looking up Spartan…", "pending"],
    ]);
    expect(lines.some((l) => l.kind === "working")).toBe(false);
  });

  it("resolves in place when its tool_call arrives: same id, same position, and the next call in flight takes the shimmer", () => {
    const before = turnLines(traceModel(log.slice(0, 5), snap()));
    const after = turnLines(traceModel(log.slice(0, 6), snap()));
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(after[1]).toMatchObject({ id: before[1]!.id, kind: "lookup", title: "Looking up Wagner Logistics" });
    expect(after[1]!.status).toBeUndefined();
    expect(after[1]!.inflight).toBeUndefined();
    expect(after[0]!.status).toBe("running");
    const done = turnLines(traceModel(log, snap()));
    expect(done.map((l) => l.title)).toEqual(["Looking up Hadrius", "Looking up Wagner Logistics", "Looking up Spartan", "Working on the next step"]);
    expect(done.map((l) => l.id).slice(0, 3)).toEqual(before.map((l) => l.id));
  });

  it("counts a folded tool_started as hidden (no event dropped silently) and nothing as unmapped", () => {
    const tree = traceModel(log, snap());
    expect(tree.unmapped).toBe(0);
    expect(tree.hidden).toBe(2 + 3); // policy + turn_end, and the three folded starts
  });

  it("a call that never finished in a stopped run is not running: it says so", () => {
    const tree = traceModel([...log.slice(0, 4), base({ kind: "stop", reason: "user", status: "stopped" })], snap("stopped"));
    const lines = turnLines(tree);
    expect(lines.filter((l) => l.status === "running")).toHaveLength(0);
    expect(lines[0]).toMatchObject({ title: "Looking up Hadrius…", description: "Didn't finish" });
  });

  it("submit_lead's start resolves into its verdict line (the started line goes, the verdict follows)", () => {
    const sub = [
      base({ kind: "tool_started", tool: "submit_lead", toolUseId: "s", input: { company: "Hadrius" } }),
    ];
    const pending = turnLines(traceModel(sub, snap()));
    expect(pending.map((l) => [l.title, l.status])).toEqual([["Checking Hadrius…", "running"]]);
    const resolved = turnLines(traceModel([...sub, base({ kind: "tool_call", tool: "submit_lead", toolUseId: "s", input: { company: "Hadrius" } }), base({ kind: "submit_verdict", company: "Hadrius", ok: false, code: "size", reason: "too small" })], snap()));
    expect(resolved.map((l) => l.kind)).toEqual(["verdict_rejected", "working"]);
  });

  it("streamed model text is the working line's description until the turn's model_call lands", () => {
    const streaming = { turn: 4, text: "I'll look up the three warehouses that\nlooked strongest  in the last search." };
    const tree = traceModel(log, snap(), { streaming });
    const working = tree.turns.find((t) => t.turn === 4)!.lines.find((l) => l.kind === "working")!;
    expect(working.status).toBe("running");
    expect(working.description).toBe("I'll look up the three warehouses that looked strongest in the last search.");
    const landed = traceModel([...log, base({ turn: 4, kind: "model_call", latencyMs: 1 })], snap(), { streaming });
    expect(landed.turns.find((t) => t.turn === 4)!.lines.find((l) => l.kind === "working")!.description).toBeUndefined();
    const long = traceModel(log, snap(), { streaming: { turn: 4, text: "word ".repeat(100) } });
    const d = long.turns.find((t) => t.turn === 4)!.lines.find((l) => l.kind === "working")!.description!;
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d.startsWith("…")).toBe(true);
  });

  /** The demo recording as the live view receives it: the replay's tool_started lines included. */
  const demoLive = pacedSchedule(mem.events).flatMap((s) => s.events);

  it.each([
    ["synthetic log", log],
    ["the demo log as replayed live (with tool_started)", demoLive],
  ])("exactly one running line at every prefix: %s", (_name, events) => {
    expect(events.filter((e) => e.kind === "tool_started").length).toBeGreaterThan(0);
    for (let k = 1; k <= events.length; k += 1) {
      const status = statusAt(events, k);
      const t = traceModel(events.slice(0, k), { ...mem.snapshot, status, ...(events === log ? { handback: undefined } : {}) });
      const running = flat(t).filter((l) => l.status === "running");
      expect(running.length, `after ${k} events (${status})`).toBe(status === "running" ? 1 : 0);
    }
  });

  it("the replayed demo log maps every event: nothing unmapped, every start resolved by the end", () => {
    const tree = traceModel(demoLive, mem.snapshot);
    expect(tree.unmapped).toBe(0);
    expect(flat(tree).filter((l) => l.inflight)).toHaveLength(0);
    expect(demoLive.filter((e) => e.kind === "tool_started")).toHaveLength(mem.events.filter((e) => e.kind === "tool_call").length);
  });
});
