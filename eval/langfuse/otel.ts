/**
 * Export experiment-item root spans to Langfuse over OpenTelemetry, with caller-chosen
 * ids and timestamps. Follows "Ingest experiment spans with OpenTelemetry"
 * (langfuse.com/integrations/native/opentelemetry/experiments): one trace per experiment
 * item, the root span carries `langfuse.experiment.*` attributes, and
 * `langfuse.experiment.item.root_observation_id` equals the root's own span id.
 *
 * Own isolated provider (as src/agent/trace.ts does), so it never touches the app's.
 * Payloads are masked with trace.ts `mask()` before they leave the process (SPEC §3).
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { mask } from "../../src/agent/trace";

export type ExperimentItemSpan = {
  traceId: string;
  rootId: string;
  name: string;
  startTime: string;
  endTime: string;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  sessionId?: string;
  tags?: string[];
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  experiment: {
    /** Experiment (run) id, deterministic per run name (eval/langfuse/experiment.ts experimentId). */
    id: string;
    name: string;
    datasetId: string;
    itemId: string;
    description?: string;
    metadata?: Record<string, unknown>;
    itemMetadata?: Record<string, unknown>;
    expectedOutput?: unknown;
  };
};

class FixedIds {
  next: { traceId?: string; spanId?: string } = {};
  generateTraceId(): string {
    const id = this.next.traceId;
    if (!id) throw new Error("experiment span exported without a trace id");
    this.next.traceId = undefined;
    return id;
  }
  generateSpanId(): string {
    const id = this.next.spanId;
    if (!id) throw new Error("experiment span exported without a span id");
    this.next.spanId = undefined;
    return id;
  }
}

/** Export the spans and flush. Throws on export failure (the caller reports it). */
export async function exportExperimentItemSpans(spans: ExperimentItemSpan[], options: { environment: string; exporter?: SpanExporter }): Promise<number> {
  if (spans.length === 0) return 0;
  const [{ LangfuseSpanProcessor }, { BasicTracerProvider }, api, tracing, core] = await Promise.all([
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/api"),
    import("@langfuse/tracing"),
    import("@opentelemetry/core"),
  ]);
  const A = tracing.LangfuseOtelSpanAttributes;
  let failures = 0;
  core.setGlobalErrorHandler(() => {
    failures += 1;
  });
  const ids = new FixedIds();
  const processor = new LangfuseSpanProcessor({
    environment: options.environment,
    ...(options.exporter ? { exporter: options.exporter } : {}),
    additionalHeaders: { "x-langfuse-ingestion-version": "4" },
    shouldExportSpan: () => true,
  });
  const provider = new BasicTracerProvider({ idGenerator: ids, spanProcessors: [processor] });
  const tracer = provider.getTracer("prospector-eval");
  const json = (value: unknown) => JSON.stringify(mask(value));
  for (const s of spans) {
    const attributes: Record<string, string | string[]> = {
      ...(tracing.createObservationAttributes("span", {
        input: mask(s.input),
        output: mask(s.output),
        metadata: mask(s.metadata),
        ...(s.level ? { level: s.level } : {}),
        ...(s.statusMessage ? { statusMessage: s.statusMessage } : {}),
      }) as Record<string, string>),
      ...(tracing.createTraceAttributes({ input: mask(s.input), output: mask(s.output) }) as Record<string, string>),
      [A.TRACE_NAME]: s.name,
      ...(s.sessionId ? { [A.TRACE_SESSION_ID]: s.sessionId } : {}),
      ...(s.tags?.length ? { [A.TRACE_TAGS]: s.tags } : {}),
      [A.EXPERIMENT_ID]: s.experiment.id,
      [A.EXPERIMENT_NAME]: s.experiment.name,
      [A.EXPERIMENT_DATASET_ID]: s.experiment.datasetId,
      [A.EXPERIMENT_ITEM_ID]: s.experiment.itemId,
      [A.EXPERIMENT_ITEM_ROOT_OBSERVATION_ID]: s.rootId,
      ...(s.experiment.description ? { [A.EXPERIMENT_DESCRIPTION]: s.experiment.description } : {}),
      ...(s.experiment.metadata ? { [A.EXPERIMENT_METADATA]: json(s.experiment.metadata) } : {}),
      ...(s.experiment.itemMetadata ? { [A.EXPERIMENT_ITEM_METADATA]: json(s.experiment.itemMetadata) } : {}),
      ...(s.experiment.expectedOutput !== undefined ? { [A.EXPERIMENT_ITEM_EXPECTED_OUTPUT]: json(s.experiment.expectedOutput) } : {}),
    };
    ids.next = { traceId: s.traceId, spanId: s.rootId };
    // No parent: each experiment item is its own trace.
    const span = tracer.startSpan(s.name, { startTime: new Date(s.startTime), attributes, root: true }, api.ROOT_CONTEXT);
    span.end(new Date(s.endTime));
  }
  await processor.forceFlush();
  await provider.shutdown();
  if (failures > 0) throw new Error(`${failures} experiment span export failure(s)`);
  return spans.length;
}
