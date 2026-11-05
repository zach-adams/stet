import { devices } from '@playwright/test';

// Six common screen sizes. Pixel ratio stays at 1 to keep captures fast.
const touch = (agent: string, width: number, height: number) => ({
  ...devices[agent],
  viewport: { width, height },
  screen: { width, height },
  deviceScaleFactor: 1,
});

export const sizes = [
  { name: 'large-desktop', use: { viewport: { width: 2560, height: 1440 } } },
  { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
  { name: 'small-desktop', use: { viewport: { width: 1280, height: 720 } } },
  { name: 'tablet', use: touch('Galaxy Tab S9', 800, 1280) },
  { name: 'large-phone', use: touch('Pixel 10', 414, 896) },
  { name: 'small-phone', use: touch('Pixel 10', 360, 780) },
];
