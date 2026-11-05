import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { referencesDir, saving, site } from './site.ts';

// Third parties change on their own schedule, so every run gets the saved responses or nothing.
async function freezeThirdParties(context: BrowserContext, har: string) {
  const origin = new URL(site.baseURL).origin;
  const hosts = { blocked: new Set<string>(), replayed: new Set<string>(), redirected: new Set<string>() };

  context.on('request', (request) => {
    const url = new URL(request.url());

    if (url.protocol.startsWith('http') && url.origin !== origin) {
      // Playwright routes only the first request of a redirect chain, so these reached the network.
      hosts[site.replay?.test(url.href) ? 'replayed' : request.redirectedFrom() ? 'redirected' : 'blocked'].add(url.hostname);
    }
  });

  await context.route('**/*', (route) => {
    const request = route.request();

    if (new URL(request.url()).origin === origin || (saving && site.replay?.test(request.url()))) {
      return route.fallback();
    }

    return request.resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      : route.abort();
  });

  if (site.replay) {
    await context.routeFromHAR(
      har,
      saving ? { url: site.replay, update: true, updateContent: 'attach' } : { url: site.replay, notFound: 'abort' },
    );
  }

  return hosts;
}

// A blank image or fallback font must fail here instead of passing as a stable capture.
async function loadEverything(page: Page) {
  await page.evaluate(async () => {
    for (const image of document.images) {
      image.loading = 'eager';
    }

    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

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

// Finish animations, then wait for what can still move once content has painted: page height and scroll offsets.
async function settle() {
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const layout = () => {
    let offsets = `${document.documentElement.scrollHeight},${visualViewport?.offsetTop}`;

    for (const element of document.querySelectorAll('*')) {
      if (element.scrollLeft || element.scrollTop) {
        offsets += `,${element.scrollLeft},${element.scrollTop}`;
      }
    }

    return offsets;
  };

  let last = '';

  for (let held = 0, round = 0; round < 60; round++) {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.cancel();
      } else {
        try {
          animation.finish();
        } catch {
          animation.cancel();
        }
      }
    }

    await frames();

    const now = layout();

    held = now === last ? held + 1 : 0;
    last = now;

    if (held === 2) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return false;
}

// Playwright's own -g also matches the size and file names, so `--page desktop` would select every page.
const pages = site.pages.filter((path) => new RegExp(process.env.STET_PAGE ?? '').test(path));

for (const path of pages) {
  test(path, async ({ page, context }, info) => {
    const name = path.replace(/^\/|\/$/g, '').replaceAll('/', '-') || 'home';
    const hosts = await freezeThirdParties(context, join(referencesDir, info.project.name, `${name}.har`));
    const facts: { blocked?: string[]; replayed?: string[]; redirected?: string[]; notCompared?: { right: number; bottom: number } } = {};

    try {
      const response = await page.goto(path);

      expect(response?.ok(), `${path} returned ${response?.status()}`).toBe(true);
      // A site may redirect unknown addresses home, which would save the wrong page as this page's reference.
      expect(response?.request().redirectedFrom(), `${path} redirected to ${page.url()}`).toBeNull();
      await loadEverything(page);

      // A page that grows during the scroll pass can leave a phone's screen panned, which scrollTo can't undo.
      await page.evaluate(() => document.documentElement.scrollIntoView({ block: 'start', behavior: 'instant' }));
      // Finishing an animation can change the page's height, so settle before measuring it.
      expect(await page.evaluate(settle), `${path} never held still`).toBe(true);

      const measure = () =>
        page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          screenWidth: visualViewport!.width,
          screenHeight: visualViewport!.height,
          lastScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
        }));
      const size = await measure();

      // A page that shrinks or grows must fail even where the screens it still has match.
      expect.soft(`${size.width}x${size.height}\n`).toMatchSnapshot(`${name}.size.txt`);

      // A full-page screenshot resizes the page, which reloads responsive images and moves carousels, so take one screen at a time.
      const stops = Array.from({ length: Math.ceil(size.lastScroll / size.screenHeight) + 1 }, (_, screen) =>
        Math.min(screen * size.screenHeight, size.lastScroll),
      );

      for (const [screen, top] of stops.entries()) {
        await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), top);
        expect(await page.evaluate(settle), `${path} never held still at scroll position ${top}`).toBe(true);
        expect(
          await page.evaluate(() => [Math.round(scrollY), visualViewport!.offsetTop]),
          `${path} did not stay at scroll position ${top}`,
        ).toEqual([Math.round(top), 0]);
        await expect.soft(page).toHaveScreenshot(`${name}-${screen + 1}.png`);
      }

      expect(await measure(), `${path} changed size during capture`).toEqual(size);

      // Script scrolling can't pan a phone screen across a page that is wider than it.
      const right = Math.max(0, size.width - size.screenWidth);
      const bottom = Math.max(0, size.height - size.lastScroll - size.screenHeight);

      if (right || bottom) {
        facts.notCompared = { right, bottom };
      }
    } finally {
      facts.blocked = [...hosts.blocked];
      facts.replayed = [...hosts.replayed];
      facts.redirected = [...hosts.redirected];
      await info.attach('stet-facts', { body: JSON.stringify(facts), contentType: 'application/json' });
    }
  });
}
