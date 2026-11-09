import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  drawFrame,
  expectNoGatewayErrors,
  freezeThirdParties,
  makeRepeatable,
  measure,
  openPage,
  scrollAndHold,
  watchGatewayErrors,
} from './capture.ts';
import {
  changedPoints,
  explainPaint,
  paintReader,
  paintSummary,
  type PaintRecord,
} from './paint.ts';
import type { Facts } from './report.ts';
import { referencesDir, run } from './run.ts';
import {
  explainStates,
  namesAt,
  readInteraction,
  stateHashes,
  walkStates,
  type State,
} from './states.ts';

type PageSize = Awaited<ReturnType<typeof measure>>;

/** Stored with the references, only to explain a failure. */
interface SavedRecord {
  rest: PaintRecord;
  states: State[];
}

// The hash keeps two addresses from sharing files, which would let saving one replace the
// other's references unapproved.
function referenceName(path: string) {
  const slug = path.split('?')[0].split('/').filter(Boolean).join('-') || 'home';
  const hash = createHash('sha1').update(path).digest('hex').slice(0, 8);

  return `${slug}-${hash}`;
}

async function compareSizeAndAria(page: Page, name: string, size: PageSize) {
  // A page that shrinks or grows must fail even where the parts it still has match.
  expect.soft(`${size.width}x${size.height}\n`).toMatchSnapshot(`${name}-size.txt`);
  // Pixels can't see where a link goes or what a control is called.
  expect.soft(`${await page.locator('body').ariaSnapshot()}\n`).toMatchSnapshot(`${name}-aria.txt`);
}

// toHaveScreenshot decodes both images and compares every pixel even when they're the same file.
async function isReferenceCopy(page: Page, file: string) {
  const reference = test.info().snapshotPath(file, { kind: 'screenshot' });

  if (run.saving || !existsSync(reference)) {
    return false;
  }

  // The same frame wait and capture that toHaveScreenshot makes.
  await drawFrame(page);

  const screen = await page.screenshot({ animations: 'disabled', scale: 'css' });

  return screen.equals(readFileSync(reference));
}

async function compareScreens(page: Page, name: string, size: PageSize, facts: Facts) {
  // A full-page screenshot resizes the page, which reloads responsive images and moves
  // carousels, so take one screen at a time.
  const stops = Array.from(
    { length: Math.ceil(size.lastScroll / size.screenHeight) + 1 },
    (_, screen) => Math.min(screen * size.screenHeight, size.lastScroll),
  );

  for (const [screen, top] of stops.entries()) {
    const file = `${name}-${screen + 1}.png`;

    await scrollAndHold(page, top);

    if (!(await isReferenceCopy(page, file))) {
      await expect.soft(page).toHaveScreenshot(file);
    }
  }

  // Script scrolling can't pan a phone screen across a page that is wider than it.
  const right = Math.max(0, size.width - size.screenWidth);
  const bottom = Math.max(0, size.height - size.lastScroll - size.screenHeight);

  if (right || bottom) {
    facts.notCompared = { right, bottom };
  }
}

for (const path of run.pages) {
  test(path, async ({ page, context }, info) => {
    const name = referenceName(path);
    const reference = (suffix: string) =>
      join(referencesDir, info.project.name, `${name}${suffix}`);
    const hosts = await freezeThirdParties(context, reference('.har'));
    const gatewayErrors = watchGatewayErrors(context);
    const facts: Facts = {};

    await makeRepeatable(page);

    try {
      await openPage(page, path, gatewayErrors, info.parallelIndex);

      // Finishing an animation can change the page's height, so settle before measuring it.
      await scrollAndHold(page, 0);

      const size = await measure(page);

      await compareSizeAndAria(page, name, size);
      expect.soft(await readInteraction(page)).toMatchSnapshot(`${name}-interaction.txt`);

      const readPaint = await paintReader(page);
      const rest = await readPaint();
      const recordFile = reference('-record.json.gz');
      const saved: SavedRecord | undefined =
        !run.saving && existsSync(recordFile)
          ? JSON.parse(gunzipSync(readFileSync(recordFile)).toString())
          : undefined;

      if (saved && paintSummary(saved.rest) !== paintSummary(rest)) {
        const names = await namesAt(page, changedPoints(saved.rest, rest));

        facts.paint = explainPaint(saved.rest, rest);

        if (names.length) {
          facts.paint.unshift(`Near ${names.join(', ')}.`);
        }
      }

      // A paint line's fourth field is its pixel hash, or video for a layer with none.
      facts.videos = rest.lines.filter((line) => line.split(' ')[3] === 'video').length;
      expect.soft(paintSummary(rest)).toMatchSnapshot(`${name}-paint.txt`);

      // Pressing things must not change the site.
      await context.route('**/*', (route) =>
        route.request().method() === 'GET' ? route.fallback() : route.abort(),
      );

      const every = run.saving || run.full;
      const { pools, controls, notDriven } = await walkStates(page, readPaint, every);
      const states = [...pools, ...controls];

      facts.notDriven = notDriven;

      if (run.saving) {
        mkdirSync(dirname(recordFile), { recursive: true });
        writeFileSync(recordFile, gzipSync(JSON.stringify({ rest, states } satisfies SavedRecord)));
      } else if (saved) {
        // Kept by `stet accept-changes`, so later failures are explained against what was
        // accepted. Without --full the controls weren't driven, so the saved ones stay.
        const observed = info.outputPath(`${name}-record.json.gz`);
        const kept = every ? [] : saved.states.filter(({ group }) => group === 'control');

        writeFileSync(
          observed,
          gzipSync(JSON.stringify({ rest, states: [...states, ...kept] } satisfies SavedRecord)),
        );
        facts.record = { observed, reference: recordFile };

        const compared = every
          ? saved.states
          : saved.states.filter(({ group }) => group === 'pool');

        if (stateHashes(compared) !== stateHashes(states)) {
          facts.states = await explainStates(
            page,
            { rest: saved.rest, states: compared },
            states,
            rest,
          );
        }
      }

      // Labels aren't part of the verdict, so a control renamed or moved in the markup passes
      // as long as every state still renders the same.
      expect.soft(stateHashes(pools)).toMatchSnapshot(`${name}-pools.txt`);

      if (every) {
        expect.soft(stateHashes(controls)).toMatchSnapshot(`${name}-controls.txt`);

        // A load of their own, so that every read above takes the same path whether or not
        // screenshots follow.
        await openPage(page, path, gatewayErrors, info.parallelIndex);
        await scrollAndHold(page, 0);

        await compareScreens(page, name, size, facts);
      }

      expectNoGatewayErrors(gatewayErrors);
    } finally {
      facts.blocked = [...hosts.blocked];
      facts.replayed = [...hosts.replayed];
      facts.redirected = [...hosts.redirected];
      facts.gatewayErrors = gatewayErrors.count();
      await info.attach('stet-facts', {
        body: JSON.stringify(facts),
        contentType: 'application/json',
      });
    }
  });
}
