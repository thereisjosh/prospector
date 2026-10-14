import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Candidates } from "./Candidates";
import { UNVERIFIED_SUFFIX, candidateReason } from "./copy";
import type { UnverifiedCandidate } from "./types";

const c: UnverifiedCandidate = {
  company: "Sybill",
  signal_url: "https://www.sybill.ai/blog/raise",
  why_now: "Hiring its first VP Sales",
  code: "unquoted_gate",
  missing: "funding stage not stated on sybill.ai",
};
const html = (list: UnverifiedCandidate[]) => renderToStaticMarkup(createElement(Candidates, { candidates: list }));

describe("unverified candidates", () => {
  it("renders nothing without candidates", () => {
    expect(html([])).toBe("");
  });

  it("renders each row with company, why-now, link and the not-counted reason", () => {
    const out = html([c]);
    expect(out).toContain("Unverified candidates");
    expect(out).toContain("Not counted as leads");
    expect(out).toContain("Sybill");
    expect(out).toContain("Hiring its first VP Sales");
    expect(out).toContain('href="https://www.sybill.ai/blog/raise"');
    expect(out).toContain("Not counted: funding stage not stated on sybill.ai");
  });

  it("refuses unsafe links", () => {
    expect(html([{ ...c, signal_url: "javascript:alert(1)" }])).not.toContain("javascript:");
  });

  it("never touches the lead count: the suffix is separate and only shows when M > 0", () => {
    expect(UNVERIFIED_SUFFIX(0)).toBe("");
    expect(`Found 3 leads${UNVERIFIED_SUFFIX(2)}`).toBe("Found 3 leads · 2 unverified");
    expect(candidateReason("funding stage not stated on x.com.")).toBe("Not counted: funding stage not stated on x.com");
  });
});
