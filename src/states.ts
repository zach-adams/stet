import { createHash } from 'node:crypto';
import type { CDPSession, JSHandle, Page } from '@playwright/test';
import { settle } from './capture.ts';
import {
  changedPoints,
  explainPaint,
  lineChanges,
  paintSummary,
  type PaintRecord,
} from './paint.ts';

export interface State {
  label: string;
  group: 'pool' | 'control';
  paint: PaintRecord;
  aria: string;
  interaction: string;
}

// A page with more than this is rare, and the report says how many weren't driven.
const MOST_CONTROL_READS = 60;
const FOCUSABLE = ':is(a[href],button,input,select,textarea,summary,[tabindex],[contenteditable])';
const HOLDS_FOCUSABLE = `:has(${FOCUSABLE})`;

// Each pool puts every element on the page into a state at once, so one read covers them all.
// Later entries replace earlier ones on the elements they match.
const POOLS = {
  hover: [['*', ['hover']]],
  // Only what can take focus gets it, because forcing it on a wrapper draws a focus ring no
  // visitor could ever see. Pressed styles rarely touch what focus styles do, and sharing a
  // read saves one per page.
  'focus and press': [
    ['*', ['active']],
    [HOLDS_FOCUSABLE, ['active', 'focus-within']],
    [`${FOCUSABLE}:not(${HOLDS_FOCUSABLE})`, ['active', 'focus', 'focus-visible', 'focus-within']],
  ],
  // One element has focus at a time, so a container and what's inside it get separate reads.
  // Together, the link's own focus style hides what the container's does to it.
  'focus on containers': [
    [HOLDS_FOCUSABLE, ['focus-within']],
    [`${FOCUSABLE}${HOLDS_FOCUSABLE}`, ['focus', 'focus-visible', 'focus-within']],
  ],
} satisfies Record<string, Array<[selector: string, classes: string[]]>>;

/** Playwright's private way to make protocol calls without recording each one. */
interface CallGrouping {
  _wrapApiCall<T>(calls: () => Promise<T>, options: { internal: boolean }): Promise<T>;
}

/**
 * What pixels can't show about how a page responds to a visitor: its cursors, whether clicks reach
 * an element, and its transitions and animations. Values are counted without naming elements, so
 * markup can change around them, and an inherited cursor or pointer-events value isn't counted
 * again. Runs in the page.
 */
function interactionStyles() {
  const counts = new Map<string, number>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  const record = (
    style: CSSStyleDeclaration,
    parent: CSSStyleDeclaration | undefined,
    on: string,
  ) => {
    const lines: string[] = [];

    for (const property of ['cursor', 'pointer-events']) {
      const value = style.getPropertyValue(property);

      if (value !== (parent?.getPropertyValue(property) ?? 'auto')) {
        lines.push(`${property}: ${value}`);
      }
    }

    if (/[1-9]/.test(style.transitionDuration + style.transitionDelay)) {
      lines.push(`transition: ${style.transition}`);
    }

    if (style.animationName !== 'none') {
      lines.push(`animation: ${style.animation}`);
    }

    for (const line of lines) {
      counts.set(`${on}${line}`, (counts.get(`${on}${line}`) ?? 0) + 1);
    }
  };

  for (const element of document.querySelectorAll('*')) {
    if (!element.checkVisibility()) {
      continue;
    }

    const style = getComputedStyle(element);

    styles.set(element, style);
    record(style, element.parentElement ? styles.get(element.parentElement) : undefined, '');

    for (const pseudo of ['::before', '::after']) {
      const pseudoStyle = getComputedStyle(element, pseudo);

      if (!['none', 'normal'].includes(pseudoStyle.content)) {
        record(pseudoStyle, style, `${pseudo} `);
      }
    }
  }

  return [...counts]
    .map(([line, count]) => `${line} on ${count} ${count === 1 ? 'element' : 'elements'}\n`)
    .sort()
    .join('');
}

export function readInteraction(page: Page) {
  return page.evaluate(interactionStyles);
}

