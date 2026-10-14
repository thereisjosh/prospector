import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { confirmExperiment, listRuns, mismatchLines, reportItems, reportPath, selectItems, writeReport, type CalibrationReport } from "./online/calibrate-judge";
import { startSdkTracing } from "./langfuse/otel";

/** Keeps spans across shutdown (InMemorySpanExporter.shutdown() clears them). */
class KeepingExporter {
  spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (r: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

const EXPERIMENT_KEYS = ["langfuse.experiment.id", "langfuse.experiment.name", "langfuse.experiment.item.id", "langfuse.experiment.item.root_observation_id"];

/** Run the Experiments SDK on one local item with a stub task (no model, no network: no dataset item id, no evaluators). */
async function runStubExperiment() {
  const { LangfuseClient } = await import("@langfuse/client");
  const client = new LangfuseClient({ publicKey: "pk-lf-test", secretKey: "sk-lf-test", baseUrl: "http://127.0.0.1:9" });
  return client.experiment.run({
    name: "judge-calibration/judge_q3",
    runName: "dry-run · test",
    data: [{ input: { company: "Acme" }, expectedOutput: "yes" }],
    task: async () => ({ score: "invalid", reasoning: "dry-run" }),
  });
}

describe("calibrate-judge: experiment runs reach Langfuse (FAILURES #20)", () => {
  it("startSdkTracing makes the Experiments SDK emit an experiment item root span; setLangfuseTracerProvider alone does not", async () => {
    const [{ InMemorySpanExporter, BasicTracerProvider }, { LangfuseSpanProcessor }, tracing] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
    ]);

    // The old setup: isolated provider registered for Langfuse, no context manager.
    const oldExporter = new InMemorySpanExporter();
    const oldProcessor = new LangfuseSpanProcessor({ exporter: oldExporter });
    tracing.setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [oldProcessor] }));
    await runStubExperiment();
    await oldProcessor.forceFlush();
    tracing.setLangfuseTracerProvider(null);
    const [oldRoot] = oldExporter.getFinishedSpans();
    expect(oldRoot?.name).toBe("experiment-item-run");
    // Exported, but as a plain trace: no experiment id, so the Experiments API never lists it.
    for (const k of EXPERIMENT_KEYS) expect(oldRoot!.attributes[k]).toBeUndefined();

    const exporter = new KeepingExporter();
    const sdkTracing = await startSdkTracing({ exporter });
    const result = await runStubExperiment();
    await sdkTracing.shutdown();
    const spans = exporter.spans;
    expect(spans).toHaveLength(1);
    const root = spans[0]!;
    expect(root.name).toBe("experiment-item-run");
    expect(root.attributes["langfuse.experiment.id"]).toBe(result.experimentId);
    expect(root.attributes["langfuse.experiment.name"]).toBe("dry-run · test");
    expect(root.attributes["langfuse.experiment.item.root_observation_id"]).toBe(root.spanContext().spanId);
    expect(result.itemResults[0]!.traceId).toBe(root.spanContext().traceId);

    // shutdown unregisters both, so the next caller can own them.
    const again = await startSdkTracing({ exporter: new KeepingExporter() });
    await again.shutdown();
  });

  it("confirmExperiment waits for the run to be listed with every item, and fails loudly when it never is", async () => {
    let calls = 0;
    const listed = {
      list: async () => ({ data: ++calls < 3 ? [] : [{ id: "exp1", name: "r", description: null, startTime: "", endTime: "", itemCount: 10, datasetId: "ds" }], meta: {} }),
      listItems: async () => ({ data: [], meta: {} }),
    };
    expect(await confirmExperiment(listed as never, { experimentId: "exp1", datasetId: "ds", fromStartTime: "2026-10-14T00:00:00Z", expectedItems: 10, intervalMs: 1 })).toBe(10);
    const never = { list: async () => ({ data: [], meta: {} }), listItems: async () => ({ data: [], meta: {} }) };
    await expect(confirmExperiment(never as never, { experimentId: "exp1", datasetId: "ds", fromStartTime: "2026-10-14T00:00:00Z", expectedItems: 10, timeoutMs: 5, intervalMs: 1 })).rejects.toThrow(/not listed by the Experiments API/);
  });
});

