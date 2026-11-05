import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { dirs, referencesDir, run } from './src/run.ts';
import { sizes } from './src/sizes.ts';

export default defineConfig({
  testDir: 'src',
  outputDir: join(dirs.state, 'results'),
  snapshotPathTemplate: join(referencesDir, '{projectName}', '{arg}{ext}'),
  // Only `stet save-references` writes references. A missing reference fails a comparison.
  updateSnapshots: run.saving ? 'all' : 'none',
  fullyParallel: true,
  // Four leaves the machine usable during a run, at some cost in finish time. Two local sites also
  // answered 502 at six page loads at once and never at four.
  workers: 4,
  timeout: 120_000,
  reporter: './src/report.ts',
  use: { baseURL: run.baseURL, ignoreHTTPSErrors: true },
  expect: {
    timeout: 30_000,
    // A logo on a few phone screens varies by one color level between loads, and the paint record
    // still compares exact pixels. This passes every color 1 level off out of 255, and some up to 3
    // off in blue, as the report says. Raise it only for a specific, reported reason.
    toHaveScreenshot: { threshold: 0.004 },
  },
  projects: sizes,
});
