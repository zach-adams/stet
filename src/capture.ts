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

export type GatewayErrors = { count: () => number; forget: () => void };

// A local server that's overloaded answers even static files with gateway errors, which must not look like a change to the page.
export function watchGatewayErrors(context: BrowserContext): GatewayErrors {
  const origin = new URL(run.baseURL).origin;
  let errors = 0;

  context.on('response', (response) => {
    if ([502, 503, 504].includes(response.status()) && new URL(response.url()).origin === origin) {
      errors++;
    }
  });

  return { count: () => errors, forget: () => (errors = 0) };
}

let workerHasLoaded = false;

/**
 * Opens a page without overloading the server. Two local sites answered 502 at six full page loads at once and never at four. Reading paint needs no server,
 * so only the first load of each worker is staggered. Later ones spread out on their own, and retrying covers the rest.
 */
export async function openPage(page: Page, path: string, gatewayErrors: GatewayErrors, worker: number) {
  if (!workerHasLoaded) {
    workerHasLoaded = true;
    await new Promise((resolve) => setTimeout(resolve, worker * 500));
  }

  for (let attempt = 1; ; attempt++) {
    const response = await page.goto(path);

    await loadEverything(page, gatewayErrors);

    if (!gatewayErrors.count()) {
      return response;
    }

    expectNoGatewayErrors(attempt < 3 ? { count: () => 0, forget: () => {} } : gatewayErrors);
    gatewayErrors.forget();
    await new Promise((resolve) => setTimeout(resolve, 2000 + worker * 500));
  }
}

export function expectNoGatewayErrors(gatewayErrors: GatewayErrors) {
  expect(gatewayErrors.count(), `The site answered ${gatewayErrors.count()} requests with a gateway error, so it may be overloaded. Run fewer comparisons at once and try again.`).toBe(0);
}

const requests = new WeakMap<Page, { pending: Set<Request>; started: boolean }>();

// Timers fire only when Stet runs them, from before the first script, so what a page shows can't depend on machine load or how long a request took. Running a second of them takes about a millisecond. Scripts also shuffle logos and pick random slides, so every load draws the same numbers.
export async function makeRepeatable(page: Page) {
  const tracked = { pending: new Set<Request>(), started: false };

  // A playing video's request stays open for as long as it plays, and a page leaving isn't something to wait for.
  page.on('request', (request) => {
    if (request.resourceType() !== 'media' && !request.isNavigationRequest()) {
      tracked.pending.add(request);
      tracked.started = true;
    }
  });
  page.on('requestfinished', (request) => tracked.pending.delete(request));
  page.on('requestfailed', (request) => tracked.pending.delete(request));
  requests.set(page, tracked);

  await page.addInitScript(() => {
    let seed = 1;

    Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Scripts restart video when it scrolls into view, and any frame but the first varies.
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));

  // CSS animations then reach their end in one frame, including ones script can't list, such as an opening details element's height.
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 100_000 });
}

/** Returns whether any request started since the last call, even one that has already finished. */
async function requestsDone(page: Page) {
  const tracked = requests.get(page)!;

  for (let waited = 0; tracked.pending.size && waited < 5000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // A request that never ends costs this wait once.
  tracked.pending.clear();

  const started = tracked.started;

  tracked.started = false;

  return started;
}

// Use Playwright's capture here, because a raw Page.captureScreenshot with a clip changes the layout on emulated phones.
export const drawFrame = (page: Page) => page.screenshot({ type: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 1, height: 1 } });

// A blank image or fallback font must fail here instead of passing as a stable capture.
async function loadEverything(page: Page, gatewayErrors: GatewayErrors) {
  // Scripts that start from a timer may load more, and forms and embeds may wait until they come into view.
  const runTimers = async () => {
    await requestsDone(page);
    await page.clock.runFor(1000);
    await requestsDone(page);
  };

  await runTimers();

  const { height, screen } = await page.evaluate(() => {
    for (const image of document.images) {
      image.loading = 'eager';
    }

    return { height: document.documentElement.scrollHeight, screen: innerHeight };
  });

  for (let y = 0; y < height; y += screen) {
    await page.evaluate((y) => {
      scrollTo({ top: y, behavior: 'instant' });
    }, y);
    await drawFrame(page);
    await page.clock.runFor(100);
  }

  await page.evaluate(() => {
    scrollTo({ top: 0, behavior: 'instant' });
  });
  await runTimers();
  await runTimers();

  // An image the server dropped will be there on the next try, so there's nothing to wait for or report.
  if (gatewayErrors.count()) {
    return;
  }

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
    await page.clock.runFor(100);
    stillMissing = await missing();
  }

  expect(stillMissing, `${new URL(page.url()).pathname} didn't finish loading: ${stillMissing.join(', ')}`).toEqual([]);

  // Autoplay needs stopping too. A video with nothing loaded has nothing to seek, and one that won't finish seeking fails as unstable later.
  await Promise.race([
    page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll('video')].map((video) => {
          video.autoplay = false;
          video.pause();

          return video.readyState === 0 ? undefined : new Promise((resolve) => {
            video.addEventListener('seeked', resolve, { once: true });
            video.currentTime = 0;
          });
        }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

// What can still move once content has painted: page height and scroll offsets. Animations are finished rather than waited for.
function finishAnimationsAndReadLayout() {
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

  const everything = document.querySelectorAll('*');
  let layout = `${document.documentElement.scrollHeight},${visualViewport?.offsetTop},${everything.length}`;

  for (const element of everything) {
    if (element.scrollLeft || element.scrollTop) {
      layout += `,${element.scrollLeft},${element.scrollTop}`;
    }
  }

  return layout;
}

/** Runs what a change set off, from requests and timers to animations, until the layout holds. An embedded form can go from a request to a timer to more requests, so waiting on a request starts the count again. */
export async function settle(page: Page) {
  await page.clock.runFor(500);

  let last = '';

  for (let held = 0, round = 0; round < 30; round++) {
    const waited = await requestsDone(page);
    const now = await page.evaluate(finishAnimationsAndReadLayout);

    held = now === last && !waited ? held + 1 : 0;
    last = now;
    // The compositor drops the layers of a finished animation only in a later frame.
    await drawFrame(page);

    if (held === 2) {
      return true;
    }

    await page.clock.runFor(waited ? 500 : 32);
  }

  return false;
}

export async function scrollAndHold(page: Page, top: number) {
  const path = new URL(page.url()).pathname;
  const scrollAndWait = async () => {
    await page.evaluate((top) => {
      // Focus moving into a dialog or a page growing can leave a phone's screen panned, which scrollTo can't undo.
      document.documentElement.scrollIntoView({ block: 'start', behavior: 'instant' });
      scrollTo({ top, behavior: 'instant' });
    }, top);
    expect(await settle(page), `${path} never held still at scroll position ${top}`).toBe(true);
  };

  await scrollAndWait();

  // Opening something can grow the page, and scroll anchoring then moves it away from where it was sent.
  if (Math.round(await page.evaluate(() => scrollY)) !== Math.round(top)) {
    await scrollAndWait();
  }

  const { y, panned, height, last } = await page.evaluate(() => ({ y: scrollY, panned: visualViewport!.offsetTop, height: document.documentElement.scrollHeight, last: document.documentElement.scrollHeight - innerHeight }));

  // A page can get shorter as it scrolls, which makes a stop near the bottom land on the new bottom.
  expect(
    Math.round(y) === Math.round(Math.min(top, last)) && panned === 0,
    `${path} did not stay at scroll position ${top}. It ended at ${y}, with the screen panned ${panned}px and the page ${height}px tall.`,
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
