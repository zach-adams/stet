import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { site, stateDir } from './src/site.ts';

// Six common screen sizes. Pixel ratio stays at 1 to keep captures fast.
const touch = (agent: string, width: number, height: number) => ({
  ...devices[agent],
  viewport: { width, height },
  screen: { width, height },
  deviceScaleFactor: 1,
});

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
    toHaveScreenshot: { threshold: 0, stylePath: join(import.meta.dirname, 'src/capture.css') },
  },
  projects: [
    { name: 'large-desktop', use: { viewport: { width: 2560, height: 1440 } } },
    { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'small-desktop', use: { viewport: { width: 1280, height: 720 } } },
    { name: 'tablet', use: touch('Galaxy Tab S9', 800, 1280) },
    { name: 'large-phone', use: touch('Pixel 10', 414, 896) },
    { name: 'small-phone', use: touch('Pixel 10', 360, 780) },
  ],
});
