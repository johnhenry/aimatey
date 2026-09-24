// Standalone config so `npx vitest run` works from this directory without
// picking up the monorepo root's vitest.workspace.ts (which only looks
// under tests/**, deliberately excluding examples/). See server.test.ts's
// header comment for why this test lives here instead of tests/unit.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
