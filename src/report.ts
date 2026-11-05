import { basename, dirname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import { run } from './run.ts';

function count(total: number, noun: string) {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}

function plain(error: TestError) {
  return stripVTControlCharacters(error.message ?? String(error.value));
}

function capped(lines: string[], limit: number) {
  return lines.length > limit
    ? [...lines.slice(0, limit), `  and ${lines.length - limit} more`]
    : lines;
}

export interface Facts {
  blocked?: string[];
  replayed?: string[];
  redirected?: string[];
  paint?: string[];
  states?: string[];
  notDriven?: string[];
  videos?: number;
  gatewayErrors?: number;
  notCompared?: { right: number; bottom: number };
}

function factsOf(result: TestResult): Facts {
  return JSON.parse(
    result.attachments.find((attachment) => attachment.name === 'stet-facts')?.body?.toString() ??
      '{}',
  );
}

// One page at one size, read from Playwright's error text. Screens are the numbered
// reference files.
function describe(result: TestResult) {
  const facts = factsOf(result);
  const lines: string[] = [];
  const differ: string[] = [];
  const noReference: string[] = [];
  const text: string[] = [];
  let changed = false;
  let compared = false;
  let stateChanged = false;

  for (const message of result.errors.map(plain)) {
    const snapshot = message.match(/Snapshot: (\S+)/)?.[1] ?? '';
    const pixels = message.match(/(\d+) pixels \(ratio/);
    const screen = snapshot.match(/-(\d+)\.png$/);
    const missing = message.match(/A snapshot doesn't exist at (.+?)\.?\s*$/m);

    if (message.includes('Failed to take two consecutive stable screenshots')) {
      compared = true;
      lines.push(`Screen ${screen?.[1] ?? '?'} never held still long enough to capture.`);
    } else if (missing) {
      noReference.push(basename(missing[1]));
    } else if (snapshot.endsWith('-size.txt')) {
      const [before, after] = [
        message.match(/^ {2}-(\S+)/m)?.[1],
        message.match(/^ {2}\+(\S+)/m)?.[1],
      ];

      changed = true;
      lines.unshift(`Page size changed from ${before} to ${after}.`);
    } else if (snapshot.endsWith('-aria.txt')) {
      changed = true;
      // Lines of the diff start right after the indent, while unchanged lines start with a space.
      text.push(
        ...message.split('\n').filter((line) => /^ {2}[-+]/.test(line) && !line.startsWith('  @@')),
      );
    } else if (snapshot.endsWith('-paint.txt')) {
      changed = true;
      lines.push(...(facts.paint ?? ['Painted differently.']));
    } else if (snapshot.endsWith('-pools.txt') || snapshot.endsWith('-controls.txt')) {
      changed = true;
      stateChanged = true;
    } else if (pixels && screen) {
      changed = true;
      differ.push(`${screen[1]} (${Number(pixels[1]).toLocaleString('en-US')} pixels)`);
    } else {
      compared = true;
      lines.push(
        message
          .split('\n')
          .filter((line) => line.trim() && !line.startsWith('expect('))
          .slice(0, 1)
          .join(' ')
          .replace(/^Error: /, '')
          .slice(0, 300),
      );
    }
  }

  if (text.length) {
    lines.push('Text, links or controls changed:', ...capped(text, 12));
  }

  if (stateChanged) {
    lines.push(...(facts.states ?? ['A hover, focus, pressed or open state changed.']));
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

  const failed = run.saving ? 'could not save' : 'could not compare';

  // Whatever else differs on an overloaded server says nothing about the page.
  if (facts.gatewayErrors) {
    return {
      label: failed,
      lines: [
        `The site answered ${facts.gatewayErrors} requests with a gateway error, so it may be overloaded. Run fewer comparisons at once and try again.`,
      ],
    };
  }

  let label = 'no reference';

  if (changed) {
    label = 'changed';
  } else if (compared) {
    label = failed;
  }

  return { label, lines };
}

export default class Report implements Reporter {
  private total = 0;
  private passed = 0;
  private failed = new Map<string, number>();
  private changedPages = new Set<string>();
  private blocked = new Set<string>();
  private replayed = new Set<string>();
  private redirected = new Set<string>();
  private notDriven = new Map<string, Set<string>>();
  private videos = 0;
  private wider = new Map<string, { pages: number; right: number; bottom: number }>();

  onBegin(_config: FullConfig, suite: Suite) {
    const tests = suite.allTests();
    const pages = count(new Set(tests.map((test) => test.title)).size, 'page');
    const sizes = [...new Set(tests.map((test) => test.parent.project()?.name))].join(', ');

    this.total = tests.length;

    if (!this.total) {
      return;
    }

    console.log(
      run.saving
        ? `Capturing ${pages} of ${run.baseURL} at ${sizes}. References change only if every capture succeeds.`
        : `Comparing ${pages} of ${run.baseURL} with saved references at ${sizes}. No references change. Covers each page at rest, with closed details open, and with every element hovered, focused and pressed${run.full ? ', then every menu, tab, dialog and other control, and real screenshots' : ''}.`,
    );
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const facts = factsOf(result);
    const size = test.parent.project()?.name ?? '';

    for (const host of facts.blocked ?? []) {
      this.blocked.add(host);
    }

    for (const host of facts.replayed ?? []) {
      this.replayed.add(host);
    }

    for (const host of facts.redirected ?? []) {
      this.redirected.add(host);
    }

    this.videos = Math.max(this.videos, facts.videos ?? 0);

    for (const control of facts.notDriven ?? []) {
      this.notDriven.set(test.title, (this.notDriven.get(test.title) ?? new Set()).add(control));
    }

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

    const { label, lines } = describe(result);

    this.failed.set(label, (this.failed.get(label) ?? 0) + 1);

    if (label === 'changed') {
      this.changedPages.add(test.title);
    }

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
      ...[...this.failed].map(([label, total]) => `${total} ${label}`),
      `${this.passed} ${run.saving ? 'captured' : 'unchanged'}`,
    ];

    console.log(`\n${counts.join(', ')} in ${Math.round(result.duration / 1000)}s.`);

    if (this.blocked.size) {
      console.log(
        `Blocked third parties, so not compared: ${[...this.blocked].sort().join(', ')}.`,
      );

      if (run.saving) {
        console.log(
          'If one of these draws something the page needs, such as an embedded form, save again with --replay <url pattern>.',
        );
      }
    }

    if (this.redirected.size) {
      console.log(
        `Reached through a first-party redirect, so neither blocked nor saved: ${[...this.redirected].sort().join(', ')}.`,
      );
    }

    if (this.replayed.size) {
      console.log(
        `${run.saving ? 'Saved' : 'Replayed saved'} responses from: ${[...this.replayed].sort().join(', ')}.`,
      );
    }

    for (const [size, { pages, right, bottom }] of this.wider) {
      console.log(
        `At ${size}, ${count(pages, 'page')} ${pages === 1 ? 'is' : 'are'} wider than the screen, so up to ${right}px on the right and ${bottom}px at the bottom appear only in the paint record, not the screenshots.`,
      );
    }

    for (const [page, controls] of this.notDriven) {
      console.log(
        `Not driven on ${page}, so not compared: ${capped(
          [...controls].map((name) => `"${name}"`),
          5,
        ).join(', ')}.`,
      );
    }

    if (this.videos) {
      console.log(
        `Video draws outside the paint record, so videos are compared by size and place, plus their first frame with --full.`,
      );
    }

    if (this.changedPages.size && !run.saving) {
      console.log(
        `Fix what changed, or report it. If the user approves it as intended: stet save-references ${run.baseURL} ${[...this.changedPages].join(' ')} --user-approved`,
      );
    }
  }
}
