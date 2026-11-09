import { devices } from '@playwright/test';

// Six common screen sizes, plus a 768 tablet, because none of them falls between 415 and 799,
// where many layouts switch between stacked and side-by-side columns. Pixel ratio stays at 1 to
// keep captures fast.
function touch(agent: string, width: number, height: number) {
  return {
    ...devices[agent],
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor: 1,
  };
}

export const sizes = [
  { name: 'large-desktop', use: { viewport: { width: 2560, height: 1440 } } },
  { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
  { name: 'small-desktop', use: { viewport: { width: 1280, height: 720 } } },
  { name: 'tablet', use: touch('Galaxy Tab S9', 800, 1280) },
  { name: 'small-tablet', use: touch('Galaxy Tab S9', 768, 1024) },
  { name: 'large-phone', use: touch('Pixel 10', 414, 896) },
  { name: 'small-phone', use: touch('Pixel 10', 360, 780) },
];
