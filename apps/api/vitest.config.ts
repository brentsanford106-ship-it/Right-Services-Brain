import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Tests share one seeded database; files run one at a time so writes in one file can't surprise another.
    fileParallelism: false,
  },
});
