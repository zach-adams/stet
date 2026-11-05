import { dirname } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from '@playwright/test/reporter';

const count = (total: number, noun: string) => `${total} ${noun}${total === 1 ? '' : 's'}`;
const plain = (error: TestError) => (error.message ?? String(error.value)).replace(/\u001b\[[0-9;]*m/g, '');

// One page at one size, read from Playwright's error text. The screens are the numbered reference files.
function describe(result: TestResult, saving: boolean) {
  const lines: string[] = [];
  const differ: string[] = [];
  const noReference: string[] = [];
  let compared = false;

  for (const message of result.errors.map(plain)) {
    const size = message.match(/^\s*-(\d+x\d+)\s*\n\s*\+(\d+x\d+)/m);
    const pixels = message.match(/(\d+) pixels \(ratio/);
    const screen = message.match(/Snapshot: .*-(\d+)\.png/);
    const missing = message.match(/A snapshot doesn't exist at .*?(?:-(\d+)\.png|-size\.txt)/);

    if (message.includes('Failed to take two consecutive stable screenshots')) {
      compared = true;
      lines.push(`Screen ${screen?.[1] ?? '?'} never held still long enough to capture.`);
    } else if (size) {
      compared = true;
      lines.push(`Page size changed from ${size[1]} to ${size[2]}.`);
    } else if (pixels && screen) {
      compared = true;
      differ.push(`${screen[1]} (${Number(pixels[1]).toLocaleString('en-US')} pixels)`);
    } else if (missing) {
      noReference.push(missing[1] ?? 'page size');
    } else {
      compared = true;
      lines.push(message.split('\n').filter((line) => line.trim() && !line.startsWith('expect(')).slice(0, 2).join(' ').replace(/^Error: /, '').slice(0, 240));
    }
  }

  if (differ.length) {
    lines.push(`Screens that differ: ${differ.join(', ')}.`);
  }

  if (noReference.length) {
    lines.push(`No reference for: ${noReference.join(', ')}.`);
  }

  const diff = result.attachments.find((attachment) => attachment.name.endsWith('-diff.png'));

  if (diff?.path) {
    lines.push(`Images: ${dirname(diff.path)}`);
  }

  const changed = differ.length > 0 || lines.some((line) => line.startsWith('Page size'));

  const failed = saving ? 'could not save' : 'could not compare';

  return { label: changed ? 'changed' : compared ? failed : 'no reference', lines };
}

export default class Report implements Reporter {
  private saving = false;
  private total = 0;
  private site = process.env.STET_SITE;
  private passed = 0;
  private failed = new Map<string, number>();
  private blocked = new Set<string>();
  private replayed = new Set<string>();
  private redirected = new Set<string>();
  private wider = new Map<string, { pages: number; right: number; bottom: number }>();

  onBegin(config: FullConfig, suite: Suite) {
    const tests = suite.allTests();
    const pages = count(new Set(tests.map((test) => test.title)).size, 'page');
    const sizes = [...new Set(tests.map((test) => test.parent.project()?.name))].join(', ');

    this.saving = config.updateSnapshots === 'all';
    this.total = tests.length;

    if (!this.total) {
      return;
    }

    console.log(
      this.saving
        ? `Saving ${pages} of ${this.site} as references at ${sizes}. This replaces any existing references for them.`
        : `Comparing ${pages} of ${this.site} with saved references at ${sizes}. No references change.`,
    );
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const facts = JSON.parse(result.attachments.find((attachment) => attachment.name === 'stet-facts')?.body?.toString() ?? '{}');
    const size = test.parent.project()?.name ?? '';

    for (const host of facts.blocked ?? []) this.blocked.add(host);
    for (const host of facts.replayed ?? []) this.replayed.add(host);
    for (const host of facts.redirected ?? []) this.redirected.add(host);

    if (facts.notCompared) {
      const wider = this.wider.get(size) ?? { pages: 0, right: 0, bottom: 0 };

      this.wider.set(size, {
        pages: wider.pages + 1,
        right: Math.max(wider.right, facts.notCompared.right),
        bottom: Math.max(wider.bottom, facts.notCompared.bottom),
      });
    }

    if (result.status === 'passed') {
      this.passed++;
      return;
    }

    const { label, lines } = describe(result, this.saving);

    this.failed.set(label, (this.failed.get(label) ?? 0) + 1);
    console.log(`\n${label}: ${test.title} at ${size}`);

    for (const line of lines) {
      console.log(`  ${line}`);
    }
  }

  onError(error: TestError) {
    console.error(plain(error));
  }

  onEnd(result: FullResult) {
    if (!this.total) {
      console.log('No page matched, so nothing was compared.');
      return;
    }

    const counts = [
      ...[...this.failed].map(([label, count]) => `${count} ${label}`),
      `${this.passed} ${this.saving ? 'captured' : 'unchanged'}`,
    ];

    console.log(`\n${counts.join(', ')} in ${Math.round(result.duration / 1000)}s.`);

    if (this.blocked.size) {
      console.log(`Blocked third parties, so not compared: ${[...this.blocked].sort().join(', ')}.`);
    }

    if (this.redirected.size) {
      console.log(`Reached through a first-party redirect, so neither blocked nor saved: ${[...this.redirected].sort().join(', ')}.`);
    }

    if (this.replayed.size) {
      console.log(`${this.saving ? 'Saved' : 'Replayed saved'} responses from: ${[...this.replayed].sort().join(', ')}.`);
    }

    for (const [size, { pages, right, bottom }] of this.wider) {
      console.log(`At ${size}, ${count(pages, 'page')} ${pages === 1 ? 'is' : 'are'} wider than the screen, so up to ${right}px on the right and ${bottom}px at the bottom are not compared.`);
    }

    if (this.failed.size && !this.saving) {
      console.log(`Fix what changed, or report it. If the user approves it as intended: pnpm stet save-references ${this.site} --user-approved`);
    }
  }
}
