import { watch, type FSWatcher } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNS_DIR } from "./config";
import { eventsPath, type AgentEvent } from "./events";
import { assertRunId } from "./ids";
import { subscribeLive } from "./live-bus";

/**
 * The live event stream behind GET /api/runs/:id/events (Server-Sent Events).
 *
 * events.jsonl is the source of truth: the stream sends every line with seq > `after`, then
 * tails the file (in-process "appended" notifications, fs.watch, and a poll as the floor) and
 * ends when the run is no longer running or awaiting approval. The only thing it sends that is
 * not in the file is the model's visible text as it streams (`delta`), which is ephemeral.
 *
 * Wire format (one frame per message):
 *   id: <seq>\nevent: event\ndata: <AgentEvent JSON>\n\n      a persisted event
 *   event: delta\ndata: {"turn":N,"text":"..."}\n\n           assistant_text_delta (not persisted)
 *   event: end\ndata: {"status":"done"}\n\n                    the run finished; the server closes
 *   : heartbeat\n\n                                            every 15 s, keeps proxies from timing out
 * The `id:` line makes a reconnecting EventSource send Last-Event-ID, which the route honours.
 */

export const LIVE_STATUSES = new Set(["running", "awaiting_approval"]);
export const HEARTBEAT_MS = 15_000;
export const POLL_MS = 250;
export const STATUS_MS = 1_000;

export type EventStreamOptions = {
  runId: string;
  /** Send only events with seq > after. */
  after: number;
  /** The run's current status; undefined when it cannot be read right now (checked again later). */
  readStatus: () => Promise<string | undefined>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  pollMs?: number;
  statusMs?: number;
};

export function sseFrame(event: AgentEvent): string {
  return `id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`;
}

export function openEventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const path = eventsPath(options.runId);
  const encoder = new TextEncoder();
  const cleanups: Array<() => void> = [];
  let closed = false;
  let offset = 0;
  let lineNo = 0;
  let pending = Buffer.alloc(0);
  let reading: Promise<void> | undefined;
  let readAgain = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    try {
      controller.close();
    } catch {
      /* the client already cancelled */
    }
  };

  const send = (text: string) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      close();
    }
  };

  /** Read whatever the file gained since `offset`; only complete lines are sent. */
  const readNew = async () => {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size <= offset) return;
      const chunk = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      offset += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    } finally {
      await handle.close();
    }
    const end = pending.lastIndexOf(0x0a);
    if (end < 0) return;
    const complete = pending.subarray(0, end).toString("utf8");
    pending = pending.subarray(end + 1);
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      lineNo += 1;
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        continue; // never stall the stream on one bad line; seq still counts it
      }
      if (typeof event.seq !== "number") event.seq = lineNo;
      if (event.seq > options.after) send(sseFrame(event));
    }
  };

  /** Serialised: one read at a time; a wake-up during a read triggers one more pass. */
  const drain = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          readAgain = false;
          await readNew();
        } while (readAgain && !closed);
      } catch {
        /* transient read error: the next poll tries again */
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };

  let checking = false;
  const checkStatus = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      const status = await options.readStatus();
      if (status !== undefined && !LIVE_STATUSES.has(status)) {
        // Events are appended before the state is saved, so the file is complete now.
        await drain();
        send(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
        close();
      }
    } catch {
      /* status unreadable right now: the next check tries again */
    } finally {
      checking = false;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      send("retry: 3000\n\n: connected\n\n");
      if (options.signal) {
        if (options.signal.aborted) return close();
        const onAbort = () => close();
        options.signal.addEventListener("abort", onAbort);
        cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
      }
      cleanups.push(
        subscribeLive(options.runId, (message) => {
          if (message.type === "appended") void drain();
          else if (message.type === "assistant_text_delta") send(`event: delta\ndata: ${JSON.stringify({ turn: message.turn, text: message.text })}\n\n`);
        }),
      );
      let watcher: FSWatcher | undefined;
      try {
        // The run directory, not the file: the file may not exist yet.
        watcher = watch(dirname(path), () => void drain());
        watcher.on("error", () => watcher?.close());
        cleanups.push(() => watcher?.close());
      } catch {
        /* no fs.watch here (some container filesystems): the poll below still covers it */
      }
      const poll = setInterval(() => void drain(), options.pollMs ?? POLL_MS);
      const status = setInterval(() => void checkStatus(), options.statusMs ?? STATUS_MS);
      const heartbeat = setInterval(() => send(": heartbeat\n\n"), options.heartbeatMs ?? HEARTBEAT_MS);
      cleanups.push(() => clearInterval(poll), () => clearInterval(status), () => clearInterval(heartbeat));
      void drain().then(checkStatus);
    },
    cancel() {
      close();
    },
  });
}

/** Owner and status of a live (non-demo) run, from state.json; undefined when it does not exist. */
export async function readRunAccess(runId: string): Promise<{ workspaceId: string; status: string } | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(RUNS_DIR, assertRunId(runId), "state.json"), "utf8")) as { workspaceId?: unknown; status?: unknown };
    if (typeof raw.workspaceId !== "string" || typeof raw.status !== "string") return undefined;
    return { workspaceId: raw.workspaceId, status: raw.status };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
