import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  // Solid's browser build: its default node export is the non-reactive server renderer.
  ssr: { resolve: { conditions: ['browser'] } },
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.mts', 'appVersion.test.ts'], environment: 'node' },
});
