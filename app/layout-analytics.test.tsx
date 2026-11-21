import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootLayout from "./layout";

const initAnalytics = vi.hoisted(() => vi.fn());

vi.mock("./analytics", () => ({ initAnalytics }));
// Stand-in that makes the provider visible in static markup (the real one only renders children).
vi.mock("./ui/AnalyticsProvider", () => ({
  AnalyticsProvider: ({ posthogKey, children }: { posthogKey: string; children: ReactNode }) =>
    createElement("div", { "data-analytics-provider": posthogKey }, children),
}));

const render = () => renderToStaticMarkup(createElement(RootLayout, { children: createElement("main", null, "page") }));

afterEach(() => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  initAnalytics.mockClear();
});

describe("RootLayout PostHog", () => {
  it("renders no provider and no PostHog anything without the key", () => {
    for (const value of [undefined, "", "  "]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      else process.env.NEXT_PUBLIC_POSTHOG_KEY = value;
      const html = render();
      expect(html).not.toContain("data-analytics-provider");
      expect(html.toLowerCase()).not.toContain("posthog");
      expect(html).not.toContain("/ingest");
      expect(html).toContain("<main>page</main>");
    }
    expect(initAnalytics).not.toHaveBeenCalled();
  });

  it("wraps the children in the provider, with the runtime key, when it is set", () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const html = render();
    expect(html).toContain('data-analytics-provider="phc_test"');
    expect(html).toContain("<main>page</main>");
    expect(html.match(/data-analytics-provider/g)).toHaveLength(1);
  });
});
