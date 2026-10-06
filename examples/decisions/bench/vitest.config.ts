// Standalone config so `npx vitest run` works from this directory without
// picking up the monorepo root's vitest.workspace.ts (which only looks
// under tests/**, deliberately excluding examples/).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['*.test.ts'],
  },
});
