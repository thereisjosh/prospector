"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Trace, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { AgentEvent } from "../src/agent/events";
import type { CardSet } from "../src/planner/cards";
import { AboutDialog } from "./ui/AboutDialog";
import { CardsStep, applyAlternative } from "./ui/CardsStep";
import { ContractStep } from "./ui/ContractStep";
import { MemoryPanel, type LastRun } from "./ui/Memory";
import { RunView, type Decision } from "./ui/RunView";
import { StartStep } from "./ui/StartStep";
import { allowanceLine, DESCRIBE_COPY, httpErrorMessage, screenedFrom, uniq, type AllowanceView, type HttpErrorKind, type Screened } from "./ui/copy";
import { type ContractView, type SuggestionPatch } from "./ui/copy";
import { AlertIcon, ArrowUpRight, Crosshair, Moon, Sun } from "./ui/parts";
import {
  api,
  HttpError,
  withRateLimitRetry,
  type Feedback,
  type CandidateSource,
  type MemoryView,
  type PlanResult,
  type ProfileResponse,
  type RunSnapshot,
  type SellerProfile,
  type SiteCandidate,
  type StepResponse,
} from "./ui/types";

type Step = "start" | "cards" | "contract" | "run";

const STEPS: Array<{ id: Step; label: string; title: string; sub: string }> = [
  { id: "start", label: "Describe", title: "What do you sell?", sub: "One line is enough. We'll work out who to look for." },
  { id: "cards", label: "Target", title: "Who should we look for?", sub: "Suggested from what you sell. Change anything." },
  { id: "contract", label: "Approve", title: "Approve the plan", sub: "This is what the agent is allowed to do." },
  { id: "run", label: "Run", title: "Finding leads", sub: "Live view of the agent's work." },
];

const DEMO_INPUT = "We sell labor-scheduling software to mid-sized 3PL warehouses in the US and UK";
const STEP_PAUSE_MS = 400;
const WS_KEY = "prospector.workspaceId";

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function readWorkspaceId(): string {
  try {
    const existing = localStorage.getItem(WS_KEY);
    if (existing && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) return existing;
    const id = newId();
    localStorage.setItem(WS_KEY, id);
    return id;
  } catch {
    return newId();
  }
}