// Keep one document for the whole walk, because Chromium files forced states under node ids
// and a new document's ids can't clear them.
async function forcer(page: Page, cdp: CDPSession) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const set = async (selector: string, classes: string[]) => {
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });

    const forceAll = () =>
      Promise.all(
        nodeIds.map((nodeId) =>
          cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes }),
        ),
      );

    // Playwright Test records every call as a step, and one page makes thousands of these.
    // A Playwright release without this private method fails here instead of slowing down.
    // SAFETY: CDPSession inherits _wrapApiCall from Playwright's ChannelOwner.
    await (cdp as CDPSession & CallGrouping)._wrapApiCall(forceAll, { internal: true });

    return nodeIds.length;
  };

  return {
    /** Returns how many elements the last entry matched. */
    apply: async (pool: Array<[string, string[]]>) => {
      let matched = 0;

      // Chromium doesn't cull an element while its transform is transitioning, so what's
      // forced could stay in the recording of a scroll position far from it.
      await page.evaluate(() => {
        const style = document.createElement('style');

        style.id = 'stet-no-transitions';
        style.textContent = '*, *::before, *::after { transition: none !important }';
        document.head.append(style);
      });

      for (const [selector, classes] of pool) {
        matched = await set(selector, classes);
      }

      return matched;
    },
    clear: async () => {
      await set('*', []);
      // Applying the cleared state first keeps it from transitioning back.
      await page.evaluate(() => {
        void document.documentElement.offsetHeight;
        document.querySelector('#stet-no-transitions')?.remove();
      });
    },
  };
}

interface Control {
  element: HTMLElement;
  how: string;
  kind: string;
  name: string;
}

/** Helpers that live in the page for the length of the walk. */
interface Walk {
  listening: Map<HTMLElement, Set<string>>;
  driven: Set<Element>;
  found: Set<Element>;
  name: (element: Element) => string;
  shown: (element: Element) => boolean;
  controls: (before?: Shown) => Control[];
  everythingShown: () => Shown;
  press: (controls: Control[]) => void;
  release: (controls: Control[], openBefore: Set<Element>) => void;
  holdTogether: (controls: Control[], before: Shown) => boolean;
  revealedControls: (before: Shown) => boolean;
}

/** What was visible before a press, and how much room each element took up. */
type Shown = Map<Element, number>;

declare global {
  interface Window {
    stetWalk: Walk;
  }
}

