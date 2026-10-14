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

export type SdkTracing = {
  /** Flush every span, then unregister the provider and context manager. Throws on export failure. */
  shutdown(): Promise<void>;
};

/**
 * Tracing for code whose observations the Langfuse SDK creates itself through
 * `@langfuse/tracing` (the Experiments SDK: `langfuse.experiment.run` / `dataset.runExperiment`).
 * For a short-lived script; call `shutdown()` once at the end.
 *
 * What the docs' setup (`new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] }).start()`,
 * langfuse.com/docs/evaluation/experiments/experiments-via-sdk) registers, without the NodeSDK
 * dependency:
 * - an async context manager. The experiment runner opens the item's root span with
 *   `startActiveObservation` and then sets `langfuse.experiment.id/name/item.id/
 *   item.root_observation_id/dataset_id` on it through `propagateAttributes`, which reads
 *   `trace.getActiveSpan()`. With no global context manager (the OTel API default is a no-op)
 *   there is no active span, the attributes land nowhere, and Langfuse receives a plain trace,
 *   not an experiment item. `setLangfuseTracerProvider` alone does not provide this.
 * - the provider, as the global provider (`ExperimentManager.isOtelRegistered()` checks only the
 *   global one and warns "Traces will not be sent" otherwise) and as Langfuse's provider.
 */
export async function startSdkTracing(options: { environment?: string; exporter?: SpanExporter } = {}): Promise<SdkTracing> {
  const [{ LangfuseSpanProcessor }, { BasicTracerProvider }, api, tracing, core, asyncHooks] = await Promise.all([
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/api"),
    import("@langfuse/tracing"),
    import("@opentelemetry/core"),
    import("@opentelemetry/context-async-hooks"),
  ]);
  let failures = 0;
  core.setGlobalErrorHandler((error) => {
    failures += 1;
    console.error(`Langfuse span export failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const contextManager = new asyncHooks.AsyncLocalStorageContextManager().enable();
  if (!api.context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
    throw new Error("an OpenTelemetry context manager is already registered in this process; startSdkTracing needs to own it");
  }
  const processor = new LangfuseSpanProcessor({
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.exporter ? { exporter: options.exporter } : {}),
    additionalHeaders: { "x-langfuse-ingestion-version": "4" },
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  if (!api.trace.setGlobalTracerProvider(provider)) {
    api.context.disable();
    throw new Error("an OpenTelemetry tracer provider is already registered in this process; startSdkTracing needs to own it");
  }
  tracing.setLangfuseTracerProvider(provider);
  return {
    async shutdown() {
      await processor.forceFlush();
      await provider.shutdown();
      tracing.setLangfuseTracerProvider(null);
      api.trace.disable();
      api.context.disable();
      if (failures > 0) throw new Error(`${failures} Langfuse span export failure(s)`);
    },
  };
}
