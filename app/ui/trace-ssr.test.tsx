import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block";

// Tooling check for the shadcn bridge: vendored Trace + Code Block render under React 18 SSR
// (renderToStaticMarkup, as our other UI tests do) with automatic JSX and the @ alias.
describe("shadcn Trace under React 18 SSR", () => {
  it("renders nested Trace + CodeBlock with running status", () => {
    const tree = h(
      Trace,
      null,
      h(
        TraceCollapsible,
        { defaultOpen: true },
        h(
          TraceCollapsibleTrigger,
          null,
          h(TraceLine, null, h(TraceTitle, null, "Turn 4: searched for new distribution centers"), h(TraceDescription, null, "$0.04")),
        ),
        h(
          TraceCollapsibleContent,
          null,
          h(
            Trace,
            null,
            h(TraceLine, null, h(TraceTitle, null, "Accepted Verst Logistics")),
            h(
              CodeBlock,
              { size: "sm" },
              h(CodeBlockHeader, null, h(CodeBlockTitle, null, "Evidence quote")),
              h(CodeBlockContent, { wrap: true }, "Employees: 507"),
            ),
          ),
        ),
      ),
      h(TraceLine, { status: "running" }, h(TraceTitle, null, "Looking up A. Duie Pyle")),
    );
    const out = renderToStaticMarkup(tree);
    expect(out).toContain('data-slot="trace"');
    expect(out).toContain('data-status="running"');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain("Employees: 507");
  });
});
