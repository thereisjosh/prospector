/**
 * "Prospector — weekly" dashboard as code (eval/online/dashboard.ts), against a fake
 * Langfuse dashboard API. $0, no network.
 */
import { describe, expect, it } from "vitest";
import { DASHBOARD_NAME, dashboardWidgets, ensureDashboard, widgetQuery } from "./online/dashboard";

const MEASURES: Record<string, string[]> = {
  observations: ["count", "latency", "totalCost"],
  "scores-numeric": ["count", "value"],
  "scores-boolean": ["count", "value"],
  "scores-categorical": ["count"],
};

function fakeApi() {
  const widgets: Array<Record<string, unknown> & { id: string }> = [];
  const dashboards: Array<Record<string, unknown> & { id: string }> = [];
  const calls = { widgetCreate: 0, widgetUpdate: 0, dashCreate: 0, dashUpdate: 0 };
  const api = {
    unstable: {
      dashboardWidgets: {
        list: async () => ({ data: widgets.map((w) => JSON.parse(JSON.stringify(w))), meta: { totalPages: 1 } }),
        create: async (b: Record<string, unknown>) => {
          calls.widgetCreate += 1;
          const w = { ...b, id: `w${widgets.length + 1}` };
          widgets.push(w);
          return w;
        },
        update: async (id: string, b: Record<string, unknown>) => {
          calls.widgetUpdate += 1;
          Object.assign(widgets.find((w) => w.id === id)!, b);
          return {};
        },
      },
      dashboards: {
        list: async () => ({ data: dashboards.map((d) => JSON.parse(JSON.stringify(d))), meta: {} }),
        create: async (b: Record<string, unknown>) => {
          calls.dashCreate += 1;
          const d = { ...b, id: "d1" };
          dashboards.push(d);
          return d;
        },
        update: async (id: string, b: Record<string, unknown>) => {
          calls.dashUpdate += 1;
          Object.assign(dashboards.find((d) => d.id === id)!, b);
          return {};
        },
      },
    },
  };
  return { api: api as never, widgets, dashboards, calls };
}

describe("weekly dashboard (eval/online/dashboard.ts)", () => {
  it("covers the weekly metrics with valid views, measures and an environment on every widget", () => {
    const specs = dashboardWidgets();
    const names = specs.map((w) => w.name);
    for (const metric of ["stop_reason", "Target reached", "Handback rate", "Approval decisions", "Cost per run", "Cost per accepted lead", "Cost per good lead", "p95 turn latency", "user_feedback", "Must-pass failures", "Failed graders", "judge_good"]) {
      expect(names.some((n) => n.includes(metric))).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const w of specs) {
      for (const m of w.metrics) expect(MEASURES[w.view]).toContain(m.measure);
      expect(w.filters[0]).toEqual({ column: "environment", operator: "any of", type: "stringOptions", value: [w.environment] });
      expect(w.tile.x + w.tile.width).toBeLessThanOrEqual(12);
    }
    expect(specs.filter((w) => w.environment !== "production").map((w) => w.name)).toEqual(["Prospector · Cost per good lead, agent arm ($, offline judge)"]);
  });

  it("builds the Metrics API v2 query a widget runs, with the environment swapped for --verify", () => {
    const w = dashboardWidgets().find((x) => x.name.includes("Runs per day"))!;
    const q = widgetQuery(w, "online-eval-check", "2026-10-01T00:00:00Z", "2026-10-14T00:00:00Z");
    expect(q.metrics).toEqual([{ measure: "count", aggregation: "count" }]);
    expect(q.filters[0]).toMatchObject({ column: "environment", value: ["online-eval-check"] });
    expect(q.timeDimension).toEqual({ granularity: "day" });
  });

  it("creates the widgets and the dashboard once; a second run changes nothing; a spec change updates one widget", async () => {
    const fake = fakeApi();
    const first = await ensureDashboard(fake.api);
    expect(first).toMatchObject({ dashboard: "created", updated: [], unchanged: [] });
    expect(first.created).toHaveLength(dashboardWidgets().length);
    expect(fake.dashboards[0]).toMatchObject({ name: DASHBOARD_NAME });
    const placements = (fake.dashboards[0]!.definition as { widgets: Array<{ widgetId: string }> }).widgets;
    expect(placements.map((p) => p.widgetId)).toEqual(fake.widgets.map((w) => w.id));

    const second = await ensureDashboard(fake.api);
    expect(second).toMatchObject({ dashboard: "unchanged", created: [], updated: [] });
    expect(fake.calls).toEqual({ widgetCreate: first.created.length, widgetUpdate: 0, dashCreate: 1, dashUpdate: 0 });

    const specs = dashboardWidgets().map((w, i) => (i === 0 ? { ...w, description: "edited" } : w));
    const third = await ensureDashboard(fake.api, { specs });
    expect(third.updated).toEqual([specs[0]!.name]);
    expect(fake.calls.widgetUpdate).toBe(1);
  });

  it("refuses to guess between two widgets with the same name", async () => {
    const fake = fakeApi();
    await ensureDashboard(fake.api);
    fake.widgets.push({ ...fake.widgets[0]!, id: "dup" });
    await expect(ensureDashboard(fake.api)).rejects.toThrow(/2 widgets named/);
  });
});
