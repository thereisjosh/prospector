"use client";

/**
 * The run ledger (docs/UI-REWORK.md §1b, §1c, §2): one Trace, turn → tool call → verdict → evidence.
 * Renders the tree from trace-model.ts and never re-derives it from events.
 *
 * Shimmer rule (§3 M1): nothing in here shimmers. The single running line is the run header
 * (RunView.tsx); the model's in-flight "working" line is therefore not drawn a second time.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  Building2Icon,
  CheckIcon,
  CircleStopIcon,
  ClockIcon,
  FileTextIcon,
  FlagIcon,
  HistoryIcon,
  InfoIcon,
  LayersIcon,
  ListChecksIcon,
  RotateCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { RUN, TRACE } from "./copy";
import type { EvidenceDetail, TraceDetail, TraceIcon as IconName, TraceLine as Line, TraceTree, TraceTurn } from "./trace-model";

/* ---------- icons ---------- */

const ICONS: Record<IconName, LucideIcon> = {
  search: SearchIcon,
  building: Building2Icon,
  memory: HistoryIcon,
  file: FileTextIcon,
  check: CheckIcon,
  x: XIcon,
  list: ListChecksIcon,
  retry: RotateCwIcon,
  approval: ClockIcon,
  stop: CircleStopIcon,
  alert: TriangleAlertIcon,
  layers: LayersIcon,
  wrench: WrenchIcon,
  flag: FlagIcon,
  note: InfoIcon,
  clock: ClockIcon,
};

/** No state colours (DESIGN.md Ink States Rule): a pass is full ink, a turn-down is quieter, the words carry the state. */
const ICON_TONE: Partial<Record<IconName, string>> = {
  check: "pr-icon-strong",
  x: "pr-icon-quiet",
  approval: "pr-icon-strong",
  alert: "pr-icon-strong",
};

export function LineIcon({ name }: { name: IconName }) {
  const Icon = ICONS[name] ?? InfoIcon;
  return (
    <TraceIcon className={ICON_TONE[name]}>
      <Icon />
    </TraceIcon>
  );
}

/* ---------- evidence Code Block (§1c) ---------- */

const quoted = (q: string) => `“${q}”`;

type EvidenceRow = { label: string; quote?: string; note?: string; question?: string };

function evidenceRows(detail: EvidenceDetail): EvidenceRow[] {
  const gateByLabel = new Map(detail.gates.map((g) => [g.label, g]));
  const quoteByLabel = new Map(detail.quotes.map((q) => [q.label, q]));
  const standard = [TRACE.quoteLabels.whyNow, TRACE.quoteLabels.when, TRACE.quoteLabels.size, TRACE.quoteLabels.basedIn];
  const order = [...standard, ...detail.gates.map((g) => g.label)];
  const rows: EvidenceRow[] = [];
  for (const label of order) {
    if (!quoteByLabel.has(label) && !detail.missing.includes(label)) continue;
    const gate = gateByLabel.get(label);
    const quote = quoteByLabel.get(label)?.quote;
    rows.push({
      label: gate ? (gate.required ? RUN.mustBeTrue : RUN.niceToHave) : label,
      ...(quote ? { quote } : {}),
      ...(gate ? { question: label } : {}),
      ...(label === TRACE.quoteLabels.size && detail.size ? { note: RUN.sizeNote(detail.size.basis, detail.size.range, detail.size.inRange) || undefined } : {}),
    });
  }
  return rows;
}