describe("calibrate-judge: verdicts are kept in full", () => {
  const items = [
    { id: "i1", datasetId: "ds", input: { company: "RGL Logistics", signal_url: "https://a" }, expectedOutput: "yes" },
    { id: "i2", datasetId: "ds", input: { company: "Away Team (Spreetail)", signal_url: "https://b" }, expectedOutput: "no" },
    { id: "i3", datasetId: "ds", input: { company: "Sybill", signal_url: "https://c" }, expectedOutput: "no" },
  ];
  const long = `The excerpt says ${"x".repeat(400)} END`;

  it("--item selects by company substring, case-insensitively", () => {
    expect(selectItems(items, "spreetail").map((i) => i.id)).toEqual(["i2"]);
    expect(selectItems(items, undefined)).toHaveLength(3);
    expect(selectItems(items, "nobody")).toEqual([]);
  });

  it("the report keeps every item with full reasoning, cost and trace id; errored items are rows too", () => {
    const rows = reportItems(
      items,
      [
        { item: { id: "i1" }, output: { score: "yes", reasoning: "ok", costDollars: 0.04 }, traceId: "t1" },
        { item: { id: "i2" }, output: { score: "cannot_verify", reasoning: long, costDollars: 0.05 }, traceId: "t2" },
      ],
      [{ id: "i3", message: "429 rate limited" }],
    );
    expect(rows).toEqual([
      { datasetItemId: "i1", company: "RGL Logistics", signal_url: "https://a", expected: "yes", actual: "yes", correct: true, reasoning: "ok", costDollars: 0.04, traceId: "t1" },
      { datasetItemId: "i2", company: "Away Team (Spreetail)", signal_url: "https://b", expected: "no", actual: "cannot_verify", correct: false, reasoning: long, costDollars: 0.05, traceId: "t2" },
      { datasetItemId: "i3", company: "Sybill", signal_url: "https://c", expected: "no", actual: "error", correct: false, reasoning: "", costDollars: 0, traceId: null, error: "429 rate limited" },
    ]);
    const out = mismatchLines(rows).join("\n");
    expect(out).toContain(long); // full text under the table, untruncated
    expect(out).toContain("task error: 429 rate limited");
    expect(out).not.toContain("RGL Logistics");

    const report: CalibrationReport = {
      judge: "judge_q3", runName: "r", experimentId: "e", dataset: "judge-calibration/judge_q3", datasetId: "ds", promptVersion: 3, model: "m",
      itemFilter: null, createdAt: "2026-10-14T09:00:00.000Z", correct: 1, total: 3, errors: 1, spentDollars: 0.09, items: rows,
    };
    expect(reportPath(report)).toBe(join("eval/results", "calibration", "2026-10-14", "judge_q3.json"));
    expect(reportPath({ ...report, itemFilter: "Away Team" })).toBe(join("eval/results", "calibration", "2026-10-14", "judge_q3.item-away-team.json"));
    const root = mkdtempSync(join(tmpdir(), "calib-"));
    const written = JSON.parse(readFileSync(writeReport(report, root), "utf8")) as CalibrationReport;
    expect(written.items[1]!.reasoning).toBe(long);
  });

  it("--list-runs lists runs on the calibration dataset via the Experiments API with each item's verdict", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const api = {
      datasets: { get: async (name: string) => ({ id: `id-of-${name}` }) },
      experiments: {
        list: async (req: Record<string, unknown>) => {
          calls.push(req);
          return { data: [{ id: "exp1", name: "judge_q3 prompt v3 · 2026-10-14T09:00", description: null, startTime: "2026-10-14T09:00:00Z", endTime: "", itemCount: 1, datasetId: "x" }], meta: {} };
        },
        listItems: async (req: Record<string, unknown>) => {
          calls.push(req);
          return { data: [{ traceId: "t1", input: JSON.stringify({ company: "Agave" }), output: JSON.stringify({ score: "yes", reasoning: "r" }), expectedOutput: "yes", scores: [{ name: "judge_q3-judge-output-correct", value: true }] }], meta: {} };
        },
      },
    };
    const lines: string[] = [];
    expect(await listRuns(api as never, "judge_q3", 30, (l) => lines.push(l))).toBe(1);
    expect(calls[0]).toMatchObject({ datasetId: "id-of-judge-calibration/judge_q3" });
    expect(typeof calls[0]!.fromStartTime).toBe("string");
    expect(calls[1]).toMatchObject({ experimentId: "exp1", fields: "core,io,scores" });
    expect(lines.join("\n")).toContain("Agave | expected yes | actual yes | judge_q3-judge-output-correct=true | trace t1");
  });
});
