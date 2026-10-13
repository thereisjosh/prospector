import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./eval/vitest-setup.ts"],
  },
});
