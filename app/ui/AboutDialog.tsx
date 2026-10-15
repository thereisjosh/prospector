"use client";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Close } from "./parts";

/**
 * "About this build": a Base UI Dialog (focus trap, Escape closes, focus returns to the trigger).
 * The trigger is the rail link; motion is M10 (globals.css), radius 16px, scrim dims without blur.
 */
export function AboutDialog({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger className="rail-link">About this build</DialogTrigger>
      <DialogContent showCloseButton={false} aria-modal="true" className="pr-dialog">
        <DialogClose className="icon-btn pr-dialog-close" aria-label="Close">
          <Close />
        </DialogClose>
        <DialogTitle className="pr-dialog-title">About this build</DialogTitle>
        <DialogDescription className="pr-dialog-text">
          Prospector finds companies that are ready to buy what you sell, each backed by a recent, cited <b>why-now event</b>: a
          new facility, a funding round, a hiring wave.
        </DialogDescription>
        <p className="pr-dialog-text">
          You approve the plan; an AI agent then searches, checks and decides on its own within it. It asks before it spends
          anything and before it changes your targeting. Every lead must pass checks written in code (date, size, location,
          exclusions), so the agent can't talk a bad lead into the results.
        </p>
        <p className="pr-dialog-foot">
          Built AI-assisted; product, architecture and evaluation by Joshua Ang.{" "}
          <a href="https://github.com/thereisjosh/prospector" target="_blank" rel="noopener noreferrer">
            github.com/thereisjosh/prospector
          </a>
        </p>
      </DialogContent>
    </Dialog>
  );
}
