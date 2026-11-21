import posthog from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config as middlewareConfig } from "../middleware";
import nextConfig from "../next.config.mjs";
import { SELLER_TEXT_CAP, initAnalytics, resetAnalyticsForTests, sellerKind, sellerSubmittedProps, track } from "./analytics";

vi.mock("posthog-js", () => ({ default: { init: vi.fn(), capture: vi.fn() } }));

const init = vi.mocked(posthog.init);
const capture = vi.mocked(posthog.capture);

beforeEach(() => {
  vi.stubGlobal("window", {});
  resetAnalyticsForTests();
  init.mockClear();
  capture.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("track before init", () => {
  it("is a no-op and does not throw", () => {
    expect(() => track("profile_confirmed")).not.toThrow();
    expect(() => track("run_finished", { run_id: "r1" })).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it("stays off without a key: no init, no capture", async () => {
    for (const key of [undefined, "", "   "]) expect(await initAnalytics(key)).toBe(false);
    track("new_search", { run_id: "r1" });
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("stays off outside a browser", async () => {
    vi.unstubAllGlobals();
    expect(await initAnalytics("phc_test")).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });
});

describe("init", () => {
  it("starts PostHog US through the proxy, once, anonymous, masked", async () => {
    expect(await initAnalytics("phc_test")).toBe(true);
    expect(await initAnalytics("phc_test")).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/ingest",
        ui_host: "https://us.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: "history_change",
        session_recording: { maskAllInputs: true },
      }),
    );
  });

  it("captures events once initialised", async () => {
    await initAnalytics("phc_test");
    track("run_started", { run_id: "r1" });
    expect(capture).toHaveBeenCalledWith("run_started", { run_id: "r1" });
  });
});

describe("run_finished", () => {
  it("fires once per run id even if called twice", async () => {
    await initAnalytics("phc_test");
    track("run_finished", { run_id: "r1", status: "done" });
    track("run_finished", { run_id: "r1", status: "done" });
    expect(capture.mock.calls.filter(([name]) => name === "run_finished")).toHaveLength(1);
    track("run_finished", { run_id: "r2", status: "done" });
    expect(capture.mock.calls.filter(([name]) => name === "run_finished")).toHaveLength(2);
  });

  it("is not recorded as reported while analytics is off", async () => {
    track("run_finished", { run_id: "r1" });
    await initAnalytics("phc_test");
    track("run_finished", { run_id: "r1" });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe("seller_submitted props", () => {
  it("caps the text at 500 chars and keeps the full length", () => {
    const long = ` ${"x".repeat(SELLER_TEXT_CAP + 120)} `;
    const props = sellerSubmittedProps(long);
    expect(props.text).toHaveLength(SELLER_TEXT_CAP);
    expect(props.length).toBe(SELLER_TEXT_CAP + 120);
    expect(sellerSubmittedProps("  hello  ").text).toBe("hello");
  });

  it("classifies url, handle and sentence", () => {
    expect(sellerKind("acme-logistics.com")).toBe("url");
    expect(sellerKind("https://acme.example/about")).toBe("url");
    expect(sellerKind("@acmecoffee")).toBe("handle");
    expect(sellerKind("We sell payment terminals to cafes in Singapore")).toBe("sentence");
    expect(sellerKind("We sell labor software. Mostly to 3PLs.")).toBe("sentence");
  });
});

describe("proxy", () => {
  it("rewrites /ingest to the US hosts, static first, with trailing-slash redirects off", async () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
    const rules = await nextConfig.rewrites!();
    expect(rules).toEqual([
      { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ]);
  });

  it("keeps /ingest outside the middleware matcher", () => {
    for (const m of middlewareConfig.matcher) expect(new RegExp(`^${m}$`).test("/ingest/e/")).toBe(false);
    expect(middlewareConfig.matcher.every((m) => m.startsWith("/api/"))).toBe(true);
  });
});
