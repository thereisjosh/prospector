"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useState } from "react";
import { MEMORY_COPY, seenWhen, shortDate } from "./copy";
import type { MemoryView } from "./types";

type Props = {
  memory: MemoryView | null;
  error: boolean;
  onClear: () => void;
  /** Forget one item (a seen company, a piece of feedback, a note) by its id. */
  onForget: (itemId: string) => void;
  disabled: boolean;
};

function Forget({ what, id, onForget, disabled }: { what: string; id: string; onForget: (id: string) => void; disabled: boolean }) {
  return (
    <button type="button" className="memory-forget" aria-label={MEMORY_COPY.forget(what)} title={MEMORY_COPY.forget(what)} disabled={disabled} onClick={() => onForget(id)}>
      ×
    </button>
  );
}

/** The rail's "What I remember": what the agent keeps between runs, where each item came from, and a way to drop any of it. */
export function MemoryPanel({ memory, error, onClear, onForget, disabled }: Props) {
  const [confirming, setConfirming] = useState(false);
  const empty = memory && memory.seen.length === 0 && memory.preferences.length === 0 && memory.notes.length === 0;
  return (
    <details className="memory">
      <summary>What I remember</summary>
      {error ? (
        <p className="memory-text">Couldn't load memory.</p>
      ) : !memory ? (
        <p className="memory-text">Loading…</p>
      ) : empty ? (
        <p className="memory-text">{MEMORY_COPY.empty}</p>
      ) : (
        <>
          {memory.seen.length > 0 && (
            <section className="memory-group" aria-label={MEMORY_COPY.seenHeading}>
              <h3>{MEMORY_COPY.seenHeading}</h3>
              <p className="memory-text">
                <b>{memory.seenCount}</b> compan{memory.seenCount === 1 ? "y" : "ies"} already seen. Future runs skip them.
              </p>
              <ul className="memory-list">
                {memory.seen.map((item) => (
                  <li key={item.id} className="memory-item">
                    <span className="memory-item-body">
                      <span className="memory-name">{item.name}</span>
                      <span className="memory-meta">{seenWhen(item)}</span>
                    </span>
                    <Forget what={item.name} id={item.id} onForget={onForget} disabled={disabled} />
                  </li>
                ))}
              </ul>
              {memory.seenCount > memory.seen.length && <p className="memory-meta">{MEMORY_COPY.latestOnly(memory.seen.length, memory.seenCount)}</p>}
            </section>
          )}

          {memory.preferences.length > 0 && (
            <section className="memory-group" aria-label={MEMORY_COPY.feedbackHeading}>
              <h3>{MEMORY_COPY.feedbackHeading}</h3>
              <ul className="memory-list">
                {memory.preferences.map((item) => (
                  <li key={item.id} className="memory-item">
                    <span className="memory-item-body">
                      <span className="memory-name">{item.company}</span>
                      <span className="memory-meta">
                        {item.verdict === "up" ? "Liked" : "Rejected"}
                        {shortDate(item.at) ? ` ${shortDate(item.at)}` : ""}
                      </span>
                      {item.reason && <span className="memory-reason">{item.reason}</span>}
                    </span>
                    <Forget what={`your feedback on ${item.company}`} id={item.id} onForget={onForget} disabled={disabled} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {memory.notes.length > 0 && (
            <section className="memory-group" aria-label={MEMORY_COPY.learnedHeading}>
              <h3>{MEMORY_COPY.learnedHeading}</h3>
              <ul className="memory-list">
                {memory.notes.map((item) => (
                  <li key={item.id} className="memory-item">
                    <span className="memory-item-body">
                      <span className="memory-reason">{item.text}</span>
                      <span className="memory-meta">
                        {shortDate(item.at)} · {MEMORY_COPY.expires(item.expiresAt)}
                      </span>
                    </span>
                    <Forget what="this note" id={item.id} onForget={onForget} disabled={disabled} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {confirming ? (
            <div className="memory-confirm">
              <span>Forget everything?</span>
              <button type="button" className="rail-btn danger" onClick={() => { setConfirming(false); onClear(); }}>Clear</button>
              <button type="button" className="rail-btn" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="rail-btn" disabled={disabled} onClick={() => setConfirming(true)}>Clear memory</button>
          )}
        </>
      )}
    </details>
  );
}
