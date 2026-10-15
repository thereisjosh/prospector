/**
 * Share of a run's input tokens served from the prompt cache:
 * cache_read / (input + cache_read + cache_creation), summed over every `model_call` event's
 * `tokens` block. Undefined when the run made no model call (or the events carry no usage).
 * Pure and read-only.
 */
export function cacheShare(events: Array<{ kind: string; tokens?: unknown }>): number | undefined {
  let input = 0;
  let read = 0;
  let creation = 0;
  for (const e of events) {
    if (e.kind !== "model_call" || !e.tokens || typeof e.tokens !== "object") continue;
    const t = e.tokens as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    input += n(t.input);
    read += n(t.cache_read);
    creation += n(t.cache_creation);
  }
  const total = input + read + creation;
  return total > 0 ? read / total : undefined;
}