type Caps = { visitorRuns: number; visitorDollars: number };
type StatusResponse = { visitor?: AllowanceView; caps?: Caps };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Page() {
  const [demo, setDemo] = useState(false);
  const [dark, setDark] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryError, setMemoryError] = useState(false);

  const [step, setStep] = useState<Step>("start");

  // Step 1
  const [input, setInput] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [candidates, setCandidates] = useState<SiteCandidate[] | null>(null);
  const [candidateSource, setCandidateSource] = useState<CandidateSource | null>(null);
  const [askName, setAskName] = useState(false);
  const [askDescription, setAskDescription] = useState(false);
  const [description, setDescription] = useState("");
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);

  // Step 2
  const [baseCards, setBaseCards] = useState<CardSet | null>(null);
  const [cards, setCards] = useState<CardSet | null>(null);
  const [activeAlt, setActiveAlt] = useState(-1);
  const [cardsBusy, setCardsBusy] = useState(false);
  const [cardsError, setCardsError] = useState("");

  // Step 3
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState("");
  const [targetLeads, setTargetLeads] = useState(10);
  const [maxSpend, setMaxSpend] = useState(1);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Step 4
  const [runId, setRunId] = useState("");
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<AgentEvent[]>([]);
  const [screened, setScreened] = useState<Screened>({ skipped: [], lookedUp: [] });
  const [stepping, setStepping] = useState(false);
  const [pausedByUser, setPausedByUser] = useState(false);
  const [runError, setRunError] = useState("");
  const [visitor, setVisitor] = useState<AllowanceView | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});
  const [applying, setApplying] = useState(false);

  const stopRef = useRef(false);
  const loopRef = useRef(false);
  const contractRef = useRef<ContractView | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /* ---------- boot ---------- */

  useEffect(() => {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setDark(current === "dark");
    setWorkspaceId(readWorkspaceId());
    api<{ demo: boolean }>("/api/mode")
      .then((m) => {
        setDemo(m.demo);
        if (m.demo) setInput((v) => v || DEMO_INPUT);
      })
      .catch(() => undefined);
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshMemory = useCallback(async (id: string) => {
    if (!id) return;
    try {
      setMemory(await api<MemoryView>(`/api/workspaces/${encodeURIComponent(id)}/memory`));
      setMemoryError(false);
    } catch {
      setMemoryError(true);
    }
  }, []);

  useEffect(() => {
    void refreshMemory(workspaceId);
  }, [workspaceId, refreshMemory]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, [step]);

  async function refreshStatus() {
    try {
      const s = await api<StatusResponse>("/api/status");
      if (s.visitor) setVisitor(s.visitor);
      if (s.caps) setCaps(s.caps);
    } catch {
      // the allowance line is informational; the routes enforce it
    }
  }

  /** Specific copy for 402/503/429; otherwise the caller's generic text. */
  function errorCopy(error: unknown, where: HttpErrorKind, generic: string): string {
    if (error instanceof HttpError) {
      // Run creation can also 402 on dollars alone (runs left, money gone): say so.
      const dollarsOnly = where === "run" && visitor !== null && visitor.remainingRuns > 0 && visitor.remainingDollars <= 0;
      return httpErrorMessage(error.status, dollarsOnly ? "planner" : where, { code: error.code, limitDollars: caps?.visitorDollars, runLimit: caps?.visitorRuns }) ?? generic;
    }
    return generic;
  }

  /** M11: a root crossfade (View Transitions) so the theme never jumps in brightness; instant under reduced motion. */
  function toggleTheme() {
    const next = dark ? "light" : "dark";
    const apply = () => {
      document.documentElement.setAttribute("data-theme", next);
      flushSync(() => setDark(next === "dark"));
    };
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof doc.startViewTransition !== "function") apply();
    else doc.startViewTransition(apply);
  }

  /* ---------- step 1: profile ---------- */

  async function submitProfile(text: string, opts: { fromDescription?: boolean; asName?: boolean } = {}) {
    const value = text.trim();
    if (!value) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const res = await api<ProfileResponse>("/api/planner/profile", { body: { input: value, ...(opts.asName ? { asName: true } : {}) } });
      setAskName(false);
      if (res.kind === "candidates" || res.kind === "instagram") {
        setCandidates(res.candidates);
        setCandidateSource(res.kind === "instagram" ? { source: "social", platform: "instagram" } : { source: res.source, platform: res.platform });
        setAskName(res.kind === "candidates" && res.askName === true);
        setAskDescription(false);
        setProfile(null);
      } else if (res.kind === "unusable") {
        setCandidates(null);
        setAskDescription(true);
        setProfile(null);
        setProfileError(DESCRIBE_COPY.unusable[res.reason] ?? DESCRIBE_COPY.unusable.contact_link!);
      } else if (res.needsDescription) {
        setCandidates(null);
        setAskDescription(true);
        setProfile(null);
      } else {
        const origin = opts.fromDescription ? profile?.origin : undefined;
        setProfile(origin ? { ...res.profile, origin } : res.profile);
        setCandidates(null);
        setAskDescription(false);
        setEditingProfile(false);
      }
    } catch (error) {
      setProfileError(errorCopy(error, "planner", "We couldn't read that just now. Check the address, or describe what you sell in one sentence."));
    } finally {
      setProfileBusy(false);
    }
  }

  async function loadCards() {
    if (!profile) return;
    setStep("cards");
    setCardsBusy(true);
    setCardsError("");
    setBaseCards(null);
    setCards(null);
    try {
      const res = await api<{ cards: CardSet }>("/api/planner/cards", { body: { profile } });
      setBaseCards(res.cards);
      setCards(res.cards);
      setActiveAlt(-1);
      setPlan(null);
    } catch (error) {
      setCardsError(errorCopy(error, "planner", "We couldn't suggest targeting right now."));
    } finally {
      setCardsBusy(false);
    }
  }

  function pickAlternative(index: number) {
    if (!baseCards) return;
    setActiveAlt(index);
    setCards(index === -1 ? baseCards : applyAlternative(baseCards, baseCards.alternatives[index]?.cards ?? {}));
  }

  /* ---------- step 3: plan ---------- */

  async function buildPlan(from: CardSet) {
    setPlanBusy(true);
    setPlanError("");
    try {
      const res = await api<PlanResult>("/api/planner/plan", { body: { cards: from } });
      setPlan(res);
      setStep("contract");
      return true;
    } catch (error) {
      setPlanError(errorCopy(error, "planner", "We couldn't turn these cards into a plan. Try again, or loosen a card."));
      return false;
    } finally {
      setPlanBusy(false);
    }
  }

  /* ---------- step 4: run loop ---------- */

  const pushEvents = useCallback((events: AgentEvent[]) => {
    // The run view renders its ledger from the raw events (app/ui/trace-model.ts).
    if (events.length) setRunEvents((e) => [...e, ...events]);
    const add = screenedFrom(events);
    if (add.skipped.length || add.lookedUp.length) {
      setScreened((s) => ({ skipped: uniq([...s.skipped, ...add.skipped]), lookedUp: uniq([...s.lookedUp, ...add.lookedUp]) }));
    }
  }, []);

  const refreshSnapshot = useCallback(async (id: string) => {
    const snap = await withRateLimitRetry(() => api<RunSnapshot>(`/api/runs/${encodeURIComponent(id)}`));
    contractRef.current = snap.contract;
    setSnapshot(snap);
    return snap;
  }, []);

  const runLoop = useCallback(
    async (id: string) => {
      if (loopRef.current) return;
      loopRef.current = true;
      stopRef.current = false;
      setStepping(true);
      setPausedByUser(false);
      setRunError("");
      let finished = false;
      try {
        if (!contractRef.current) await refreshSnapshot(id);
        while (!stopRef.current) {
          const res = await withRateLimitRetry(() => api<StepResponse>(`/api/runs/${encodeURIComponent(id)}/step`, { body: {} }));
          pushEvents(res.events);
          const snap = await refreshSnapshot(id);
          if (snap.status !== "running") {
            finished = snap.status !== "awaiting_approval";
            break;
          }
          await sleep(STEP_PAUSE_MS);
        }
        if (stopRef.current) setPausedByUser(true);
      } catch {
        setRunError("Lost contact with the agent. Your results so far are safe.");
      } finally {
        loopRef.current = false;
        setStepping(false);
        if (finished) void refreshMemory(workspaceId);
      }
    },
    [pushEvents, refreshSnapshot, refreshMemory, workspaceId],
  );

  async function startRun() {
    if (!plan) return;
    setCreating(true);
    setCreateError("");
    try {
      const res = await api<{ id: string }>("/api/runs", {
        body: { plan: plan.plan, workspaceId, targetLeads, maxCostDollars: maxSpend },
      });
      setRunId(res.id);
      setSnapshot(null);
      setRunEvents([]);
      setScreened({ skipped: [], lookedUp: [] });
      setFeedback({});
      contractRef.current = undefined;
      setStep("run");
      void runLoop(res.id);
    } catch (error) {
      setCreateError(errorCopy(error, "run", "The agent couldn't start. Try again in a moment."));
      void refreshStatus();
    } finally {
      setCreating(false);
    }
  }

  async function decide(decision: Decision) {
    if (!runId) return;
    setDeciding(true);
    setDecisionError("");
    try {
      // The decision route binds the answer to the specific pending request.
      const toolUseId = snapshot?.pendingApproval?.toolUseId;
      const res = await api<StepResponse>(`/api/runs/${encodeURIComponent(runId)}/decision`, { body: { ...decision, toolUseId } });
      pushEvents(res.events);
      await refreshSnapshot(runId);
      void runLoop(runId);
    } catch {
      setDecisionError("That didn't go through. Try again.");
    } finally {
      setDeciding(false);
    }
  }

  async function sendFeedback(company: string, next: Feedback, send: boolean) {
    setFeedback((f) => ({ ...f, [company]: { ...next, error: false } }));
    if (!send || !next.verdict) return;
    setFeedback((f) => ({ ...f, [company]: { ...next, sending: true } }));
    const lead = snapshot?.leads.find((l) => l.company === company);
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/feedback`, {
        body: {
          company,
          verdict: next.verdict,
          reason: next.reason?.trim() || undefined,
          // Ties the vote to the lead's trace (user_feedback score); omitted for demo runs.
          ...(lead && runId && !runId.startsWith("demo-") ? { runId, signal_url: lead.signal_url } : {}),
        },
      });
      setFeedback((f) => ({ ...f, [company]: { ...next, sending: false, sent: true, open: false } }));
      void refreshMemory(workspaceId);
    } catch {
      setFeedback((f) => ({ ...f, [company]: { ...next, sending: false, error: true } }));
    }
  }

  async function applySuggestion(patch: SuggestionPatch) {
    setApplying(true);
    setCards(patch.cards);
    if (patch.maxCost !== undefined) setMaxSpend(Math.min(5, patch.maxCost));
    const ok = await buildPlan(patch.cards);
    setApplying(false);
    if (!ok) setStep("cards");
  }

  function newSearch() {
    stopRef.current = true;
    setStep("start");
    setProfile(null);
    setCandidates(null);
    setAskDescription(false);
    setCards(null);
    setBaseCards(null);
    setPlan(null);
    setRunId("");
    setSnapshot(null);
    setRunEvents([]);
    setScreened({ skipped: [], lookedUp: [] });
    setInput(demo ? DEMO_INPUT : "");
  }

  async function clearMemory() {
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory`, { method: "DELETE" });
      await refreshMemory(workspaceId);
    } catch {
      setMemoryError(true);
    }
  }

  async function forgetMemoryItem(itemId: string) {
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/memory/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
      await refreshMemory(workspaceId);
    } catch {
      setMemoryError(true);
    }
  }

  /* ---------- render ---------- */

  const runActive = step === "run" && (stepping || snapshot?.status === "running" || snapshot?.status === "awaiting_approval") && !pausedByUser;
  const reached: Record<Step, boolean> = {
    start: true,
    cards: !!cards,
    contract: !!plan,
    run: !!runId,
  };
  const meta = STEPS.find((s) => s.id === step)!;
  const finishedRun = snapshot && ["done", "stopped", "error"].includes(snapshot.status);
  // The memory panel says why a budget-stopped run left no note (the agent's `remember` nudge never ran).
  const lastRun: LastRun | undefined = finishedRun
    ? { stopReason: snapshot.stopReason, selfNotes: runEvents.filter((e) => e.kind === "tool_call" && e.tool === "remember" && e.is_error !== true).length }
    : undefined;

  const resultsHead = step === "run" && !!finishedRun;

  return (
    <div className="app">
      <header className="nav">
        <div className="brand">
          <Crosshair />
          <span>Prospector</span>
        </div>

        <nav className="steps" aria-label="Steps">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`step-link ${step === s.id ? "is-active" : ""}`}
                  aria-current={step === s.id ? "step" : undefined}
                  disabled={!reached[s.id] || runActive || step === s.id}
                  onClick={() => setStep(s.id)}
                >
                  <span className="step-num">{i + 1}</span>
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="nav-actions">
          {demo ? (
            <span className="live is-demo" title="No API keys needed: this replays a recorded agent run">
              <span className="live-dot" />
              <span>
                Demo<span className="live-more">: replaying a recorded run</span>
              </span>
            </span>
          ) : (
            <span className="live">
              <span className="live-dot" /> Live
            </span>
          )}
          <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
            {dark ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      {/* Cross-run memory: one full-width row under the nav, on every step (DESIGN.md §4). */}
      <div className="memory-row">
        <MemoryPanel memory={memory} error={memoryError} onClear={clearMemory} onForget={forgetMemoryItem} disabled={runActive} lastRun={lastRun} />
      </div>

      <main className="content" data-step={step}>
        <header className={resultsHead ? "page-head is-results" : "page-head"}>
          <h1 ref={headingRef} tabIndex={-1}>
            {resultsHead ? "Results" : meta.title}
          </h1>
          <p>{resultsHead ? "Leads with evidence, and what was turned down." : meta.sub}</p>
        </header>

        {step === "start" && (
          <StartStep
            demo={demo}
            input={input}
            setInput={setInput}
            busy={profileBusy}
            error={profileError}
            candidates={candidates}
            candidateSource={candidateSource}
            askName={askName}
            onSubmitName={(name) => submitProfile(name, { asName: true })}
            askDescription={askDescription}
            description={description}
            setDescription={setDescription}
            profile={profile}
            setProfile={setProfile}
            editing={editingProfile}
            setEditing={setEditingProfile}
            onSubmit={() => submitProfile(input)}
            onPickCandidate={(domain) => submitProfile(domain)}
            onDescribeInstead={() => {
              setCandidates(null);
              setAskDescription(true);
            }}
            onDescribe={() => submitProfile(description, { fromDescription: true })}
            onContinue={loadCards}
          />
        )}

        {step === "cards" &&
          (cards && baseCards ? (
            <CardsStep
              cards={cards}
              base={baseCards}
              activeAlt={activeAlt}
              onPickAlt={pickAlternative}
              onChange={(c) => {
                setCards(c);
                setPlan(null);
              }}
              onContinue={() => void buildPlan(cards)}
              onBack={() => setStep("start")}
              busy={planBusy}
              error={planError}
            />
          ) : cardsBusy ? (
            <div className="step pr-pending" aria-live="polite">
              <Trace>
                <TraceLine status="running" className="pr-trace-line pr-reading">
                  <TraceTitle>Suggesting who to target…</TraceTitle>
                </TraceLine>
              </Trace>
            </div>
          ) : (
            <div className="state state-error" role="alert">
              <AlertIcon />
              <p>{cardsError || "Nothing to show yet."}</p>
              <div className="actions center">
                <button type="button" className="ghost-btn" onClick={() => setStep("start")}>Back</button>
                {profile && <button type="button" className="primary-btn" onClick={() => void loadCards()}>Try again</button>}
              </div>
            </div>
          ))}

        {step === "contract" && plan && cards && (
          <ContractStep
            demo={demo}
            cards={cards}
            plan={plan}
            targetLeads={targetLeads}
            setTargetLeads={setTargetLeads}
            maxSpend={maxSpend}
            setMaxSpend={setMaxSpend}
            busy={creating}
            error={createError}
            allowance={visitor}
            rememberedCount={memory?.seenCount ?? 0}
            onRun={startRun}
            onBack={() => setStep("cards")}
          />
        )}

        {step === "run" && (
          <RunView
            demo={demo}
            snapshot={snapshot}
            events={runEvents}
            screened={screened}
            stepping={stepping}
            pausedByUser={pausedByUser}
            runError={runError}
            deciding={deciding}
            decisionError={decisionError}
            onStop={() => {
              stopRef.current = true;
            }}
            onResume={() => runId && void runLoop(runId)}
            onDecide={decide}
            feedback={feedback}
            onFeedback={sendFeedback}
            cards={cards}
            maxSpend={maxSpend}
            onApply={applySuggestion}
            applying={applying || planBusy}
            onEditTargeting={() => setStep("cards")}
            onNewSearch={newSearch}
          />
        )}
      </main>

      <footer className="foot">
        <AboutDialog />
        <a className="rail-link" href="https://github.com/thereisjosh/prospector" target="_blank" rel="noopener noreferrer">
          View source <ArrowUpRight />
        </a>
      </footer>
    </div>
  );
}
