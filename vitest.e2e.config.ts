import { defineConfig } from "vitest/config";

// Separate config for the live end-to-end test so it is NOT run by `npm test`
// (it requires a running dev server). Run with:
//   npx vitest run --config vitest.e2e.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e.spec.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
