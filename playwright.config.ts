import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { site, stateDir } from './src/site.ts';

export default defineConfig({
  testDir: 'src',
  outputDir: join(stateDir, 'results'),
  snapshotPathTemplate: join(stateDir, 'references', '{projectName}', '{arg}{ext}'),
  // Only `pnpm baseline` writes references. A missing reference fails verification.
  updateSnapshots: 'none',
  fullyParallel: true,
  timeout: 120_000,
  reporter: 'list',
  use: { baseURL: site.baseURL, ignoreHTTPSErrors: true },
  expect: {
    timeout: 30_000,
    // Any changed pixel fails. Raise this only for a specific, reported reason.
    toHaveScreenshot: { threshold: 0 },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
