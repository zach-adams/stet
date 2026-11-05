import { existsSync } from 'node:fs';
import { expect, type BrowserContext, type Page, type Request } from '@playwright/test';
import { run } from './run.ts';

// These can't change a page on their own, and a site that loses them fails the load check.
const PASSIVE = new Set(['font', 'stylesheet', 'image', 'media']);

// Third parties change on their own schedule, so every run gets the saved responses or nothing.
export async function freezeThirdParties(context: BrowserContext, har: string) {
  const site = new URL(run.baseURL);
  const hosts = { blocked: new Set<string>(), replayed: new Set<string>(), redirected: new Set<string>() };
  const replay = run.replay ? new RegExp(run.replay) : undefined;
  const hasResponses = run.saving || existsSync(har);
  const keep = (request: Request) => hasResponses && (PASSIVE.has(request.resourceType()) || Boolean(replay?.test(request.url())));

  const isThirdParty = (url: URL) => url.protocol.startsWith('http') && url.origin !== site.origin;
  const url = (request: Request) => new URL(request.url());

  // Playwright routes only the first request of a redirect chain, so one that started on the site reached the network.
  const escapedRedirect = (request: Request) => {
    let first = request;

    while (first.redirectedFrom()) {
      first = first.redirectedFrom()!;
    }

    return first !== request && !isThirdParty(url(first));
  };

  context.on('request', (request) => {
    if (!isThirdParty(url(request))) {
      return;
    }

    if (escapedRedirect(request)) {
      hosts.redirected.add(url(request).hostname);
    } else if (!keep(request)) {
      hosts.blocked.add(url(request).hostname);
    }
  });

  context.on('requestfinished', (request) => {
    if (isThirdParty(url(request)) && keep(request) && !escapedRedirect(request)) {
      hosts.replayed.add(url(request).hostname);
    }
  });

  // A response that wasn't saved is aborted, so it was blocked in effect.
  context.on('requestfailed', (request) => {
    if (isThirdParty(url(request)) && keep(request) && !escapedRedirect(request)) {
      hosts.blocked.add(url(request).hostname);
    }
  });

  if (hasResponses) {
    const thirdParty = new RegExp(`^(?!${site.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$))https?://`);

    await context.routeFromHAR(
      har,
      run.saving ? { url: thirdParty, update: true, updateContent: 'attach' } : { url: thirdParty, notFound: 'abort' },
    );
  }

  // Routes run newest first, so this decides what reaches the saved responses above.
  await context.route('**/*', (route) => {
    const request = route.request();

    if (new URL(request.url()).origin === site.origin || keep(request)) {
      return route.fallback();
    }

    return request.resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      : route.abort();
  });

  return hosts;
}

// A local server that's overloaded answers even static files with gateway errors, which must not look like a change to the page.
export function watchGatewayErrors(context: BrowserContext) {
  const origin = new URL(run.baseURL).origin;
  let errors = 0;

  context.on('response', (response) => {
    if ([502, 503, 504].includes(response.status()) && new URL(response.url()).origin === origin) {
      errors++;
    }
  });

  return () => errors;
}

export function expectNoGatewayErrors(gatewayErrors: () => number) {
  expect(gatewayErrors(), `The site answered ${gatewayErrors()} requests with a gateway error, so it may be overloaded. Run fewer comparisons at once and try again.`).toBe(0);
}

// A blank image or fallback font must fail here instead of passing as a stable capture.
export async function loadEverything(page: Page, gatewayErrors: () => number) {
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

  expectNoGatewayErrors(gatewayErrors);

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

  let stillMissing = await missing();

  for (let tries = 0; stillMissing.length && tries < 100; tries++) {
    await page.waitForTimeout(100);
    stillMissing = await missing();
  }

  expect(stillMissing, `${new URL(page.url()).pathname} didn't finish loading: ${stillMissing.join(', ')}`).toEqual([]);

  // A page that grows during the scroll pass can leave a phone's screen panned, which scrollTo can't undo.
  await page.evaluate(() => document.documentElement.scrollIntoView({ block: 'start', behavior: 'instant' }));
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

export async function scrollAndHold(page: Page, top: number) {
  await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), top);
  expect(await page.evaluate(settle), `${new URL(page.url()).pathname} never held still at scroll position ${top}`).toBe(true);

  const { y, panned, height } = await page.evaluate(() => ({ y: scrollY, panned: visualViewport!.offsetTop, height: document.documentElement.scrollHeight }));

  expect(
    Math.round(y) === Math.round(top) && panned === 0,
    `${new URL(page.url()).pathname} did not stay at scroll position ${top}. It ended at ${y}, with the screen panned ${panned}px and the page ${height}px tall.`,
  ).toBe(true);
}

export const measure = (page: Page) =>
  page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    screenWidth: visualViewport!.width,
    screenHeight: visualViewport!.height,
    lastScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
  }));
