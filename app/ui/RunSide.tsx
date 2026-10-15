"use client";

/**
 * The run's side column (docs/UI-REWORK.md §2): Spend, then the agent's checklist as a Queue.
 * Flat sections divided by a hairline, not three identical panels (§6).
 */
import { CircleCheckIcon, CircleIcon, InfoIcon } from "lucide-react";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/components/ui/trace";
import { RUN, money } from "./copy";
import type { ChecklistModel, TraceTree } from "./trace-model";
import type { RunSnapshot } from "./types";

/** Spend total as the sum of the two rounded parts, so the three figures on screen always add up. */
export function shownSpend(spend: RunSnapshot["spend"]): number {
  return Math.round(spend.claude * 100) / 100 + Math.round(spend.exa * 100) / 100;
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

export function SpendPanel({ spend, cap, cache }: { spend: RunSnapshot["spend"]; cap: number; cache?: TraceTree["cache"] }) {
  const total = shownSpend(spend);
  const safeCap = Math.max(cap, 0.01);
  // M7: transform, never width. The web segment starts where the AI segment ends.
  const ai = clamp(spend.claude / safeCap, 1);
  const web = clamp(spend.exa / safeCap, 1 - ai);
  return (
    <section className="pr-side pr-spend" aria-labelledby="spend-h">
      <h2 id="spend-h" className="pr-section-title">
        {RUN.spendHeading}
      </h2>
      <p className="spend-total">
        <b>{money(total)}</b> <span className="muted">{RUN.ofLimit(cap)}</span>
      </p>
      <div
        className="pr-meter"
        role="meter"
        aria-label="Money spent"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Number(spend.total.toFixed(2))}
        aria-valuetext={`${money(total)} of ${money(cap)}`}
      >
        <span className="spend-ai" style={{ transform: `scaleX(${ai})` }} />
        <span className="spend-web" style={{ transform: `translateX(${ai * 100}%) scaleX(${web})` }} />
      </div>
      <ul className="spend-legend">
        <li>
          <span className="swatch swatch-ai" aria-hidden="true" />
          AI reasoning {money(spend.claude)}
        </li>
        <li>
          <span className="swatch swatch-web" aria-hidden="true" />
          Web research {money(spend.exa)}
        </li>
      </ul>
      {cache && (
        <TraceCollapsible className="pr-cache">
          <TraceCollapsibleTrigger className="pr-press">
            <TraceLine className="pr-trace-line">
              <TraceTitle className="pr-trace-title">{cache.text}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <p className="pr-detail-text">{RUN.cacheDetail(cache.read, cache.written, cache.uncached)}</p>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </section>
  );
}

/** The agent's checklist as a Queue: [ ] / [x] items, its bold-key notes as labelled lines, and how stale it is. */
export function ChecklistPanel({ model, finished }: { model: ChecklistModel; finished: boolean }) {
  return (
    <section className="pr-side pr-checklist" aria-labelledby="todo-h">
      <h2 id="todo-h" className="pr-section-title">
        {RUN.checklistHeading(finished)}
      </h2>
      {model.items.length === 0 ? (
        <p className="muted pr-side-empty">{RUN.checklistEmpty(finished)}</p>
      ) : (
        <>
          <ul className="pr-queue">
            {model.items.map((item, i) => {
              if (item.kind === "todo" || item.kind === "done") {
                const done = item.kind === "done";
                const Icon = done ? CircleCheckIcon : CircleIcon;
                return (
                  <li key={i} className={done ? "is-done" : undefined}>
                    <Icon aria-hidden="true" className={done ? "pr-queue-icon text-[var(--green)]" : "pr-queue-icon"} />
                    <span>
                      <span className="sr-only">{done ? `${RUN.done}: ` : `${RUN.todo}: `}</span>
                      {item.text}
                    </span>
                  </li>
                );
              }
              if (item.kind === "note") {
                return (
                  <li key={i} className="is-note">
                    <span>
                      <b>{item.label}:</b> {item.text}
                    </span>
                  </li>
                );
              }
              return (
                <li key={i} className="is-text">
                  <span>{item.text}</span>
                </li>
              );
            })}
          </ul>
          {(model.updatedLine || model.staleLine) && (
            <div className="pr-queue-meta">
              {model.updatedLine && <p>{model.updatedLine}</p>}
              {model.staleLine && (
                <p className="pr-queue-stale">
                  <InfoIcon aria-hidden="true" />
                  {model.staleLine}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
