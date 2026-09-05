import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests hit a real PostgreSQL instance.
// Set DATABASE_URL before running. Defaults to localhost (for CI on Titan
// and local dev on the Mac when PG is running).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Integration tests mutate shared DB state — run serially to avoid
    // cross-test interference.
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    // Each test file gets a fresh DB state via beforeAll truncate
    setupFiles: ["tests/integration/setup.ts"],
    // Longer timeout — network + DB + bcrypt add up
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
