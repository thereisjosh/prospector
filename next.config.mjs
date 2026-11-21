/** @type {import('next').NextConfig} */
const nextConfig = {
  // PostHog (US) behind a same-origin proxy so ad blockers don't drop events. The proxy needs the
  // trailing-slash redirect off, and the asset rules (static, array) must come before the catch-all.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: "/ingest/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/ingest/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  experimental: {
    // Demo mode reads recorded fixtures from eval/demo at request time; make
    // sure they are bundled with every API route on serverless deployments.
    outputFileTracingIncludes: {
      "/api/**/*": ["./eval/demo/**/*"],
    },
  },
};

export default nextConfig;
