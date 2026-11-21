import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "../page";
import { AnalyticsProvider } from "./AnalyticsProvider";
import { ANALYTICS_COPY } from "./copy";

describe("footer disclosure", () => {
  it("is shown only under the analytics provider (key set)", () => {
    expect(ANALYTICS_COPY.disclosure).toBe("We log what you search to improve the tool.");
    const off = renderToStaticMarkup(h(Page));
    expect(off).not.toContain(ANALYTICS_COPY.disclosure);
    expect(off).toContain("About this build");
    const on = renderToStaticMarkup(h(AnalyticsProvider, { posthogKey: "phc_test", children: h(Page) }));
    expect(on).toContain(ANALYTICS_COPY.disclosure);
    expect(on).toContain("View source");
  });
});