/** Verbatim quotes in mono, labels in sans (DESIGN.md Verbatim Rule). A missing quote says so; nothing is synthesised. */
export function EvidenceBlock({ detail }: { detail: EvidenceDetail }) {
  const rows = evidenceRows(detail);
  const header = [TRACE.evidenceTitle, detail.source, detail.published ? TRACE.published(detail.published) : ""].filter(Boolean).join(" · ");
  const copyText = [
    `${detail.company}${detail.source ? ` (${detail.source})` : ""}`,
    ...rows.map((r) => `${r.question ? `${r.label} (${r.question})` : r.label}: ${r.quote ? quoted(r.quote) : TRACE.noQuote}`),
  ].join("\n");
  return (
    <CodeBlock size="sm" className="pr-evidence" data-testid="evidence">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-normal text-muted-foreground">{header}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={copyText} aria-label={RUN.copyEvidence} title={RUN.copyEvidence} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>
        {rows.map((r, i) => (
          <span key={i} className="pr-ev-row">
            <span className="pr-ev-label">{r.label}</span>
            <span className="pr-ev-value">
              {r.question && <span className="pr-ev-question">{r.question}</span>}
              {r.quote ? <span className="pr-ev-quote">{quoted(r.quote)}</span> : <span className="pr-ev-missing">{TRACE.noQuote}</span>}
              {r.note && <span className="pr-ev-note">{r.note}</span>}
            </span>
          </span>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/* ---------- one line ---------- */

function plain(markdown: string): string {
  return markdown.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`/g, "");
}

function DetailView({ detail }: { detail: TraceDetail }) {
  if (detail.kind === "evidence") return <EvidenceBlock detail={detail} />;
  if (detail.kind === "text") return <p className="pr-detail-text">{plain(detail.text)}</p>;
  // Raw detail, one click down (PRODUCT.md: plain sentence first).
  return (
    <CodeBlock size="sm" className="bg-[var(--bg)]">
      <CodeBlockContent wrap>{JSON.stringify(detail.value, null, 2)}</CodeBlockContent>
    </CodeBlock>
  );
}

/** "Searching: <query>": the query is what the agent sent to the tool, so it is mono (Verbatim Rule). */
function Title({ line }: { line: Line }) {
  const prefix = "Searching: ";
  if (line.kind === "search" && line.title.startsWith(prefix)) {
    return (
      <TraceTitle className="pr-trace-title">
        {prefix}
        <span className="pr-mono">{line.title.slice(prefix.length)}</span>
      </TraceTitle>
    );
  }
  return <TraceTitle className="pr-trace-title">{line.title}</TraceTitle>;
}

function Row({ line }: { line: Line }) {
  return (
    <TraceLine status={line.status === "error" ? "error" : undefined} className="pr-trace-line">
      <LineIcon name={line.icon} />
      <Title line={line} />
      {line.description && <TraceDescription className="pr-trace-desc">{line.description}</TraceDescription>}
    </TraceLine>
  );
}

export function LineView({ line }: { line: Line }) {
  const children = line.children ?? [];
  // Evidence is the verdict's own detail: open the verdict straight onto the Code Block.
  const evidence = children.length === 1 && children[0]!.detail?.kind === "evidence" ? children[0]!.detail : undefined;
  const detail = line.detail ?? evidence;
  const nested = evidence ? [] : children;
  // Keyed by kind as well: when an approval resolves in place ("You approved."), the line re-enters (M4 → M5).
  if (!detail && nested.length === 0) {
    return (
      <div className="pr-line-in" data-kind={line.kind}>
        <Row line={line} />
      </div>
    );
  }
  return (
    <TraceCollapsible className="pr-line-in" data-kind={line.kind}>
      <TraceCollapsibleTrigger className="pr-press">
        <Row line={line} />
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <div className="flex min-w-0 flex-col gap-2">
          {detail && <DetailView detail={detail} />}
          {nested.length > 0 && (
            <Trace className="gap-1.5">
              {nested.map((child) => (
                <LineView key={`${child.id}:${child.kind}`} line={child} />
              ))}
            </Trace>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/* ---------- turns ---------- */

function TurnView({ turn, open, onOpenChange }: { turn: TraceTurn; open: boolean; onOpenChange: (open: boolean) => void }) {
  const lines = turn.lines.filter((l) => l.kind !== "working");
  const header = (
    <TraceLine status={turn.status === "error" ? "error" : undefined} className="pr-trace-line pr-turn">
      <TraceTitle className="pr-trace-title font-medium text-foreground">{turn.title}</TraceTitle>
      {turn.description && <TraceDescription className="pr-trace-desc">{turn.description}</TraceDescription>}
    </TraceLine>
  );
  if (lines.length === 0) return <div className="pr-line-in">{header}</div>;
  return (
    <TraceCollapsible className="pr-line-in" open={open} onOpenChange={(next) => onOpenChange(next)}>
      <TraceCollapsibleTrigger className="pr-press">{header}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace className="gap-1.5">
          {lines.map((line) => (
            <LineView key={`${line.id}:${line.kind}`} line={line} />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function Turns({ turns, live }: { turns: TraceTurn[]; live: boolean }) {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  // A step that has only just started has nothing to show yet (the run header already says which step);
  // the latest step with content is the one held open.
  const shown = turns.filter((t) => t.description || t.lines.some((l) => l.kind !== "working"));
  const last = shown[shown.length - 1]?.turn;
  return (
    <Trace className="gap-2">
      {shown.map((t) => (
        <TurnView
          key={t.turn}
          turn={t}
          // Completed turns collapse to one line; only the running (or latest) one is open, unless the user chose.
          open={overrides[t.turn] ?? (live && t.turn === last)}
          onOpenChange={(open) => setOverrides((o) => ({ ...o, [t.turn]: open }))}
        />
      ))}
    </Trace>
  );
}

/* ---------- the panel ---------- */

/** While the run is live: a bounded scroller that follows the bottom until the user scrolls up. */
export function LiveTrace({ tree, stepping }: { tree: TraceTree; stepping: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const size = tree.turns.reduce((n, t) => n + t.lines.length + 1, 0);
  const completed = tree.turns.length > 1 ? tree.turns[tree.turns.length - 2] : undefined;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };
  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setFollow(true);
  };

  return (
    <section className="pr-ledger" aria-labelledby="trace-h">
      <h2 id="trace-h" className="pr-section-title">
        {RUN.activityHeading}
      </h2>
      {/* One polite announcement per new step: the step that just finished, with its summary. */}
      <p className="sr-only" aria-live="polite">
        {completed ? RUN.stepAnnounce(completed.title, completed.description) : ""}
      </p>
      {tree.turns.length === 0 ? (
        <p className="muted pr-ledger-empty">{RUN.noActivity(stepping)}</p>
      ) : (
        <div ref={scroller} className="pr-ledger-scroll" onScroll={onScroll} data-testid="trace-scroller">
          <Turns turns={tree.turns} live />
        </div>
      )}
      {!follow && (
        <button type="button" className="ghost-btn small pr-jump" onClick={jump}>
          <ArrowDownIcon aria-hidden="true" /> {RUN.jumpToLatest}
        </button>
      )}
    </section>
  );
}

/** After the run: the trace is provenance, collapsed one click below the results. */
export function ProvenanceTrace({ tree, spent }: { tree: TraceTree; spent: number }): ReactNode {
  if (tree.turns.length === 0) return null;
  return (
    <section className="pr-provenance" aria-label={RUN.provenance}>
      <TraceCollapsible>
        <TraceCollapsibleTrigger className="pr-press">
          <TraceLine className="pr-trace-line">
            <TraceTitle className="pr-trace-title pr-section-title">{RUN.provenance}</TraceTitle>
            <TraceDescription className="pr-trace-desc">{RUN.provenanceSummary(tree.turns.length, spent)}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className={cn("pr-provenance-body")}>
          <Turns turns={tree.turns} live={false} />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </section>
  );
}
