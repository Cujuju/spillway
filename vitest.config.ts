import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Shared CI runners are contended. Larger fixtures declare their own budget.
const CI_TEST_TIMEOUT_MS = 30_000;
// Keep disk-heavy fixtures from competing with other test files on Windows CI.
const WINDOWS_CI_WORKERS = 1;

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  // Solid's browser build: its default node export is the non-reactive server renderer.
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mts', 'appVersion.test.ts'], environment: 'node',
    ...(process.env.CI ? { testTimeout: CI_TEST_TIMEOUT_MS } : {}),
    ...(process.env.CI && process.platform === 'win32' ? { maxWorkers: WINDOWS_CI_WORKERS } : {}),
  },
});
