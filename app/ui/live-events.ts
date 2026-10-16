/**
 * The run page's live event feed (GET /api/runs/:id/events, Server-Sent Events). Pure helpers, no React.
 *
 * Two sources feed the same list: the SSE stream (events as they are written) and each step
 * response (the turn's events, as before). Both carry `seq`, so merging dedupes by seq and keeps
 * seq order whichever arrives first. That makes the step response the fallback by construction:
 * when EventSource is missing or the stream fails, the ledger still fills, a step at a time.
 */
import type { AgentEvent } from "../../src/agent/events";

/** Merge `incoming` into `current`: drop seqs already present, keep seq order. Events without seq are appended. */
export function mergeBySeq(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return current;
  const have = new Set<number>();
  for (const e of current) if (typeof e.seq === "number") have.add(e.seq);
  const fresh: AgentEvent[] = [];
  for (const e of incoming) {
    if (typeof e.seq === "number") {
      if (have.has(e.seq)) continue;
      have.add(e.seq);
    }
    fresh.push(e);
  }
  if (fresh.length === 0) return current;
  const merged = [...current, ...fresh];
  // Only seq'd events are reordered; seq-less ones (older runs) stay where they arrived.
  const seqd = merged.filter((e) => typeof e.seq === "number").sort((a, b) => a.seq! - b.seq!);
  let i = 0;
  return merged.map((e) => (typeof e.seq === "number" ? seqd[i++]! : e));
}

export type LiveHandlers = {
  onEvent: (event: AgentEvent) => void;
  onDelta: (delta: { turn: number; text: string }) => void;
  /** The server said the run finished; the stream is closed (no reconnect). */
  onEnd: (status: string) => void;
  /** No live stream (no EventSource, it threw, or the server refused): step responses carry the events. */
  onFail: (reason: "unavailable" | "error") => void;
};

type EventSourceLike = {
  readyState: number;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  onerror: ((event: unknown) => void) | null;
  close(): void;
};
export type EventSourceCtor = new (url: string) => EventSourceLike;

const CLOSED = 2;

/**
 * Subscribe; returns the unsubscribe function. A dropped connection is retried by EventSource
 * itself (it resumes from Last-Event-ID); only a closed one (refused, or not a stream) is a failure.
 */
export function subscribeRunEvents(url: string, handlers: LiveHandlers, Impl: EventSourceCtor | undefined = globalEventSource()): () => void {
  if (!Impl) {
    handlers.onFail("unavailable");
    return () => undefined;
  }
  let source: EventSourceLike;
  try {
    source = new Impl(url);
  } catch {
    handlers.onFail("unavailable");
    return () => undefined;
  }
  let done = false;
  const finish = () => {
    done = true;
    source.close();
  };
  source.addEventListener("event", (message) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      /* a malformed frame is skipped; the step response still carries the event */
    }
  });
  source.addEventListener("delta", (message) => {
    try {
      const d = JSON.parse(message.data) as { turn?: unknown; text?: unknown };
      if (typeof d.turn === "number" && typeof d.text === "string") handlers.onDelta({ turn: d.turn, text: d.text });
    } catch {
      /* ephemeral: dropping one is harmless */
    }
  });
  source.addEventListener("end", (message) => {
    let status = "";
    try {
      status = String((JSON.parse(message.data) as { status?: unknown }).status ?? "");
    } catch {
      /* keep "" */
    }
    finish();
    handlers.onEnd(status);
  });
  source.onerror = () => {
    if (done || source.readyState !== CLOSED) return;
    done = true;
    handlers.onFail("error");
  };
  return () => {
    if (!done) finish();
  };
}

function globalEventSource(): EventSourceCtor | undefined {
  return typeof EventSource === "function" ? (EventSource as unknown as EventSourceCtor) : undefined;
}
