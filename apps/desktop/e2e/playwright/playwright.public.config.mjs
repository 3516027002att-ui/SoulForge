import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import config from './playwright.config.mjs';

// These checks own their synthetic workspaces and require no private game corpus.
// The full config retains the real-assets and native TAE checks separately.
export default defineConfig({
  ...config,
  testMatch: [
    'editor-loaded-comparison.spec.mjs',
    'g5-limits-scroll.spec.mjs',
    'native-frame-theme.spec.mjs',
    'param-perf.spec.mjs',
    'production-main.spec.mjs',
    'renderer.spec.mjs'
  ],
  outputDir: fileURLToPath(new URL('../../../../.local-validation/public-renderer-e2e/test-results/', import.meta.url)),
  reporter: [
    ['list'],
    ['html', { outputFolder: fileURLToPath(new URL('../../../../.local-validation/public-renderer-e2e/html-report/', import.meta.url)), open: 'never' }]
  ]
});
