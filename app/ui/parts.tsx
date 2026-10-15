/** @jsxRuntime automatic */
/** @jsxImportSource react */

import type { ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

/* ---------- Suggestion: a one-click answer (docs/UI-REWORK.md §1a) ---------- */

/**
 * A pill button that answers a question in one click: an Instagram site candidate, a targeting angle.
 * shadcn ships no Suggestion in the registry, so this is the AI Elements shape on our Button.
 * Pass `aria-pressed` when it is one of a set (the angle row); the pressed one takes the selected chip style.
 */
export function Suggestion({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" variant="outline" size="sm" className={cn("pr-suggestion pr-press", className)} {...props} />;
}

/* ---------- icons ---------- */

export function Crosshair() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="6.25" />
      <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" strokeLinecap="round" />
      <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ArrowUpRight() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Moon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M15 10.2A6.2 6.2 0 1 1 7.8 3a4.8 4.8 0 0 0 7.2 7.2Z" strokeLinejoin="round" />
    </svg>
  );
}

export function Sun() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="9" cy="9" r="3.4" />
      <path
        d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.6 3.6l1.4 1.4M13 13l1.4 1.4M14.4 3.6 13 5M5 13l-1.4 1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Close() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" strokeLinecap="round" />
    </svg>
  );
}

export function ThumbUp() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M5 7v6.5H2.5V7H5Zm0 0 2.6-4.6c.3-.5.9-.7 1.4-.4.5.3.7.8.6 1.3L9.1 6h3.4c.8 0 1.4.7 1.3 1.5l-.7 4.6c-.1.8-.8 1.4-1.6 1.4H5"
        strokeLinejoin="round" />
    </svg>
  );
}

export function ThumbDown() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M11 9V2.5h2.5V9H11Zm0 0-2.6 4.6c-.3.5-.9.7-1.4.4-.5-.3-.7-.8-.6-1.3L6.9 10H3.5c-.8 0-1.4-.7-1.3-1.5l.7-4.6c.1-.8.8-1.4 1.6-1.4H11"
        strokeLinejoin="round" />
    </svg>
  );
}

export function Download() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13.2h10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