function installWalk() {
  // Pressing things must not leave the page.
  window.navigation.addEventListener('navigate', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
  });

  window.open = () => null;

  const HOVERS = ['mouseenter', 'mouseover', 'pointerenter'];
  const LEAVES = new Map([
    ['mouseenter', 'mouseleave'],
    ['mouseover', 'mouseout'],
    ['pointerenter', 'pointerleave'],
  ]);
  const shown = (element: Element) =>
    element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const room = (element: Element) => {
    const box = element.getBoundingClientRect();

    return box.width * box.height;
  };

  // A panel collapsed with height 0 counts as visible, along with everything inside it,
  // so it has to be judged by the room it took up.
  const appeared = (element: Element, before: Shown) =>
    shown(element) && !before.get(element) && room(element) > 0;
  const appearedInside = (element: Element, before: Shown) => {
    for (
      let current: Element | null = element;
      current && current !== document.body;
      current = current.parentElement
    ) {
      if (appeared(current, before)) {
        return true;
      }
    }

    return false;
  };

  const name = (element: Element) =>
    (
      element.getAttribute('aria-label') ||
      element.textContent ||
      element.getAttribute('title') ||
      element.querySelector('img')?.alt ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  const fire = (control: Control, type: string) =>
    control.element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: control.how === 'mouseover',
        cancelable: true,
        view: window,
      }),
    );
  // Links that go somewhere and form fields do what their markup says, and pressing one
  // wouldn't reveal anything to compare.
  const leavesThePage = (element: Element) => {
    if (element.matches('[type=submit],[type=reset],input,select,textarea')) {
      return true;
    }

    const submitsForm =
      element instanceof HTMLButtonElement && Boolean(element.form) && element.type === 'submit';

    if (submitsForm) {
      return true;
    }

    return (
      element instanceof HTMLAnchorElement &&
      !/^#|^$/.test(element.getAttribute('href') ?? '') &&
      !element.matches('[role=tab],[aria-expanded],[aria-controls]')
    );
  };

  window.stetWalk = {
    listening: new Map(),
    driven: new Set(),
    found: new Set(),
    name,
    shown,

    // With `before`, only what a press revealed, so a nested control runs while what reveals
    // it is still open.
    controls(before) {
      const found = new Map<Element, Control>();
      const add = (element: HTMLElement, how: string, kind: string) => {
        const usable =
          shown(element) &&
          !element.matches('html,body,[disabled]') &&
          !element.closest('[inert]') &&
          !this.driven.has(element) &&
          (!before || appearedInside(element, before));

        if (usable && !found.has(element) && (how !== 'click' || !leavesThePage(element))) {
          found.set(element, { element, how, kind, name: name(element) });
          this.found.add(element);
        }
      };

      document.querySelectorAll('summary').forEach((element) => add(element, 'click', 'details'));
      document
        .querySelectorAll<HTMLElement>('[role=tab]')
        .forEach((element) => add(element, 'click', 'tab'));
      document
        .querySelectorAll<HTMLElement>('[aria-expanded="false"],[aria-controls]')
        .forEach((element) => {
          // Some menus put aria-expanded on a list item and open on hover, which clicking it
          // wouldn't do.
          if (
            element.matches('button,summary,a,[role=button],[tabindex]') ||
            this.listening.get(element)?.has('click')
          ) {
            add(
              element,
              'click',
              element.getAttribute('aria-expanded') === 'false' ? 'disclosure' : 'control',
            );
          }
        });
      document
        .querySelectorAll<HTMLElement>(
          '[popovertarget],[commandfor],[aria-haspopup=dialog],[data-bs-toggle],[data-toggle]',
        )
        .forEach((element) => add(element, 'click', 'control'));

      for (const [element, types] of this.listening) {
        const hover = HOVERS.find((type) => types.has(type));

        if (hover) {
          add(element, hover, 'hover');
        }

        if (types.has('click')) {
          add(element, 'click', 'control');
        }
      }

      // Pressing Close first would hide everything else that was just revealed.
      const closes = ({ element, name }: Control) =>
        element.matches('[command=close],[command=hide-popover],[popovertargetaction=hide]') ||
        /^(close|dismiss|cancel)\b/i.test(name);

      return [...found.values()].sort((a, b) => Number(closes(a)) - Number(closes(b)));
    },

    everythingShown: () =>
      new Map(
        [...document.querySelectorAll('body *')]
          .filter(shown)
          .map((element) => [element, room(element)]),
      ),

    press(controls) {
      for (const control of controls) {
        if (control.how === 'click') {
          control.element.click();
        } else {
          fire(control, control.how);
        }
      }
    },

    // Put the page back: leave what was hovered, press what's still expanded again,
    // and close what opened.
    release(controls, openBefore) {
      for (const control of controls) {
        const leave = LEAVES.get(control.how);

        if (leave) {
          fire(control, leave);
        } else if (
          control.element.getAttribute('aria-expanded') === 'true' ||
          (control.kind === 'details' && control.element.closest('details')?.open)
        ) {
          control.element.click();
        }
      }

      document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((dialog) => {
        if (!openBefore.has(dialog)) {
          dialog.close();
        }
      });
      document.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach((popover) => {
        if (!openBefore.has(popover)) {
          popover.hidePopover();
        }
      });
    },

    // Controls share a read only if they all stayed on and what they revealed doesn't overlap,
    // because one could hide another.
    holdTogether(controls, before) {
      const on = controls.every(
        (control) =>
          control.element.getAttribute('aria-expanded') !== 'false' &&
          control.element.getAttribute('aria-selected') !== 'false',
      );
      const fresh = new Set(
        [...document.querySelectorAll('body *')].filter((element) => appeared(element, before)),
      );
      const boxes = [...fresh]
        .filter((element) => !element.parentElement || !fresh.has(element.parentElement))
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width && box.height);
      const overlaps = boxes.some((a, index) =>
        boxes
          .slice(index + 1)
          .some(
            (b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
          ),
      );

      return on && !overlaps;
    },

    revealedControls: (before) =>
      [
        ...document.querySelectorAll(
          'a[href],button,summary,input:not([type=hidden]),select,textarea',
        ),
      ].some((element) => shown(element) && appearedInside(element, before)),
  };
}

