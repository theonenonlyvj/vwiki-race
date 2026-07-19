import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "**/*.worker.test.ts", "**/.worktrees/**"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
