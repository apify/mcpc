import { defineConfig } from 'vitest/config';

// Coverage thresholds match the previous Jest setup (70% across the board).
// See test/README.md for the test layout.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.spec.ts'],
    environment: 'node',
    // `globals: true` keeps the existing test bodies (`describe`/`it`/`expect`)
    // working without changing every file's imports. Jest-compatible API.
    globals: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test/coverage/unit',
      reporter: ['text', 'lcov', 'html', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
  },
});