// One call lists every listener on the page, which finds controls that have no ARIA at all.
async function findListeners(page: Page, cdp: CDPSession) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
    // SAFETY: Evaluating document.documentElement returns a remote DOM object.
    objectId: result.objectId!,
    depth: -1,
    pierce: true,
  });

  const controlListeners = listeners.filter(({ type, backendNodeId }) => {
    const drivesControl = ['click', 'mouseenter', 'mouseover', 'pointerenter'].includes(type);

    return drivesControl && backendNodeId;
  });

  for (const listener of controlListeners) {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: listener.backendNodeId });

    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function (type) {
        if (this.nodeType === 1) {
          const seen = window.stetWalk.listening;
          seen.set(this, (seen.get(this) ?? new Set()).add(type));
        }
      }`,
      arguments: [{ value: listener.type }],
    });
  }
}

// Details stay in flow, so they can't hide each other, and the pools then reach what's
// inside them. An exclusive group would allow only one, so it's lifted while they're open.
function openClosedDetails() {
  let total = 0;

  for (let closed = 1; closed; total += closed) {
    const summaries = [
      ...document.querySelectorAll<HTMLElement>('details:not([open]) > summary'),
    ].filter((summary) => window.stetWalk.shown(summary));

    closed = summaries.length;

    for (const summary of summaries) {
      // SAFETY: The selector matches only summaries that are direct children of details.
      const details = summary.parentElement as HTMLDetailsElement;

      details.dataset.stetName = details.name;
      details.name = '';
      summary.click();
      window.stetWalk.driven.add(summary);
    }
  }

  return total;
}

async function closeDetails(page: Page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll<HTMLDetailsElement>(
      'details[data-stet-name]',
    )) {
      details.open = false;
      // SAFETY: The selector requires the data-stet-name attribute.
      details.name = details.dataset.stetName!;
      delete details.dataset.stetName;
    }
  });
  await settle(page);
}

function labelFor(group: Array<Pick<Control, 'how' | 'kind' | 'name'>>) {
  const first = group[0];
  let verb = 'hovering';

  if (first.kind === 'tab') {
    verb = 'tab';
  } else if (first.how === 'click') {
    verb = 'pressing';
  }

  return `${verb} "${first.name}"${group.length > 1 ? ` and ${group.length - 1} more` : ''}`;
}

// Tabs replace each other within a list and don't touch other lists, so a read can take one
// from each.
function buildTabRounds() {
  const lists = new Map<Element | null, Control[]>();

  for (const control of window.stetWalk.controls().filter(({ kind }) => kind === 'tab')) {
    const list = control.element.closest('[role=tablist]') ?? control.element.parentElement;

    lists.set(list, [...(lists.get(list) ?? []), control]);
  }

  const longest = Math.max(0, ...[...lists.values()].map((list) => list.length));

  return Array.from({ length: longest }, (_, index) =>
    [...lists.values()].map((list) => list[index]).filter((control) => control !== undefined),
  );
}

/**
 * Puts the page into every state it can reach and reads each one. Timers run only when told
 * to, so nothing here waits on the real clock.
 */
export async function walkStates(
  page: Page,
  readPaint: () => Promise<PaintRecord>,
  driveControls: boolean,
) {
  const cdp = await page.context().newCDPSession(page);
  const pools: State[] = [];
  const controls: State[] = [];
  let reads = 0;

  const read = async (into: State[], group: State['group'], label: string) => {
    into.push({
      label,
      group,
      paint: await readPaint(),
      aria: `${await page.locator('body').ariaSnapshot()}\n`,
      interaction: await readInteraction(page),
    });
  };

  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await page.evaluate(installWalk);

  const forced = await forcer(page, cdp);
  const atLoad = await page.evaluateHandle(() => window.stetWalk.everythingShown());
  const opened = await page.evaluate(openClosedDetails);

  if (opened) {
    await settle(page);
    await read(pools, 'pool', `all ${opened} closed details open`);
  }

  for (const [label, pool] of Object.entries(POOLS)) {
    // A page that hides focus rings after mouse input, as some themes do, takes the clicks that
    // opened details for a mouse. A real Tab makes the focus reads keyboard use, and the forced
    // states decide what has focus.
    if (label === 'focus and press') {
      await page.keyboard.press('Tab');
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }

    const matched = await forced.apply(pool);

    // A page with no focusable containers has nothing to show in that read, and it's the only
    // one that can be empty.
    if (matched || label !== 'focus on containers') {
      await settle(page);
      await read(pools, 'pool', `${label} on every element`);
    }

    await forced.clear();
  }

  if (!driveControls) {
    await closeDetails(page);

    return { pools, controls, notDriven: [] };
  }

  await findListeners(page, cdp);

  const drive = async (group: JSHandle<Control[]>) => {
    const facts = await group.evaluate((list) =>
      list.map(({ how, kind, name }) => ({ how, kind, name })),
    );

    if (!facts.length || reads >= MOST_CONTROL_READS) {
      return;
    }

    const before = await page.evaluateHandle(() => window.stetWalk.everythingShown());
    const openBefore = await page.evaluateHandle(
      () => new Set(document.querySelectorAll('dialog[open],[popover]:popover-open')),
    );
    const release = async () => {
      await group.evaluate((list, open) => window.stetWalk.release(list, open), openBefore);
      await settle(page);
    };

    await group.evaluate((list) => window.stetWalk.press(list));
    await settle(page);

    const heldTogether =
      facts.length === 1 ||
      (await group.evaluate(
        (list, shownBefore) => window.stetWalk.holdTogether(list, shownBefore),
        before,
      ));

    if (!heldTogether) {
      const half = Math.ceil(facts.length / 2);

      await release();
      await drive(await group.evaluateHandle((list, half) => list.slice(0, half), half));
      await drive(await group.evaluateHandle((list, half) => list.slice(half), half));

      return;
    }

    const label = labelFor(facts);

    reads++;
    await read(controls, 'control', label);
    // Counted only once read, so a control the read limit cuts off is reported as not driven.
    await group.evaluate((list) =>
      list.forEach(({ element }) => window.stetWalk.driven.add(element)),
    );

    const revealedControls = await page.evaluate(
      (shownBefore) => window.stetWalk.revealedControls(shownBefore),
      before,
    );

    if (revealedControls) {
      reads++;
      await forced.apply(POOLS.hover);
      await settle(page);
      await read(controls, 'control', `${label}, then hover on every element`);
      await forced.clear();
      await settle(page);
    }

    await explore(before);
    await release();
  };

  const explore = async (before?: JSHandle<Shown>) => {
    while (reads < MOST_CONTROL_READS) {
      const pending = await page.evaluateHandle(
        (before) => window.stetWalk.controls(before),
        before,
      );
      const disclosures = await pending.evaluateHandle((list) =>
        list.filter(({ kind }) => kind === 'disclosure'),
      );
      const hasDisclosures = await disclosures.evaluate((list) => list.length > 0);
      const next = hasDisclosures
        ? disclosures
        : await pending.evaluateHandle((list) => list.slice(0, 1));

      if (!(await next.evaluate((list) => list.length))) {
        return;
      }

      await drive(next);
    }
  };

  // What was inside closed details needs pressing while they're open.
  await explore(atLoad);
  await closeDetails(page);

  const rounds = await page.evaluateHandle(buildTabRounds);

  for (let round = 0; round < (await rounds.evaluate((all) => all.length)); round++) {
    await drive(await rounds.evaluateHandle((all, round) => all[round], round));
  }

  // Back to each list's first tab, so what follows starts from how the page loaded.
  await rounds.evaluate((all) => all[0]?.forEach((control) => control.element.click()));
  await settle(page);
  await explore();

  return {
    pools,
    controls,
    notDriven: await page.evaluate(() =>
      [...window.stetWalk.found]
        .filter((element) => !window.stetWalk.driven.has(element))
        .map(window.stetWalk.name),
    ),
  };
}

function stateHash({ paint, aria, interaction }: State) {
  return createHash('sha1')
    .update(paintSummary(paint))
    .update(aria)
    .update(interaction)
    .digest('hex');
}

/**
 * The verdict for a set of states, in an order that doesn't depend on how the markup lists
 * its controls.
 */
export function stateHashes(states: State[]) {
  return `${states.map(stateHash).sort().join('\n')}\n`;
}

/** Names the controls, or failing that the smallest elements, at these places on the page. */
export function namesAt(page: Page, points: Array<{ x: number; y: number }>) {
  return page.evaluate((points) => {
    const boxes = [...document.querySelectorAll('body *')]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width && box.height);
    const names = new Set<string>();

    for (const { x, y } of points) {
      const smallest = boxes
        .filter(({ box }) => {
          const withinWidth = x >= box.left + scrollX && x <= box.right + scrollX;

          return withinWidth && y >= box.top + scrollY && y <= box.bottom + scrollY;
        })
        .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0]?.element;

      if (smallest) {
        const selector =
          'a,button,summary,input,select,textarea,[role=button],[role=tab],' +
          'h1,h2,h3,h4,h5,h6,li,p,figure';
        const named = smallest.closest(selector) ?? smallest;
        const text = (named.getAttribute('aria-label') || named.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40);

        names.add(`${named.tagName.toLowerCase()} "${text}"`);
      }
    }

    return [...names].slice(0, 6);
  }, points);
}

/** Say which states differ. This only explains. The comparison of the hashes decides. */
export async function explainStates(
  page: Page,
  saved: { rest: PaintRecord; states: State[] },
  now: State[],
  rest: PaintRecord,
) {
  const savedHashes = new Set(saved.states.map(stateHash));
  const nowHashes = new Set(now.map(stateHash));
  const changes: string[][] = [];

  for (const before of saved.states.filter((state) => !nowHashes.has(stateHash(state)))) {
    const after = now.find(({ label }) => label === before.label);

    if (!after) {
      changes.push([`The state "${before.label}" is gone.`]);
    } else if (
      paintSummary(after.paint) === paintSummary(rest) &&
      paintSummary(before.paint) !== paintSummary(saved.rest)
    ) {
      changes.push([`"${after.label}" no longer changes anything on the page.`]);
    } else {
      const text = lineChanges(before.aria.split('\n'), after.aria.split('\n')).slice(0, 8);
      const names = await namesAt(page, changedPoints(before.paint, after.paint));
      const lines = [`In the state "${after.label}":`];

      if (names.length) {
        lines.push(`  Near ${names.join(', ')}.`);
      }

      if (paintSummary(after.paint) !== paintSummary(before.paint)) {
        lines.push(...explainPaint(before.paint, after.paint).map((line) => `  ${line}`));
      }

      lines.push(
        ...text,
        ...lineChanges(before.interaction.split('\n'), after.interaction.split('\n')).slice(0, 8),
      );
      changes.push(lines);
    }
  }

  const added = now.filter(
    (state) =>
      !savedHashes.has(stateHash(state)) &&
      !saved.states.some(({ label }) => label === state.label),
  );

  for (const { label } of added) {
    changes.push([`The state "${label}" is new.`]);
  }

  // A change to the whole page shows in every state, and the first few say all there is to say.
  const explanation = changes.slice(0, 3).flat();

  if (changes.length > 3) {
    explanation.push(`${changes.length - 3} more states changed.`);
  }

  return explanation;
}
