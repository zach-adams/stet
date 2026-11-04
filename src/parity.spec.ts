import { expect, test, type Page } from '@playwright/test';
import { site } from './site.ts';

// A blank image or fallback font must fail here instead of passing as a stable capture.
async function settle(page: Page) {
  await page.evaluate(async () => {
    for (const image of document.images) {
      image.loading = 'eager';
    }

    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise(requestAnimationFrame);
    }

    // Instant, because a site's smooth scrolling would keep moving the page during capture.
    scrollTo({ top: 0, behavior: 'instant' });
  });

  // Scrolling can start forms and embeds that load only when they come into view.
  await page.waitForLoadState('networkidle');

  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled([...document.images].map((image) => image.decode()));
  });

  const missing = () =>
    page.evaluate(() => [
      ...[...document.images]
        .filter((image) => image.checkVisibility() && !(image.complete && image.naturalWidth > 0))
        .map((image) => `image: ${image.currentSrc || image.src}`),
      ...[...document.fonts]
        .filter((font) => font.status === 'error')
        .map((font) => `font: ${font.family}`),
    ]);

  await expect.poll(missing, { message: 'Everything visible finished loading' }).toEqual([]);
}

for (const path of site.pages) {
  test(path, async ({ page }) => {
    const response = await page.goto(path);

    expect(response?.ok(), `${path} returned ${response?.status()}`).toBe(true);
    await settle(page);

    const name = path.replace(/^\/|\/$/g, '').replaceAll('/', '-') || 'home';

    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
