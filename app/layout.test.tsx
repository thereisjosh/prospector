import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import RootLayout from "./layout";

afterEach(() => delete process.env.NEXT_PUBLIC_CF_BEACON_TOKEN);

describe("RootLayout analytics beacon", () => {
  it("renders no beacon without a token and one configured beacon with it", () => {
    expect(renderToStaticMarkup(createElement(RootLayout, { children: createElement("main") }))).not.toContain("static.cloudflareinsights.com");
    process.env.NEXT_PUBLIC_CF_BEACON_TOKEN = "public-token";
    const html = renderToStaticMarkup(createElement(RootLayout, { children: createElement("main") }));
    expect((html.match(/static\.cloudflareinsights\.com/g) ?? [])).toHaveLength(1);
    expect(html).toContain("public-token");
  });
});
