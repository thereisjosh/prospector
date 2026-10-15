"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { AgentEvent } from "../../src/agent/events";
import type { AcceptedLead, Handback } from "../../src/agent/state";
import type { CardSet } from "../../src/planner/cards";
import { Candidates } from "./Candidates";
import {
  RUN,
  UNVERIFIED_SUFFIX,
  formatDate,
  host,
  isHttpUrl,
  leadDate,
  leadFit,
  leadSize,
  leadsCsv,
  HANDBACK,
  TRACE,
  handbackWhy,
  reasonGroup,
  shortfallHeadline,
  stopSentence,
  suggestionPatch,
  suggestionTitle,
  isChangeField,
  droppedAfterLookup,
  type Screened,
  type ContractView,
  type SuggestionPatch,
} from "./copy";
import { ArrowUpRight, Download, Suggestion, ThumbDown, ThumbUp } from "./parts";
import { RunConfirmation, type Decision, type PendingApproval } from "./RunConfirmation";
import { ChecklistPanel, SpendPanel, shownSpend } from "./RunSide";
import { EvidenceBlock, LineIcon, LiveTrace, ProvenanceTrace } from "./RunTrace";
import { checklistModel, evidenceFor, rejectionsModel, traceModel, type RejectionSection } from "./trace-model";
import type { Feedback, RunSnapshot } from "./types";

export type { Decision } from "./RunConfirmation";

