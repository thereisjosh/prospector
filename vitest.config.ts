import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    setupFiles: ["./eval/vitest-setup.ts"],
    // .agents/scratch holds full copies of the repo (with their own *.test.ts); never discover them.
    exclude: [...configDefaults.exclude, ".agents/**"],
  },
});
