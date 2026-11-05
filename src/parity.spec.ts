import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { expectNoGatewayErrors, freezeThirdParties, makeRepeatable, measure, openPage, scrollAndHold, watchGatewayErrors } from './capture.ts';
import { changedPoints, explainPaint, paintReader, paintSummary, type PaintRecord } from './paint.ts';
import { referencesDir, run } from './run.ts';
import { explainStates, namesAt, stateHashes, walkStates, type State } from './states.ts';

/** Stored with the references, only to explain a failure. */
type Record = { rest: PaintRecord; states: State[] };

for (const path of run.pages) {
  test(path, async ({ page, context }, info) => {
    // The hash keeps two addresses from sharing files, which would let saving one replace the other's references unapproved.
    const name = `${path.split('?')[0]!.split('/').filter(Boolean).join('-') || 'home'}-${createHash('sha1').update(path).digest('hex').slice(0, 8)}`;
    const reference = (suffix: string) => join(referencesDir, info.project.name, `${name}${suffix}`);
    const hosts = await freezeThirdParties(context, reference('.har'));
    const gatewayErrors = watchGatewayErrors(context);
    const facts: { blocked?: string[]; replayed?: string[]; redirected?: string[]; paint?: string[]; states?: string[]; notDriven?: string[]; videos?: number; gatewayErrors?: number; notCompared?: { right: number; bottom: number } } = {};

    await makeRepeatable(page);

    try {
      const response = await openPage(page, path, gatewayErrors, info.parallelIndex);

      expect(response?.ok(), `${path} returned ${response?.status()}`).toBe(true);
      // A site may redirect unknown addresses home, which would save the wrong page as this page's reference.
      expect(response?.request().redirectedFrom(), `${path} redirected to ${page.url()}`).toBeNull();

      // Finishing an animation can change the page's height, so settle before measuring it.
      await scrollAndHold(page, 0);

      const size = await measure(page);

      // A page that shrinks or grows must fail even where the parts it still has match.
      expect.soft(`${size.width}x${size.height}\n`).toMatchSnapshot(`${name}-size.txt`);
      // Pixels can't see where a link goes or what a control is called.
      expect.soft(`${await page.locator('body').ariaSnapshot()}\n`).toMatchSnapshot(`${name}-aria.txt`);

      const readPaint = await paintReader(page);
      const rest = await readPaint();
      const recordFile = reference('-record.json.gz');
      const saved: Record | undefined = !run.saving && existsSync(recordFile) ? JSON.parse(gunzipSync(readFileSync(recordFile)).toString()) : undefined;

      if (saved && paintSummary(saved.rest) !== paintSummary(rest)) {
        const names = await namesAt(page, changedPoints(saved.rest, rest));

        facts.paint = [...(names.length ? [`Near ${names.join(', ')}.`] : []), ...explainPaint(saved.rest, rest)];
      }

      facts.videos = rest.lines.filter((line) => line.endsWith(' video')).length;
      expect.soft(paintSummary(rest)).toMatchSnapshot(`${name}-paint.txt`);

      // Pressing things must not change the site.
      await context.route('**/*', (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));

      const every = run.saving || run.full;
      const { pools, controls, notDriven } = await walkStates(page, readPaint, every);
      const states = [...pools, ...controls];

      facts.notDriven = notDriven;

      if (run.saving) {
        mkdirSync(dirname(recordFile), { recursive: true });
        writeFileSync(recordFile, gzipSync(JSON.stringify({ rest, states } satisfies Record)));
      } else if (saved) {
        const compared = every ? saved.states : saved.states.filter(({ group }) => group === 'pool');

        if (stateHashes(compared) !== stateHashes(states)) {
          facts.states = await explainStates(page, { rest: saved.rest, states: compared }, states, rest);
        }
      }

      // Labels aren't part of the verdict, so a control renamed or moved in the markup passes as long as every state still renders the same.
      expect.soft(stateHashes(pools)).toMatchSnapshot(`${name}-pools.txt`);

      if (every) {
        expect.soft(stateHashes(controls)).toMatchSnapshot(`${name}-controls.txt`);

        // A load of their own, so that every read above takes the same path whether or not screenshots follow.
        await openPage(page, path, gatewayErrors, info.parallelIndex);
        await scrollAndHold(page, 0);

        // A full-page screenshot resizes the page, which reloads responsive images and moves carousels, so take one screen at a time.
        const stops = Array.from({ length: Math.ceil(size.lastScroll / size.screenHeight) + 1 }, (_, screen) =>
          Math.min(screen * size.screenHeight, size.lastScroll),
        );

        for (const [screen, top] of stops.entries()) {
          await scrollAndHold(page, top);
          await expect.soft(page).toHaveScreenshot(`${name}-${screen + 1}.png`);
        }

        // Script scrolling can't pan a phone screen across a page that is wider than it.
        const right = Math.max(0, size.width - size.screenWidth);
        const bottom = Math.max(0, size.height - size.lastScroll - size.screenHeight);

        if (right || bottom) {
          facts.notCompared = { right, bottom };
        }
      }

      expectNoGatewayErrors(gatewayErrors);
    } finally {
      facts.blocked = [...hosts.blocked];
      facts.replayed = [...hosts.replayed];
      facts.redirected = [...hosts.redirected];
      facts.gatewayErrors = gatewayErrors.count();
      await info.attach('stet-facts', { body: JSON.stringify(facts), contentType: 'application/json' });
    }
  });
}