type Props = {
  demo: boolean;
  snapshot: RunSnapshot | null;
  /** Every event the run has sent so far, in order (POST /step and /decision responses). */
  events: AgentEvent[];
  screened: Screened;
  stepping: boolean;
  pausedByUser: boolean;
  runError: string;
  deciding: boolean;
  decisionError: string;
  onStop: () => void;
  onResume: () => void;
  onDecide: (decision: Decision) => void;
  feedback: Record<string, Feedback>;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
  onNewSearch: () => void;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function RunView(props: Props) {
  const { snapshot, events, stepping, pausedByUser, runError } = props;

  if (!snapshot) {
    return (
      <div className="state" aria-live="polite">
        {runError ? (
          <>
            <TriangleAlertIcon aria-hidden="true" className="pr-state-icon" />
            <p>{runError}</p>
            <button type="button" className="ghost-btn" onClick={props.onResume}>
              {RUN.tryAgain}
            </button>
          </>
        ) : (
          <TraceLine status="running" className="pr-run-line">
            <TraceTitle>Starting the agent…</TraceTitle>
          </TraceLine>
        )}
      </div>
    );
  }

  return <RunBody {...props} snapshot={snapshot} events={events} stepping={stepping} pausedByUser={pausedByUser} runError={runError} />;
}

function RunBody(props: Props & { snapshot: RunSnapshot }) {
  const { snapshot, events, stepping, pausedByUser, runError } = props;
  const { status, contract } = snapshot;
  const finished = status === "done" || status === "stopped" || status === "error";
  const pending = status === "awaiting_approval" ? snapshot.pendingApproval : undefined;
  const waiting = !!pending;
  const halted = !finished && !waiting && !stepping && (pausedByUser || !!runError);

  const tree = useMemo(() => traceModel(events, snapshot), [events, snapshot]);
  const checklist = useMemo(() => checklistModel(events, snapshot), [events, snapshot]);
  const spent = shownSpend(snapshot.spend);

  // M4: a resolved Confirmation fades out along its entry path, then its "You approved." line enters the Trace.
  const [leaving, setLeaving] = useState<PendingApproval | null>(null);
  const last = useRef<PendingApproval | undefined>(pending);
  const header = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = last.current;
    last.current = pending;
    if (!before || pending) return;
    // Focus was inside the Confirmation; keep it in the run instead of dropping it on <body>.
    header.current?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    setLeaving(before);
    const t = setTimeout(() => setLeaving(null), 150);
    return () => clearTimeout(t);
  }, [pending]);

  const decided = [...snapshot.leads.map((l) => l.company), ...snapshot.rejected.map((r) => r.company)];
  const rejections = rejectionsModel(
    snapshot,
    finished
      ? {
          // Recordings with lookup-stage screening say why each lookup failed; older ones don't.
          dropped: snapshot.screened ? [] : droppedAfterLookup(props.screened, decided),
          skipped: droppedAfterLookup({ lookedUp: props.screened.skipped, skipped: [] }, [...props.screened.lookedUp, ...decided]),
        }
      : {},
  );

  return (
    <div className="step run pr-run">
      {!finished &&
        (halted ? (
          <Checkpoint
            text={runError || RUN.pausedAt(snapshot.counters?.turns ?? 0, spent)}
            error={!!runError}
            action={runError ? RUN.tryAgain : RUN.keepGoing}
            onAction={props.onResume}
          />
        ) : (
          <RunHeader ref_={header} snapshot={snapshot} waiting={waiting} onStop={pausedByUser ? undefined : props.onStop} />
        ))}

      {pending && (
        <RunConfirmation
          key={pending.toolUseId ?? `${pending.tool}:${snapshot.counters?.turns ?? 0}`}
          demo={props.demo}
          pending={pending}
          contract={contract}
          deciding={props.deciding}
          error={props.decisionError}
          onDecide={props.onDecide}
        />
      )}
      {!pending && leaving && (
        <RunConfirmation leaving demo={props.demo} pending={leaving} contract={contract} deciding={false} error="" onDecide={() => undefined} />
      )}

      {finished && (
        <Outcome
          snapshot={snapshot}
          cards={props.cards}
          maxSpend={props.maxSpend}
          onApply={props.onApply}
          applying={props.applying}
          onEditTargeting={props.onEditTargeting}
          onNewSearch={props.onNewSearch}
        />
      )}

      {finished && <Leads leads={snapshot.leads} target={contract.targetLeads} contract={contract} finished live={false} feedback={props.feedback} onFeedback={props.onFeedback} />}

      <div className="pr-run-grid">
        <div className="pr-run-main">
          {finished ? (
            <>
              <Candidates candidates={snapshot.candidates ?? []} contract={contract} />
              <Rejections sections={rejections} />
              <ProvenanceTrace tree={tree} spent={spent} />
            </>
          ) : (
            <LiveTrace tree={tree} stepping={stepping} />
          )}
        </div>
        <SpendPanel spend={snapshot.spend} cap={contract.maxCostDollars} cache={tree.cache} />
        <ChecklistPanel model={checklist} finished={finished} decided={events.some((e) => e.kind === "decision")} />
      </div>

      {!finished && (
        <>
          <Leads
            leads={snapshot.leads}
            target={contract.targetLeads}
            contract={contract}
            finished={pausedByUser}
            live={!pausedByUser}
            feedback={props.feedback}
            onFeedback={props.onFeedback}
          />
          <Candidates candidates={snapshot.candidates ?? []} contract={contract} />
          <Rejections sections={rejections} />
        </>
      )}
    </div>
  );
}

/* ---------- run header: the one running line (M1) ---------- */

