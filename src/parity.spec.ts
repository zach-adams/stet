import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoGatewayErrors, freezeThirdParties, loadEverything, measure, scrollAndHold, watchGatewayErrors } from './capture.ts';
import { explainPaint, readPaintRecord } from './paint.ts';
import { referencesDir, run } from './run.ts';

for (const path of run.pages) {
  test(path, async ({ page, context }, info) => {
    // The hash keeps two addresses from sharing files, which would let saving one replace the other's references unapproved.
    const name = `${path.split('?')[0]!.split('/').filter(Boolean).join('-') || 'home'}-${createHash('sha1').update(path).digest('hex').slice(0, 8)}`;
    const reference = (suffix: string) => join(referencesDir, info.project.name, `${name}${suffix}`);
    const hosts = await freezeThirdParties(context, reference('.har'));
    const gatewayErrors = watchGatewayErrors(context);
    const facts: { blocked?: string[]; replayed?: string[]; redirected?: string[]; paint?: string[]; gatewayErrors?: number; notCompared?: { right: number; bottom: number } } = {};

    try {
      const response = await page.goto(path);

      expect(response?.ok(), `${path} returned ${response?.status()}`).toBe(true);
      // A site may redirect unknown addresses home, which would save the wrong page as this page's reference.
      expect(response?.request().redirectedFrom(), `${path} redirected to ${page.url()}`).toBeNull();
      await loadEverything(page, gatewayErrors);
      // Finishing an animation can change the page's height, so settle before measuring it.
      await scrollAndHold(page, 0);

      const size = await measure(page);

      // A page that shrinks or grows must fail even where the parts it still has match.
      expect.soft(`${size.width}x${size.height}\n`).toMatchSnapshot(`${name}-size.txt`);
      // Pixels can't see where a link goes or what a control is called.
      expect.soft(`${await page.locator('body').ariaSnapshot()}\n`).toMatchSnapshot(`${name}-aria.txt`);

      const paint = await readPaintRecord(page);
      const commandsFile = reference('-paint-commands.json.gz');

      if (run.saving) {
        mkdirSync(dirname(commandsFile), { recursive: true });
        writeFileSync(commandsFile, paint.commands);
      } else if (existsSync(commandsFile) && existsSync(info.snapshotPath(`${name}-paint.txt`))) {
        const summary = readFileSync(info.snapshotPath(`${name}-paint.txt`), 'utf8');

        if (summary !== paint.summary) {
          facts.paint = explainPaint(summary, paint.summary, readFileSync(commandsFile), paint.commands);
        }
      }

      expect.soft(paint.summary).toMatchSnapshot(`${name}-paint.txt`);

      if (run.saving || run.full) {
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
      expect(await measure(page), `${path} changed size during capture`).toEqual(size);
    } finally {
      facts.blocked = [...hosts.blocked];
      facts.replayed = [...hosts.replayed];
      facts.redirected = [...hosts.redirected];
      facts.gatewayErrors = gatewayErrors();
      await info.attach('stet-facts', { body: JSON.stringify(facts), contentType: 'application/json' });
    }
  });
}
