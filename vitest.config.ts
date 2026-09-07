import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    isolate: true,
    env: {
      NODE_ENV: "test",
    },
  },
});
