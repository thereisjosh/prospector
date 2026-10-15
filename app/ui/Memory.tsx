"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

/**
 * The rail's "What I remember" (docs/UI-REWORK.md §1a): what the agent keeps between runs, where each item
 * came from, and a way to drop any of it. Three Trace sections (one line per item, provenance as the
 * description), a per-item forget button, and clear-all behind a Confirmation. The disclosure is a
 * Collapsible that remembers whether it was open (localStorage, best effort).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Building2Icon, ChevronRightIcon, HistoryIcon, ThumbsDownIcon, ThumbsUpIcon, XIcon, type LucideIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item";
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { MEMORY_COPY, provenance, runLabel, seenWhen, shortDate } from "./copy";
import type { MemoryView } from "./types";

/** How the last finished run in this tab ended, for the "no note this time" line. */
export type LastRun = { stopReason?: string; selfNotes: number };

type Props = {
  memory: MemoryView | null;
  error: boolean;
  onClear: () => void;
  /** Forget one item (a seen company, a piece of feedback, a note) by its id. */
  onForget: (itemId: string) => void | Promise<void>;
  disabled: boolean;
  lastRun?: LastRun;
  /** Tests and first paint: open before localStorage is read. */
  defaultOpen?: boolean;
};

const OPEN_KEY = "prospector.memoryOpen";

function readOpen(): boolean | undefined {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    return v === "1" ? true : v === "0" ? false : undefined;
  } catch {
    return undefined;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // private window or blocked storage: the panel still works, it just won't remember
  }
}

/** The run stopped at its budget and saved no note: the `remember` nudge never ran (src/agent/tools.ts). */
export function budgetStoppedWithoutNote(lastRun: LastRun | undefined): boolean {
  return !!lastRun && lastRun.stopReason === "budget" && lastRun.selfNotes === 0;
}

function Forget({ what, id, onForget, disabled, pending }: { what: string; id: string; onForget: (id: string) => void; disabled: boolean; pending: boolean }) {
  const label = MEMORY_COPY.forget(what);
  return (
    // Attribute order (class, then disabled) is relied on by eval/memory.test.ts.
    <button type="button" className="memory-forget" disabled={disabled || pending} aria-label={label} title={label} onClick={() => onForget(id)}>
      <XIcon aria-hidden="true" />
    </button>
  );
}

function MemoryLine({
  icon: Icon,
  title,
  description,
  detail,
  forget,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  detail?: string;
  forget: React.ReactNode;
}) {
  return (
    <li className="pr-mem-item">
      <TraceLine className="pr-mem-line">
        <TraceIcon className="pr-mem-icon">
          <Icon />
        </TraceIcon>
        <span className="pr-mem-body">
          <TraceTitle className="pr-mem-title">{title}</TraceTitle>
          {detail && <span className="pr-mem-detail">{detail}</span>}
          {description && <TraceDescription className="pr-mem-desc">{description}</TraceDescription>}
        </span>
      </TraceLine>
      {forget}
    </li>
  );
}

