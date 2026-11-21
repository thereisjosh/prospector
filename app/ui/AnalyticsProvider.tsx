"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { initAnalytics } from "../analytics";

const AnalyticsOn = createContext(false);

/** True under the provider, which app/layout.tsx mounts only when a PostHog key is configured. */
export function useAnalyticsOn(): boolean {
  return useContext(AnalyticsOn);
}

/** Starts PostHog once with the runtime key the server layout passes down; renders children unchanged. */
export function AnalyticsProvider({ posthogKey, children }: { posthogKey: string; children: ReactNode }) {
  useEffect(() => {
    void initAnalytics(posthogKey);
  }, [posthogKey]);
  return <AnalyticsOn.Provider value={true}>{children}</AnalyticsOn.Provider>;
}
