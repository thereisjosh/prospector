import { EventEmitter } from "node:events";

/**
 * In-process notifications for the live event stream (GET /api/runs/:id/events).
 *
 * - `appended`: events.jsonl just grew (wakes the tailer at once; fs.watch and a 250 ms poll
 *   are the fallback, and the file is what gets served).
 * - `assistant_text_delta`: the model's visible text as it streams. Ephemeral by design: never
 *   written to events.jsonl (the turn's `model_call` event carries the full text, as before).
 *
 * One process: the step request and the SSE request must share it (Railway runs one replica).
 * Kept on globalThis so route bundles that load this module separately still share one bus.
 */
export type LiveMessage =
  | { type: "appended" }
  | { type: "assistant_text_delta"; turn: number; text: string };

type Bus = EventEmitter;
const KEY = "__prospectorLiveBus";

function bus(): Bus {
  const g = globalThis as typeof globalThis & { [KEY]?: Bus };
  if (!g[KEY]) {
    const created = new EventEmitter();
    created.setMaxListeners(0); // one listener per open stream
    g[KEY] = created;
  }
  return g[KEY]!;
}

export function publishLive(runId: string, message: LiveMessage): void {
  try {
    bus().emit(runId, message);
  } catch {
    /* a listener's failure must never fail the writer */
  }
}

export function subscribeLive(runId: string, listener: (message: LiveMessage) => void): () => void {
  bus().on(runId, listener);
  return () => {
    bus().off(runId, listener);
  };
}
