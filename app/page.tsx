"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../src/agent/events";
import type { CardSet } from "../src/planner/cards";
import { CardsStep, applyAlternative } from "./ui/CardsStep";
import { MemoryPanel } from "./ui/Memory";
import { RunView, type Decision } from "./ui/RunView";
import { allowanceLine, httpErrorMessage, screenedFrom, uniq, type AllowanceView, type HttpErrorKind, type Screened } from "./ui/copy";
import {
  countryList,
  joinWords,
  money,
  type ContractView,
  type SuggestionPatch,
} from "./ui/copy";
import { AlertIcon, ArrowUpRight, Close, Crosshair, Moon, Spinner, Sun } from "./ui/parts";
import {
  api,
  HttpError,
  withRateLimitRetry,
  type Feedback,
  type InstagramCandidate,
  type MemoryView,
  type PlanResult,
  type ProfileResponse,
  type RunSnapshot,
  type SellerProfile,
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryError, setMemoryError] = useState(false);

  const [step, setStep] = useState<Step>("start");

  // Step 1
  const [input, setInput] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [candidates, setCandidates] = useState<InstagramCandidate[] | null>(null);
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

  function toggleTheme() {
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    setDark(!dark);
  }

  /* ---------- step 1: profile ---------- */

  async function submitProfile(text: string, opts: { fromDescription?: boolean } = {}) {
    const value = text.trim();
    if (!value) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const res = await api<ProfileResponse>("/api/planner/profile", { body: { input: value } });
      if (res.kind === "instagram") {
        setCandidates(res.candidates);
        setAskDescription(false);
        setProfile(null);
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

  return (
    <div className="app">
      <aside className="rail">
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

        <MemoryPanel memory={memory} error={memoryError} onClear={clearMemory} onForget={forgetMemoryItem} disabled={runActive} />

        <div className="rail-foot">
          <button type="button" className="rail-link" onClick={() => setAboutOpen(true)}>
            About this build
          </button>
          <a className="rail-link" href="https://github.com/thereisjosh/prospector" target="_blank" rel="noopener noreferrer">
            View source <ArrowUpRight />
          </a>
        </div>
      </aside>

      <div className="stage">
        <header className="topbar">
          <div className="topbar-title">
            <h1 ref={headingRef} tabIndex={-1}>
              {step === "run" && finishedRun ? "Results" : meta.title}
            </h1>
            <p>{step === "run" && finishedRun ? "Leads with evidence, and what was turned down." : meta.sub}</p>
          </div>
          <div className="topbar-actions">
            {demo ? (
              <span className="live is-demo" title="No API keys needed: this replays a recorded agent run">
                <span className="live-dot" /> Demo: replaying a recorded run
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

        <main className="content">
          {step === "start" && (
            <StartStep
              demo={demo}
              input={input}
              setInput={setInput}
              busy={profileBusy}
              error={profileError}
              candidates={candidates}
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
              <div className="state" aria-live="polite">
                <Spinner />
                <p>Suggesting who to target…</p>
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
      </div>

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

/* ---------- step 1 ---------- */

function profileSentence(p: SellerProfile): string {
  const offering = p.offering?.trim().replace(/\.$/, "") ?? "something we couldn't pin down";
  const buyers = p.buyer_roles.length ? ` to ${joinWords(p.buyer_roles.slice(0, 3))}` : "";
  const where = p.geo_served.length ? ` in ${joinWords(p.geo_served.slice(0, 4))}` : "";
  return `We think you sell ${offering.charAt(0).toLowerCase()}${offering.slice(1)}${buyers}${where}.`;
}

function splitList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function StartStep(props: {
  demo: boolean;
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  error: string;
  candidates: InstagramCandidate[] | null;
  askDescription: boolean;
  description: string;
  setDescription: (v: string) => void;
  profile: SellerProfile | null;
  setProfile: (p: SellerProfile) => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onSubmit: () => void;
  onPickCandidate: (domain: string) => void;
  onDescribeInstead: () => void;
  onDescribe: () => void;
  onContinue: () => void;
}) {
  const { profile } = props;
  return (
    <div className="step narrow">
      <form
        className="search-field"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
      >
        <label htmlFor="seller-input" className="sr-only">
          Your website, Instagram handle, or one sentence about what you sell
        </label>
        <textarea
          id="seller-input"
          rows={2}
          spellCheck={false}
          placeholder="Your website, Instagram handle, or one sentence about what you sell"
          value={props.input}
          onChange={(e) => props.setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button type="submit" className="search-go" disabled={props.busy || !props.input.trim()}>
          {props.busy ? "Reading…" : "Continue"}
        </button>
      </form>
      <p className="hint">
        e.g. <i>acme-logistics.com</i>, <i>@acmecoffee</i>, or <i>We sell payment terminals to cafes in Singapore</i>
      </p>
      {props.demo && (
        <p className="demo-note">Demo mode replays one recorded seller, so any input leads to the same example.</p>
      )}

      {props.error && (
        <p className="inline-error" role="alert">{props.error}</p>
      )}

      {props.candidates && (
        <section className="panel" aria-labelledby="iyou-h">
          <h2 id="iyou-h" className="panel-title">Is this you?</h2>
          {props.candidates.length === 0 ? (
            <p className="muted">We couldn't find a website for that handle.</p>
          ) : (
            <ul className="candidates">
              {props.candidates.slice(0, 5).map((c) => (
                <li key={c.domain}>
                  <button type="button" className="candidate" disabled={props.busy} onClick={() => props.onPickCandidate(c.domain)}>
                    <span className="candidate-domain">{c.domain}</span>
                    <span className="muted small">Yes, this is our site</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link-btn" onClick={props.onDescribeInstead}>
            None of these. I'll describe it instead
          </button>
        </section>
      )}

      {props.askDescription && (
        <section className="panel" aria-labelledby="desc-h">
          <h2 id="desc-h" className="panel-title">Tell us in one sentence</h2>
          <p className="muted">What do you sell, and to whom?</p>
          <form
            className="row-form"
            onSubmit={(e) => {
              e.preventDefault();
              props.onDescribe();
            }}
          >
            <label htmlFor="desc-input" className="sr-only">What you sell, in one sentence</label>
            <input id="desc-input" className="input" value={props.description} placeholder="We sell … to …" onChange={(e) => props.setDescription(e.target.value)} />
            <button type="submit" className="primary-btn" disabled={props.busy || !props.description.trim()}>
              {props.busy ? "Reading…" : "Continue"}
            </button>
          </form>
        </section>
      )}

      {props.busy && !profile && (
        <div className="state slim" aria-live="polite">
          <Spinner />
          <p>Reading about your business…</p>
        </div>
      )}

      {profile && (
        <section className="panel profile" aria-labelledby="profile-h">
          <h2 id="profile-h" className="panel-title">Here's what we understood</h2>
          {props.editing ? (
            <div className="editor">
              <div className="field">
                <label htmlFor="p-offering">What you sell</label>
                <input id="p-offering" className="input" value={profile.offering ?? ""} onChange={(e) => props.setProfile({ ...profile, offering: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="p-buyers">Who buys it (comma separated)</label>
                <input id="p-buyers" className="input" defaultValue={profile.buyer_roles.join(", ")} onChange={(e) => props.setProfile({ ...profile, buyer_roles: splitList(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="p-geo">Where you sell (comma separated)</label>
                <input id="p-geo" className="input" defaultValue={profile.geo_served.join(", ")} onChange={(e) => props.setProfile({ ...profile, geo_served: splitList(e.target.value) })} />
              </div>
              <div className="actions">
                <button type="button" className="ghost-btn" onClick={() => props.setEditing(false)} disabled={!profile.offering?.trim()}>Done</button>
              </div>
            </div>
          ) : (
            <p className="profile-line">
              {profileSentence(profile)}{" "}
              <button type="button" className="link-btn" onClick={() => props.setEditing(true)}>Edit</button>
            </p>
          )}
          <div className="actions">
            <button type="button" className="primary-btn" onClick={props.onContinue} disabled={props.editing || !profile.offering?.trim()}>
              Suggest who to target
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------- step 3 ---------- */

function ContractStep(props: {
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
}) {
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
    <div className="step narrow">
      <section className="panel contract" aria-labelledby="contract-h">
        <h2 id="contract-h" className="sr-only">The plan</h2>
        <div className="contract-goal">
          <label htmlFor="target">Find</label>
          <input id="target" className="input num" type="number" min={1} max={50} value={props.targetLeads}
            onChange={(e) => props.setTargetLeads(Number(e.target.value))} aria-describedby="target-sub" />
          <span id="target-sub">companies that are</span>
        </div>
        <p className="contract-who">
          <b>{cards.who.descriptor}</b> <span className="muted">({cards.who.industry})</span>
        </p>
        <dl className="terms">
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
                <ul className="plain-list">{required.map((g) => <li key={g.key}>{question(g.question)}</li>)}</ul>
              </dd>
            </div>
          )}
          {optional.length > 0 && (
            <div>
              <dt>Nice to have</dt>
              <dd>
                <ul className="plain-list">{optional.map((g) => <li key={g.key}>{question(g.question)}</li>)}</ul>
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
        <details className="why">
          <summary>Starting search ideas</summary>
          <p className="muted small">The agent writes its own searches. These are ideas it may start from.</p>
          <ul className="plain-list quotes">{p.signalQueries.map((q) => <li key={q}>{q}</li>)}</ul>
        </details>
      </section>

      <section className="panel budget" aria-labelledby="budget-h">
        <h2 id="budget-h" className="panel-title">Budget</h2>
        <div className="budget-row">
          <label htmlFor="spend">Stop spending at</label>
          <span className="money-input">
            <span aria-hidden="true">$</span>
            <input id="spend" className="input num" type="number" min={0.1} max={5} step={0.25} value={props.maxSpend}
              onChange={(e) => props.setMaxSpend(Number(e.target.value))} />
          </span>
          <span className="muted">Estimated cost: about {money(plan.estimatedRunCost)}</span>
        </div>
        {!spendValid && <p className="inline-error">Choose a limit between $0.10 and $5.00.</p>}
        {!targetValid && <p className="inline-error">Ask for between 1 and 50 leads.</p>}
        {spendValid && overBudget && (
          <p className="note">The estimate is above your limit. The agent stops at the limit and tells you what it found.</p>
        )}
        {props.allowance && <p className="muted small" data-testid="allowance-line">{allowanceLine(props.allowance)}</p>}
        <p className="muted small">
          Before it spends anything, the agent shows you its opening plan for an OK. It also asks before changing any of the above.
        </p>
      </section>

      {props.demo && (
        <p className="demo-note">
          Demo: the run that follows is a recording, so changes here won't change it.
          {props.rememberedCount > 0 &&
            ` This workspace already remembers ${props.rememberedCount} compan${props.rememberedCount === 1 ? "y" : "ies"} from an earlier run, so the recording skips ${props.rememberedCount === 1 ? "it" : "them"}; clear memory to see the full run.`}
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

/* ---------- about ---------- */

function AboutDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="Close" autoFocus>
          <Close />
        </button>
        <h2 id="about-title">About this build</h2>
        <p>
          Prospector finds companies that are ready to buy what you sell, each backed by a recent, cited <b>why-now event</b>: a
          new facility, a funding round, a hiring wave.
        </p>
        <p>
          You approve the plan; an AI agent then searches, checks and decides on its own within it. It asks before it spends
          anything and before it changes your targeting. Every lead must pass checks written in code (date, size, location,
          exclusions), so the agent can't talk a bad lead into the results.
        </p>
        <p className="dialog-foot">
          Built AI-assisted; product, architecture and evaluation by Joshua Ang.{" "}
          <a href="https://github.com/thereisjosh/prospector" target="_blank" rel="noopener noreferrer">
            github.com/thereisjosh/prospector
          </a>
        </p>
      </div>
    </div>
  );
}
