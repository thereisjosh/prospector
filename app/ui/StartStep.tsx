"use client";

import { useState } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Trace, TraceLine, TraceTitle } from "@/components/ui/trace";
import { joinWords } from "./copy";
import { Crosshair, Suggestion } from "./parts";
import type { InstagramCandidate, SellerProfile } from "./types";

const DEMO_LINE = "Demo mode replays one recorded seller, so any input leads to the same example.";

export const DESCRIBE_PLACEHOLDER = "Your website, Instagram handle, or one sentence about what you sell";

export function profileSentence(p: SellerProfile): string {
  const offering = p.offering?.trim().replace(/\.$/, "") ?? "something we couldn't pin down";
  const buyers = p.buyer_roles.length ? ` to ${joinWords(p.buyer_roles.slice(0, 3))}` : "";
  const where = p.geo_served.length ? ` in ${joinWords(p.geo_served.slice(0, 4))}` : "";
  return `We think you sell ${offering.charAt(0).toLowerCase()}${offering.slice(1)}${buyers}${where}.`;
}

function splitList(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

export type StartStepProps = {
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
};

/**
 * Describe: one exchange with the agent. The Prompt Input collapses into the user's Bubble once it is
 * submitted; the agent's reading (or its question back) is the Message below. "Change" reopens the input.
 */
export function StartStep(props: StartStepProps) {
  const { profile } = props;
  const [reopened, setReopened] = useState(false);
  const started = props.busy || !!profile || !!props.candidates || props.askDescription;
  const showInput = !started || reopened;
  const submit = () => {
    if (!props.input.trim() || props.busy) return;
    setReopened(false);
    props.onSubmit();
  };

  return (
    <div className="step narrow pr-describe">
      {showInput ? (
        <div className="pr-prompt-block">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="seller-input" className="sr-only">
              {DESCRIBE_PLACEHOLDER}
            </label>
            <InputGroup className="pr-prompt">
              <InputGroupTextarea
                id="seller-input"
                rows={2}
                spellCheck={false}
                placeholder={DESCRIBE_PLACEHOLDER}
                value={props.input}
                onChange={(e) => props.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <InputGroupAddon align="block-end" className="pr-prompt-foot">
                <InputGroupButton type="submit" variant="default" className="pr-prompt-go pr-press" disabled={props.busy || !props.input.trim()}>
                  {props.busy ? "Reading…" : "Continue"}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
          <p className="pr-hint">
            e.g. <i>acme-logistics.com</i>, <i>@acmecoffee</i>, or <i>We sell payment terminals to cafes in Singapore</i>
          </p>
          {props.demo && <p className="pr-demo-line">{DEMO_LINE}</p>}
        </div>
      ) : (
        <Message align="end" className="pr-you">
          <MessageContent>
            <Bubble variant="secondary" align="end" className="pr-bubble">
              <BubbleContent>{props.input}</BubbleContent>
            </Bubble>
          </MessageContent>
          <MessageFooter className="pr-you-foot">
            <button type="button" className="link-btn" onClick={() => setReopened(true)} disabled={props.busy}>
              Change
            </button>
          </MessageFooter>
        </Message>
      )}


      {props.error && (
        <p className="inline-error" role="alert">{props.error}</p>
      )}

      {started && (
        <Message className="pr-agent">
          <span className="pr-agent-mark" aria-hidden="true">
            <Crosshair />
          </span>
          <MessageContent className="pr-agent-body">
            {props.candidates && (
              <section aria-labelledby="iyou-h" className="pr-agent-part">
                <h2 id="iyou-h" className="pr-msg-title">Is this you?</h2>
                {props.candidates.length === 0 ? (
                  <p className="pr-msg-text">We couldn't find a website for that handle.</p>
                ) : (
                  <div className="pr-suggestions" role="group" aria-labelledby="iyou-h">
                    {props.candidates.slice(0, 5).map((c) => (
                      <Suggestion key={c.domain} disabled={props.busy} onClick={() => props.onPickCandidate(c.domain)}>
                        {c.domain}
                      </Suggestion>
                    ))}
                  </div>
                )}
                <button type="button" className="link-btn" onClick={props.onDescribeInstead}>
                  None of these. I'll describe it instead
                </button>
              </section>
            )}

            {props.askDescription && (
              <section aria-labelledby="desc-h" className="pr-agent-part">
                <h2 id="desc-h" className="pr-msg-title">Tell us in one sentence</h2>
                <p className="pr-msg-text">What do you sell, and to whom?</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    props.onDescribe();
                  }}
                >
                  <label htmlFor="desc-input" className="sr-only">What you sell, in one sentence</label>
                  <InputGroup className="pr-prompt pr-prompt-line">
                    <InputGroupInput id="desc-input" value={props.description} placeholder="We sell … to …" onChange={(e) => props.setDescription(e.target.value)} />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton type="submit" variant="default" className="pr-prompt-go pr-press" disabled={props.busy || !props.description.trim()}>
                        {props.busy ? "Reading…" : "Continue"}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </form>
              </section>
            )}

            {props.busy && !profile && (
              <div aria-live="polite" className="pr-agent-part">
                <Trace>
                  <TraceLine status="running" className="pr-trace-line pr-reading">
                    <TraceTitle>Reading about your business…</TraceTitle>
                  </TraceLine>
                </Trace>
              </div>
            )}

            {profile && (
              <section aria-labelledby="profile-h" className="pr-agent-part">
                <h2 id="profile-h" className="pr-msg-title">Here's what we understood</h2>
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
                  <p className="pr-profile-line">
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
          </MessageContent>
        </Message>
      )}

      {props.demo && !showInput && <p className="pr-demo-line">{DEMO_LINE}</p>}
    </div>
  );
}
