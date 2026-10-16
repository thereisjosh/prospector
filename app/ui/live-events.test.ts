import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events";
import { mergeBySeq, subscribeRunEvents, type EventSourceCtor, type LiveHandlers } from "./live-events";

const ev = (seq: number | undefined, kind: AgentEvent["kind"] = "policy"): AgentEvent =>
  ({ ts: "2026-10-16T00:00:00.000Z", runId: "r", turn: 1, kind, promptVersion: "p", ...(seq !== undefined ? { seq } : {}) }) as AgentEvent;
const seqs = (events: AgentEvent[]) => events.map((e) => e.seq);

describe("mergeBySeq (live feed + step responses)", () => {
  it("drops events already delivered and keeps seq order whichever source was first", () => {
    const live = mergeBySeq([], [ev(3), ev(4), ev(5)]);
    // The step response for the same turn arrives afterwards with 1..5: only 1 and 2 are new, and they go first.
    const merged = mergeBySeq(live, [ev(1), ev(2), ev(3), ev(4), ev(5)]);
    expect(seqs(merged)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeBySeq(merged, [ev(2), ev(5)])).toBe(merged); // nothing new: same array
  });

  it("dedupes within one batch and keeps seq-less events (older runs) where they arrived", () => {
    expect(seqs(mergeBySeq([ev(undefined)], [ev(2), ev(2), ev(undefined), ev(1)]))).toEqual([undefined, 1, undefined, 2]);
  });
});

/** A fake EventSource: the test drives frames and errors. */
function fakeSource() {
  const instances: Array<{ url: string; listeners: Record<string, Array<(e: { data: string }) => void>>; closed: boolean; readyState: number; onerror: ((e: unknown) => void) | null; emit: (type: string, data: unknown) => void }> = [];
  class Fake {
    url: string;
    readyState = 1;
    onerror: ((e: unknown) => void) | null = null;
    listeners: Record<string, Array<(e: { data: string }) => void>> = {};
    closed = false;
    constructor(url: string) {
      this.url = url;
      instances.push(this as never);
    }
    addEventListener(type: string, listener: (e: { data: string }) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    emit(type: string, data: unknown) {
      for (const l of this.listeners[type] ?? []) l({ data: typeof data === "string" ? data : JSON.stringify(data) });
    }
  }
  return { Impl: Fake as unknown as EventSourceCtor, instances };
}

function handlers() {
  return { onEvent: vi.fn(), onDelta: vi.fn(), onEnd: vi.fn(), onFail: vi.fn() } satisfies LiveHandlers;
}

describe("subscribeRunEvents", () => {
  it("delivers events and deltas, closes on end", () => {
    const { Impl, instances } = fakeSource();
    const h = handlers();
    subscribeRunEvents("/api/runs/r/events?after=0", h, Impl);
    const source = instances[0]!;
    source.emit("event", ev(1, "tool_started"));
    source.emit("delta", { turn: 2, text: "Looking" });
    source.emit("event", "{not json");
    source.emit("end", { status: "done" });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    expect(h.onEvent.mock.calls[0]![0]).toMatchObject({ seq: 1, kind: "tool_started" });
    expect(h.onDelta).toHaveBeenCalledWith({ turn: 2, text: "Looking" });
    expect(h.onEnd).toHaveBeenCalledWith("done");
    expect(source.closed).toBe(true);
    expect(h.onFail).not.toHaveBeenCalled();
  });

  it("falls back when EventSource is missing or its constructor throws", () => {
    const missing = handlers();
    expect(() => subscribeRunEvents("/x", missing, undefined)).not.toThrow();
    expect(missing.onFail).toHaveBeenCalledWith("unavailable");
    const throws = handlers();
    const Throwing = class {
      constructor() {
        throw new Error("blocked");
      }
    } as unknown as EventSourceCtor;
    const unsubscribe = subscribeRunEvents("/x", throws, Throwing);
    expect(throws.onFail).toHaveBeenCalledWith("unavailable");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("a dropped connection is left to EventSource's own reconnect; a closed one is a failure, reported once", () => {
    const { Impl, instances } = fakeSource();
    const h = handlers();
    subscribeRunEvents("/x", h, Impl);
    const source = instances[0]!;
    source.readyState = 0; // CONNECTING: the browser is retrying with Last-Event-ID
    source.onerror?.({});
    expect(h.onFail).not.toHaveBeenCalled();
    source.readyState = 2; // CLOSED: refused (403) or not a stream
    source.onerror?.({});
    source.onerror?.({});
    expect(h.onFail).toHaveBeenCalledTimes(1);
    expect(h.onFail).toHaveBeenCalledWith("error");
  });

  it("the fallback path: with the feed failed, step responses alone still build the full ledger, once each", () => {
    const { Impl, instances } = fakeSource();
    let ledger: AgentEvent[] = [];
    const push = (events: AgentEvent[]) => (ledger = mergeBySeq(ledger, events));
    subscribeRunEvents("/x", { onEvent: (e) => push([e]), onDelta: () => undefined, onEnd: () => undefined, onFail: () => undefined }, Impl);
    instances[0]!.emit("event", ev(1));
    instances[0]!.emit("event", ev(2, "tool_started"));
    instances[0]!.readyState = 2;
    instances[0]!.onerror?.({});
    // Steps keep returning their events; the ones the feed already delivered are not duplicated.
    push([ev(1), ev(2, "tool_started"), ev(3, "tool_call"), ev(4, "turn_end")]);
    push([ev(5), ev(6, "model_call")]);
    expect(seqs(ledger)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("unsubscribe closes the source", () => {
    const { Impl, instances } = fakeSource();
    const stop = subscribeRunEvents("/x", handlers(), Impl);
    stop();
    expect(instances[0]!.closed).toBe(true);
  });
});
