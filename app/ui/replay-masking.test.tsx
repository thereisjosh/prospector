import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardSet } from "../../src/planner/cards";
import { ContractStep } from "./ContractStep";
import { StartStep, type StartStepProps } from "./StartStep";
import type { PlanResult, SellerProfile } from "./types";

// ph-no-capture is posthog-js's default blockClass: the element is blocked from session replay and autocapture.
const PLANNER = join(import.meta.dirname, "..", "..", "eval", "demo", "planner");
const cards = JSON.parse(readFileSync(join(PLANNER, "cards.json"), "utf8")).cards as CardSet;
const plan = JSON.parse(readFileSync(join(PLANNER, "plan.json"), "utf8")) as PlanResult;
const profile = (JSON.parse(readFileSync(join(PLANNER, "profile.json"), "utf8")) as { profile: SellerProfile }).profile;
const noop = () => undefined;

function start(over: Partial<StartStepProps>) {
  const props: StartStepProps = {
    demo: false, input: "", setInput: noop, busy: false, error: "", candidates: null, askDescription: false,
    description: "", setDescription: noop, profile: null, setProfile: noop, editing: false, setEditing: noop,
    onSubmit: noop, onPickCandidate: noop, onDescribe: noop, onDescribeInstead: noop, onContinue: noop, ...over,
  };
  return renderToStaticMarkup(h(StartStep, props));
}

describe("seller text is blocked from replay wherever it is re-displayed", () => {
  it("the submitted words and the profile sentence on the Describe step", () => {
    const html = start({ input: "We sell secret widgets to cafes", profile });
    expect(html).toMatch(/data-slot="bubble-content"[^>]*class="[^"]*ph-no-capture[^"]*"[^>]*>We sell secret widgets to cafes</);
    expect(html).toMatch(/<p class="pr-profile-line ph-no-capture">We think you sell/);
  });

  it("the profile editor's text lives in inputs, which replay masks (maskAllInputs)", () => {
    const html = start({ input: "x", profile, editing: true });
    expect(html).toMatch(/<input id="p-offering"/);
    expect(html).not.toContain("pr-profile-line");
  });

  it("the plan text derived from it on the Approve step", () => {
    const html = renderToStaticMarkup(
      h(ContractStep, {
        demo: true, cards, plan, targetLeads: 10, setTargetLeads: noop, maxSpend: 1, setMaxSpend: noop, busy: false, error: "",
        allowance: null, rememberedCount: 0, onRun: noop, onBack: noop,
      }),
    );
    expect(html).toMatch(/<p class="pr-contract-who ph-no-capture">/);
    expect(html).toMatch(/<dd class="ph-no-capture">/);
  });
});