function RunHeader({
  snapshot,
  waiting,
  onStop,
  ref_,
}: {
  snapshot: RunSnapshot;
  waiting: boolean;
  onStop?: () => void;
  ref_: React.RefObject<HTMLDivElement>;
}) {
  const step = snapshot.counters?.turns ?? 0;
  return (
    <div ref={ref_} tabIndex={-1} className="pr-run-head">
      {waiting ? (
        <TraceLine className="pr-run-line">
          <span data-slot="trace-icon" aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-[var(--amber)]">
            <ClockIcon className="size-4" />
          </span>
          <TraceTitle role="status">Waiting for your OK</TraceTitle>
        </TraceLine>
      ) : (
        <TraceLine status="running" className="pr-run-line" data-testid="run-status">
          {/* The step number is visual only: screen readers hear each step once, from the Trace's announcement. */}
          <TraceTitle role="status">
            Working<span aria-hidden="true">{step ? `, step ${step}` : ""}</span>…
          </TraceTitle>
        </TraceLine>
      )}
      {!waiting && onStop && (
        <button type="button" className="ghost-btn small" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

/** A pause or lost contact is a real checkpoint: runs are durable, so its action is resume. */
function Checkpoint({ text, error, action, onAction }: { text: string; error: boolean; action: string; onAction: () => void }) {
  return (
    <Marker variant="separator" className="pr-checkpoint" data-error={error || undefined}>
      <MarkerContent className="pr-checkpoint-content">
        <span role="status">{text}</span>
        <button type="button" className="ghost-btn small" onClick={onAction}>
          {action}
        </button>
      </MarkerContent>
    </Marker>
  );
}

/* ---------- outcome / handback ---------- */

function Outcome({
  snapshot,
  cards,
  maxSpend,
  onApply,
  applying,
  onEditTargeting,
  onNewSearch,
}: {
  snapshot: RunSnapshot;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
  onNewSearch: () => void;
}) {
  const { handback, contract } = snapshot;
  const failed = snapshot.status === "error";
  return (
    <section className="outcome pr-outcome" aria-labelledby="outcome-h">
      <p className={failed ? "outcome-stop is-bad" : "outcome-stop"} role="status">
        {failed ? "The run hit a problem and stopped. Here's what it found first." : stopSentence(snapshot.stopReason, snapshot.status)}
        {!failed && snapshot.stopReason === "budget" && ` ${RUN.budgetSpent(shownSpend(snapshot.spend), contract.maxCostDollars)}`}
      </p>
      <h2 id="outcome-h">
        {handback
          ? shortfallHeadline(handback.shortfall, snapshot.leads.length, contract.targetLeads)
          : snapshot.leads.length > 0
            ? `Found ${snapshot.leads.length} lead${snapshot.leads.length === 1 ? "" : "s"}`
            : "No leads this time"}
        {UNVERIFIED_SUFFIX((snapshot.candidates ?? []).length)}
      </h2>
      {snapshot.summary && <p className="outcome-summary">{snapshot.summary}</p>}
      {handback && <HandbackView handback={handback} contract={contract} cards={cards} maxSpend={maxSpend} onApply={onApply} applying={applying} onEditTargeting={onEditTargeting} />}
      <div className="actions">
        <button type="button" className="ghost-btn" onClick={onEditTargeting}>
          Adjust targeting and run again
        </button>
        <button type="button" className="link-btn" onClick={onNewSearch}>
          Start a new search
        </button>
      </div>
    </section>
  );
}

function HandbackView({
  handback,
  contract,
  cards,
  maxSpend,
  onApply,
  applying,
  onEditTargeting,
}: {
  handback: Handback;
  contract: ContractView;
  cards: CardSet | null;
  maxSpend: number;
  onApply: (patch: SuggestionPatch) => void;
  applying: boolean;
  onEditTargeting: () => void;
}) {
  const reasons = handback.top_reasons.filter((r) => r.count > 0);
  const rows = handback.suggestions
    .map((s) => {
      const patch = cards ? suggestionPatch(s, cards, maxSpend) : null;
      const why = handbackWhy(s, contract, handback);
      // "none" / "scope": advice, not a change. A row of words with no action.
      if (!patch && !isChangeField(s.field)) return why ? { title: "", why, patch: null, change: false } : null;
      return { title: patch ? patch.label : suggestionTitle(s.field, s.value, contract), why, patch, change: true };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  return (
    <>
      {reasons.length > 0 && (
        <p className="pr-reasons">
          {HANDBACK.mostOften}{" "}
          {reasons.map((r, i) => (
            <span key={r.code}>
              {i > 0 && " · "}
              <b className="ink">{reasonGroup(r.code, "", contract).toLowerCase()}</b> ({r.count})
            </span>
          ))}
        </p>
      )}
      {rows.length > 0 && (
        <section className="pr-handback" aria-labelledby="handback-h">
          <h3 id="handback-h" className="pr-handback-h">
            {TRACE.handbackSuggestions}
          </h3>
          <ul className="pr-handback-rows">
            {rows.map((row, i) => (
              <li key={i} className={row.change ? "pr-handback-row" : "pr-handback-row is-note"}>
                <div className="pr-handback-text">
                  {row.title && <p className="pr-handback-title">{row.title}</p>}
                  {row.why && <p className="pr-handback-why">{row.why}</p>}
                </div>
                {row.patch ? (
                  <Suggestion disabled={applying} onClick={() => row.patch && onApply(row.patch)}>
                    {applying ? HANDBACK.applying : HANDBACK.apply}
                  </Suggestion>
                ) : row.change ? (
                  <Suggestion onClick={onEditTargeting}>{HANDBACK.adjust}</Suggestion>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/* ---------- leads ---------- */

function Leads({
  leads,
  target,
  contract,
  finished,
  live,
  feedback,
  onFeedback,
}: {
  leads: AcceptedLead[];
  target: number;
  contract: ContractView;
  finished: boolean;
  live: boolean;
  feedback: Record<string, Feedback>;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
}) {
  const exportCsv = () => {
    const blob = new Blob([leadsCsv(leads, feedback)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prospector-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="leads" aria-labelledby="leads-h">
      <div className="section-head">
        <h2 id="leads-h">
          Leads <span className="count">{leads.length}</span> <span className="pr-leads-of">{RUN.leadsOf(target)}</span>
        </h2>
        {leads.length > 0 && (
          <button type="button" className="ghost-btn small" onClick={exportCsv}>
            <Download /> Download CSV
          </button>
        )}
      </div>
      {leads.length === 0 ? (
        <p className="empty-line">{live ? "Leads appear here as soon as one passes every check." : "No company passed every check."}</p>
      ) : (
        <div className="results">
          <div className="lrow lrow-head" aria-hidden="true">
            <span>Company and fit</span>
            <span>Why now</span>
            <span>Event date</span>
            <span>Size</span>
            <span>Source</span>
            <span>Good lead?</span>
          </div>
          <ul className="lrows">
            {leads.map((lead) => (
              <LeadRow key={lead.company} lead={lead} contract={contract} finished={finished} live={live} fb={feedback[lead.company] ?? {}} onFeedback={onFeedback} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LeadRow({
  lead,
  contract,
  finished,
  live,
  fb,
  onFeedback,
}: {
  lead: AcceptedLead;
  contract: ContractView;
  finished: boolean;
  live: boolean;
  fb: Feedback;
  onFeedback: (company: string, next: Feedback, send: boolean) => void;
}) {
  const size = leadSize(lead);
  const date = leadDate(lead);
  const reasonId = useId();
  const evidence = useMemo(() => evidenceFor(lead, contract), [lead, contract]);
  // M6 only for a row that lands while the run is live; a finished table appears as it is.
  const [isNew] = useState(live);
  return (
    <li className={isNew ? "lrow is-new" : "lrow"}>
      <div className="cell-company">
        <div className="company-name">{lead.company}</div>
        <div className="fit" title={leadFit(lead)}>
          {leadFit(lead)}
        </div>
      </div>
      <div className="cell-why">
        <span className="cell-label">Why now</span>
        {lead.why_now}
      </div>
      <div className="cell-date">
        <span className="cell-label">Event date</span>
        <span className="date-abs">{formatDate(date) || "Unknown"}</span>
      </div>
      <div className="cell-size">
        <span className="cell-label">Size</span>
        <span>{size.text}</span>
        <span className="basis">{size.basis}</span>
      </div>
      <div className="cell-source">
        <span className="cell-label">Source</span>
        {isHttpUrl(lead.signal_url) ? (
          <a href={lead.signal_url} target="_blank" rel="noopener noreferrer">
            <span>{host(lead.signal_url)}</span> <ArrowUpRight />
          </a>
        ) : (
          <span className="no-source">No safe link</span>
        )}
      </div>
      <div className="cell-fb">
        {finished ? (
          fb.sent ? (
            <span className="fb-done">{fb.verdict === "up" ? "Marked good" : "Marked not a fit"}. Remembered for next time.</span>
          ) : (
            <>
              <div className="thumbs" role="group" aria-label={`Is ${lead.company} a good lead?`}>
                <button
                  type="button"
                  className={`thumb ${fb.verdict === "up" ? "is-on" : ""}`}
                  aria-pressed={fb.verdict === "up"}
                  aria-label="Good lead"
                  disabled={fb.sending}
                  onClick={() => onFeedback(lead.company, { verdict: "up", open: true }, false)}
                >
                  <ThumbUp />
                </button>
                <button
                  type="button"
                  className={`thumb ${fb.verdict === "down" ? "is-on" : ""}`}
                  aria-pressed={fb.verdict === "down"}
                  aria-label="Not a fit"
                  disabled={fb.sending}
                  onClick={() => onFeedback(lead.company, { verdict: "down", open: true }, false)}
                >
                  <ThumbDown />
                </button>
              </div>
              {fb.open && fb.verdict && (
                <div className="fb-form">
                  <label htmlFor={reasonId} className="sr-only">
                    Why? (optional)
                  </label>
                  <input
                    id={reasonId}
                    className="input small"
                    placeholder="Why? (optional)"
                    value={fb.reason ?? ""}
                    onChange={(e) => onFeedback(lead.company, { ...fb, reason: e.target.value }, false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onFeedback(lead.company, fb, true);
                    }}
                  />
                  <button type="button" className="ghost-btn small" disabled={fb.sending} onClick={() => onFeedback(lead.company, fb, true)}>
                    {fb.sending ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
              {fb.error && <span className="inline-error small">Couldn't save. Try again.</span>}
            </>
          )
        ) : (
          <span className="muted small">After the run</span>
        )}
      </div>
      <div className="lrow-evidence">
        <TraceCollapsible>
          <TraceCollapsibleTrigger className="pr-press">
            <TraceLine className="pr-trace-line">
              <LineIcon name="file" />
              <TraceTitle className="pr-trace-title">{RUN.evidenceSummary(evidence.quotes.length)}</TraceTitle>
              {evidence.source && <TraceDescription className="pr-trace-desc">{evidence.source}</TraceDescription>}
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <EvidenceBlock detail={evidence} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </div>
    </li>
  );
}

/* ---------- considered but not added ---------- */

const SECTION_ICON: Record<RejectionSection["kind"], "x" | "building" | "note"> = { checks: "x", lookup: "building", dropped: "note", skipped: "note" };

function Rejections({ sections }: { sections: RejectionSection[] }) {
  const total = sections.reduce((n, s) => n + s.count, 0);
  if (total === 0) return null;
  return (
    <section className="rejections" aria-labelledby="rej-h">
      <div className="section-head">
        <h2 id="rej-h">
          {RUN.consideredHeading} <span className="count">{total}</span>
        </h2>
      </div>
      <div className="pr-sections pr-rej">
        {sections.map((s) => (
          <TraceCollapsible key={s.id}>
            <TraceCollapsibleTrigger className="pr-press">
              <TraceLine className="pr-trace-line">
                <LineIcon name={SECTION_ICON[s.kind]} />
                <TraceTitle className="pr-trace-title text-foreground">{s.label}</TraceTitle>
                <TraceDescription className="pr-trace-desc">{s.count}</TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent keepMounted>
              {s.items.some((i) => i.phrase) ? (
                <ul className="rej-items">
                  {s.items.map((item, i) => (
                    <li key={item.company + i}>
                      <b>{item.company}</b> {item.phrase && <span className="muted">{item.phrase}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rej-names muted">
                  {s.items.map((i) => i.company).join(", ")}
                  {s.count > s.items.length ? ` and ${s.count - s.items.length} more` : ""}
                </p>
              )}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        ))}
      </div>
    </section>
  );
}
