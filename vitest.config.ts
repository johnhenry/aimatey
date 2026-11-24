import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Core packages
      '@johnhenry/aimatey-types': path.resolve(__dirname, 'packages/aimatey-types/src'),
      '@johnhenry/aimatey-errors': path.resolve(__dirname, 'packages/aimatey-errors/src'),
      '@johnhenry/aimatey-utils': path.resolve(__dirname, 'packages/aimatey-utils/src'),
      '@johnhenry/aimatey-core': path.resolve(__dirname, 'packages/aimatey-core/src'),
      '@johnhenry/aimatey-testing': path.resolve(__dirname, 'packages/aimatey-testing/src'),
      '@johnhenry/aimatey': path.resolve(__dirname, 'packages/aimatey/src'),

      // Backend adapters (consolidated packages)
      '@johnhenry/aimatey-backend': path.resolve(__dirname, 'packages/backend/src'),
      '@johnhenry/aimatey-backend-browser': path.resolve(__dirname, 'packages/backend-browser/src'),

      // Frontend adapters (consolidated package)
      '@johnhenry/aimatey-frontend': path.resolve(__dirname, 'packages/frontend/src'),

      // Middleware (consolidated package)
      '@johnhenry/aimatey-middleware': path.resolve(__dirname, 'packages/middleware/src'),

      // HTTP adapters (consolidated package)
      '@johnhenry/aimatey-http': path.resolve(__dirname, 'packages/http/src'),
      '@johnhenry/aimatey-http-core': path.resolve(__dirname, 'packages/http.core/src'),

      // Wrappers (consolidated package)
      '@johnhenry/aimatey-wrapper': path.resolve(__dirname, 'packages/wrapper/src'),

      // React
      '@johnhenry/aimatey-react-core': path.resolve(__dirname, 'packages/react-core/src'),
      '@johnhenry/aimatey-react-hooks': path.resolve(__dirname, 'packages/react-hooks/src'),
      '@johnhenry/aimatey-react-stream': path.resolve(__dirname, 'packages/react-stream/src'),
      '@johnhenry/aimatey-react-nextjs': path.resolve(__dirname, 'packages/react-nextjs/src'),

      // Native
      '@johnhenry/aimatey-native-model-runner': path.resolve(__dirname, 'packages/native-model-runner/src'),
      '@johnhenry/aimatey-native-apple': path.resolve(__dirname, 'packages/native-apple/src'),
      '@johnhenry/aimatey-native-node-llamacpp': path.resolve(__dirname, 'packages/native-node-llamacpp/src'),

      // CLI
      '@johnhenry/aimatey-cli': path.resolve(__dirname, 'packages/cli/src'),

      // MCP tool-calling
      '@johnhenry/aimatey-mcp': path.resolve(__dirname, 'packages/mcp/src'),
      '@johnhenry/aimatey-tool-protocols': path.resolve(__dirname, 'packages/tool-protocols/src'),

      // Integration patterns
      '@johnhenry/aimatey-patterns': path.resolve(__dirname, 'packages/patterns/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'examples/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.ts',
        'tsconfig*.json',
        '.eslintrc.json',
        // Legacy src directory (deprecated)
        'src/**',
      ],
      thresholds: {
        lines: 30,
        functions: 50,
        branches: 60,
        statements: 30,
      },
      all: true,
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
