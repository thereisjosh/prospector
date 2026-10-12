/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Demo mode reads recorded fixtures from eval/demo at request time; make
    // sure they are bundled with every API route on serverless deployments.
    outputFileTracingIncludes: {
      "/api/**/*": ["./eval/demo/**/*"],
    },
  },
};

export default nextConfig;
