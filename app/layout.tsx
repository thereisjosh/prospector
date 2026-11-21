import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AnalyticsProvider } from "./ui/AnalyticsProvider";

export const metadata: Metadata = {
  title: "Prospector",
  description: "Signal-first B2B prospecting on the Exa Search API.",
};

// Rendered per request so NEXT_PUBLIC_POSTHOG_KEY is read at runtime (Railway), not baked in at build.
export const dynamic = "force-dynamic";

// A variable name, so the bundler cannot inline the build-time value.
const POSTHOG_KEY_VAR = "NEXT_PUBLIC_POSTHOG_KEY";

export default function RootLayout({ children }: { children: ReactNode }) {
  const beaconToken = process.env.NEXT_PUBLIC_CF_BEACON_TOKEN;
  const posthogKey = process.env[POSTHOG_KEY_VAR]?.trim();
  return (
    <html lang="en">
      <head>
        {/* Satoshi from Fontshare (DESIGN.md §3); General Sans / Inter / system fall back while it loads. */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap" />
        {beaconToken && <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon={JSON.stringify({ token: beaconToken })} />}
      </head>
      <body>{posthogKey ? <AnalyticsProvider posthogKey={posthogKey}>{children}</AnalyticsProvider> : children}</body>
    </html>
  );
}
