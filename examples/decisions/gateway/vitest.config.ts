// Standalone config so `npx vitest run` works from this directory without
// picking up the monorepo root's vitest.workspace.ts (which only looks
// under tests/**, deliberately excluding examples/). The live smoke test is
// opt-in: set OLLAMA_LIVE=1 (see server.test.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15_000,
  },
});
