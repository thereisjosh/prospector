"use client";

import { SearchIcon } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type { CardSet } from "../../src/planner/cards";
import { allowanceLine, countryList, money, type AllowanceView } from "./copy";
import type { PlanResult } from "./types";

export type ContractStepProps = {
  demo: boolean;
  cards: CardSet;
  plan: PlanResult;
  targetLeads: number;
  setTargetLeads: (n: number) => void;
  maxSpend: number;
  setMaxSpend: (n: number) => void;
  busy: boolean;
  error: string;
  allowance: AllowanceView | null;
  /** Companies this workspace already remembers; in the demo, the recorded run skips them. */
  rememberedCount: number;
  onRun: () => void;
  onBack: () => void;
};

/**
 * Approve: the user's terms on one contract surface (goal, terms, starting search ideas, budget), then one
 * primary action. Hairline rows, no shadow: it sits in the page flow.
 */
export function ContractStep(props: ContractStepProps) {
  const { plan, cards } = props;
  const p = plan.plan;
  const required = p.gateFields.filter((g) => g.required);
  const optional = p.gateFields.filter((g) => !g.required);
  const spendValid = props.maxSpend >= 0.1 && props.maxSpend <= 5;
  const targetValid = Number.isInteger(props.targetLeads) && props.targetLeads >= 1 && props.targetLeads <= 50;
  const overBudget = plan.estimatedRunCost > props.maxSpend;
  const range = `${p.employeeRange.min.toLocaleString("en-US")}–${p.employeeRange.max.toLocaleString("en-US")}`;
  const question = (q: string) => q.replace(/\?$/, "");

  return (
    <div className="step narrow pr-approve">
      <section className="pr-contract" aria-labelledby="contract-h">
        <h2 id="contract-h" className="sr-only">The plan</h2>
        <div className="pr-contract-head">
          <div className="pr-contract-goal">
            <label htmlFor="target">Find</label>
            <input id="target" className="input num" type="number" min={1} max={50} value={props.targetLeads}
              onChange={(e) => props.setTargetLeads(Number(e.target.value))} aria-describedby="target-sub" />
            <span id="target-sub">companies that are</span>
          </div>
          <p className="pr-contract-who">
            <b>{cards.who.descriptor}</b> <span className="muted">({cards.who.industry})</span>
          </p>
        </div>
        <dl className="pr-terms">
          <div>
            <dt>Why now</dt>
            <dd>{cards.whyNow.description}, in the last {p.months} month{p.months === 1 ? "" : "s"}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              About {range} employees.{" "}
              {p.employeeRange.unknownPolicy === "allow-if-not-enterprise"
                ? "Companies that don't publish their size are kept unless they look like a large enterprise."
                : "Companies that don't publish their size are left out."}
            </dd>
          </div>
          <div>
            <dt>Based in</dt>
            <dd>{p.hqCountries.length ? countryList(p.hqCountries) : "Anywhere"}</dd>
          </div>
          {required.length > 0 && (
            <div>
              <dt>Must be true</dt>
              <dd>
                <ul className="pr-term-list">{required.map((g) => <li key={g.key}>{question(g.question)}</li>)}</ul>
              </dd>
            </div>
          )}
          {optional.length > 0 && (
            <div>
              <dt>Nice to have</dt>
              <dd>
                <ul className="pr-term-list">{optional.map((g) => <li key={g.key}>{question(g.question)}</li>)}</ul>
              </dd>
            </div>
          )}
          <div>
            <dt>Leave out</dt>
            <dd>
              {p.excludeNames.length === 0 && p.excludeDomains.length === 0
                ? "Nothing"
                : [
                    p.excludeNames.length ? `${p.excludeNames.length} compan${p.excludeNames.length === 1 ? "y" : "ies"} (${p.excludeNames.slice(0, 4).join(", ")}${p.excludeNames.length > 4 ? ", …" : ""})` : "",
                    p.excludeDomains.length ? `${p.excludeDomains.length} website${p.excludeDomains.length === 1 ? "" : "s"}` : "",
                  ].filter(Boolean).join(" and ")}
            </dd>
          </div>
        </dl>

        {p.signalQueries.length > 0 && (
          <div className="pr-ideas">
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine className="pr-ideas-title">
                  <TraceTitle>Starting search ideas</TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <p className="pr-ideas-intro">The agent writes its own searches. These are ideas it may start from.</p>
                <Trace className="pr-ideas-list">
                  {p.signalQueries.map((q) => (
                    <TraceLine key={q} className="pr-trace-line">
                      <TraceIcon>
                        <SearchIcon />
                      </TraceIcon>
                      <TraceTitle className="pr-trace-title pr-mono">{q}</TraceTitle>
                    </TraceLine>
                  ))}
                </Trace>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </div>
        )}

        <section className="pr-budget" aria-labelledby="budget-h">
          <h3 id="budget-h" className="pr-budget-label">Budget</h3>
          <div className="pr-budget-body">
            <div className="pr-budget-row">
              <label htmlFor="spend">Stop spending at</label>
              <span className="pr-money-input">
                <span aria-hidden="true">$</span>
                <input id="spend" className="input num" type="number" min={0.1} max={5} step={0.25} value={props.maxSpend}
                  onChange={(e) => props.setMaxSpend(Number(e.target.value))} />
              </span>
              <span className="muted">Estimated cost: about {money(plan.estimatedRunCost)}</span>
            </div>
            {!spendValid && <p className="inline-error">Choose a limit between $0.10 and $5.00.</p>}
            {!targetValid && <p className="inline-error">Ask for between 1 and 50 leads.</p>}
            {spendValid && overBudget && (
              <p className="pr-warn">The estimate is above your limit. The agent stops at the limit and tells you what it found.</p>
            )}
            {props.allowance && <p className="pr-fine" data-testid="allowance-line">{allowanceLine(props.allowance)}</p>}
            <p className="pr-fine">
              Before it spends anything, the agent shows you its opening plan for an OK. It also asks before changing any of the above.
            </p>
          </div>
        </section>
      </section>

      {props.demo && (
        <p className="pr-demo-line">
          Demo: the run that follows is a recording, so changes here won't change it.
          {props.rememberedCount > 0 &&
            ` This workspace already remembers ${props.rememberedCount} compan${props.rememberedCount === 1 ? "y" : "ies"} from an earlier run, so the recording skips ${props.rememberedCount === 1 ? "it" : "them"}.`}
        </p>
      )}
      {props.error && <p className="inline-error" role="alert">{props.error}</p>}

      <div className="actions">
        <button type="button" className="ghost-btn" onClick={props.onBack} disabled={props.busy}>Edit targeting</button>
        <button type="button" className="primary-btn" onClick={props.onRun} disabled={props.busy || !spendValid || !targetValid}>
          {props.busy ? "Starting…" : "Run agent"}
        </button>
      </div>
    </div>
  );
}