export function MemoryPanel({ memory, error, onClear, onForget, disabled, lastRun, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const questionId = useId();
  const question = useRef<HTMLHeadingElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Restore the remembered open state after hydration (the server can't know it).
  useEffect(() => {
    const saved = readOpen();
    if (saved !== undefined) setOpen(saved);
  }, []);

  // A refetch settles every pending forget: removed items are gone, failed ones come back enabled.
  useEffect(() => setPending(new Set()), [memory, error]);

  // The Confirmation takes focus when it opens and gives it back to "Clear memory" when it closes.
  useEffect(() => {
    if (confirming) question.current?.focus();
    else if (wasConfirming.current) clearButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const toggle = (next: boolean) => {
    setOpen(next);
    writeOpen(next);
    if (!next) setConfirming(false);
  };

  const forget = (id: string) => {
    setPending((p) => new Set(p).add(id));
    void onForget(id);
  };

  const budgetLine = budgetStoppedWithoutNote(lastRun);
  const empty = memory && memory.seen.length === 0 && memory.preferences.length === 0 && memory.notes.length === 0 && !budgetLine;
  const total = memory ? memory.seenCount + memory.preferences.length + memory.notes.length : 0;
  const forgetProps = (id: string) => ({ id, onForget: forget, disabled, pending: pending.has(id) });

  return (
    <Collapsible open={open} onOpenChange={toggle} className="memory pr-mem">
      <CollapsibleTrigger className="pr-mem-trigger pr-press">
        <span>{MEMORY_COPY.panelTitle}</span>
        {total > 0 && <span className="pr-mem-count">{total}</span>}
        <ChevronRightIcon aria-hidden="true" className="pr-mem-chevron" />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="pr-mem-panel">
        {error ? (
          <p className="memory-text">{MEMORY_COPY.loadError}</p>
        ) : !memory ? (
          <p className="memory-text">{MEMORY_COPY.loading}</p>
        ) : empty ? (
          <p className="memory-text">{MEMORY_COPY.empty}</p>
        ) : (
          <>
            {memory.seen.length > 0 && (
              <section className="memory-group" aria-label={MEMORY_COPY.seenHeading}>
                <h3>{MEMORY_COPY.seenHeading}</h3>
                <p className="memory-text">{MEMORY_COPY.seenSummary(memory.seenCount)}</p>
                <Trace className="pr-mem-list">
                  <ul className="pr-mem-items">
                    {memory.seen.map((item) => (
                      <MemoryLine
                        key={item.id}
                        icon={Building2Icon}
                        title={item.name}
                        description={provenance(seenWhen(item), runLabel(item.runId))}
                        forget={<Forget what={item.name} {...forgetProps(item.id)} />}
                      />
                    ))}
                  </ul>
                </Trace>
                {memory.seenCount > memory.seen.length && <p className="memory-meta">{MEMORY_COPY.latestOnly(memory.seen.length, memory.seenCount)}</p>}
              </section>
            )}

            {memory.preferences.length > 0 && (
              <section className="memory-group" aria-label={MEMORY_COPY.feedbackHeading}>
                <h3>{MEMORY_COPY.feedbackHeading}</h3>
                <Trace className="pr-mem-list">
                  <ul className="pr-mem-items">
                    {memory.preferences.map((item) => (
                      <MemoryLine
                        key={item.id}
                        icon={item.verdict === "up" ? ThumbsUpIcon : ThumbsDownIcon}
                        title={item.company}
                        detail={item.reason || undefined}
                        description={provenance(
                          `${item.verdict === "up" ? MEMORY_COPY.liked : MEMORY_COPY.rejected}${shortDate(item.at) ? ` ${shortDate(item.at)}` : ""}`,
                          runLabel(item.runId),
                        )}
                        forget={<Forget what={MEMORY_COPY.forgetFeedback(item.company)} {...forgetProps(item.id)} />}
                      />
                    ))}
                  </ul>
                </Trace>
              </section>
            )}

            {(memory.notes.length > 0 || budgetLine) && (
              <section className="memory-group" aria-label={MEMORY_COPY.learnedHeading}>
                <h3>{MEMORY_COPY.learnedHeading}</h3>
                {budgetLine && <p className="memory-text pr-mem-quiet">{MEMORY_COPY.noNoteBudget}</p>}
                {memory.notes.length > 0 && (
                  <Trace className="pr-mem-list">
                    <ul className="pr-mem-items">
                      {memory.notes.map((item) => (
                        <MemoryLine
                          key={item.id}
                          icon={HistoryIcon}
                          title={item.text}
                          description={provenance(`saved ${shortDate(item.at)}`, MEMORY_COPY.expires(item.expiresAt), runLabel(item.runId))}
                          forget={<Forget what={MEMORY_COPY.forgetNote} {...forgetProps(item.id)} />}
                        />
                      ))}
                    </ul>
                  </Trace>
                )}
              </section>
            )}

            {confirming ? (
              <Item
                variant="outline"
                size="sm"
                render={<section />}
                aria-labelledby={questionId}
                className="pr-mem-confirm"
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setConfirming(false);
                  }
                }}
              >
                <ItemContent className="min-w-0 gap-1">
                  <h4 id={questionId} ref={question} tabIndex={-1} className="pr-mem-confirm-title">
                    {MEMORY_COPY.clearQuestion}
                  </h4>
                  <ItemDescription className="pr-mem-confirm-text">{MEMORY_COPY.clearDetail}</ItemDescription>
                </ItemContent>
                <ItemActions className="pr-mem-confirm-actions">
                  <button
                    type="button"
                    className="rail-btn danger"
                    disabled={disabled}
                    onClick={() => {
                      setConfirming(false);
                      onClear();
                    }}
                  >
                    {MEMORY_COPY.clearConfirm}
                  </button>
                  <button type="button" className="rail-btn" onClick={() => setConfirming(false)}>
                    {MEMORY_COPY.cancel}
                  </button>
                </ItemActions>
              </Item>
            ) : (
              <button ref={clearButton} type="button" className="rail-btn" disabled={disabled} onClick={() => setConfirming(true)}>
                {MEMORY_COPY.clear}
              </button>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
