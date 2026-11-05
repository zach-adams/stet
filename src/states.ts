import { createHash } from 'node:crypto';
import { diff } from 'node:util';
import type { CDPSession, JSHandle, Page } from '@playwright/test';
import { settle } from './capture.ts';
import { changedPoints, explainPaint, paintSummary, type PaintRecord } from './paint.ts';

export type State = { label: string; group: 'pool' | 'control'; paint: PaintRecord; aria: string };

// A page with more than this is rare, and the report says how many weren't driven.
const MOST_CONTROL_READS = 60;

const FOCUSABLE = ':is(a[href],button,input,select,textarea,summary,[tabindex],[contenteditable])';
const HOLDS_FOCUSABLE = `:has(${FOCUSABLE})`;

// Each pool puts every element on the page into a state at once, so one read covers them all. Later entries replace earlier ones on the elements they match.
const POOLS: Record<string, [selector: string, classes: string[]][]> = {
  hover: [['*', ['hover']]],
  // Only what can take focus gets it, because forcing it on a wrapper draws a focus ring no visitor could ever see. Pressed styles rarely touch what focus styles do, and sharing a read saves one per page.
  'focus and press': [
    ['*', ['active']],
    [HOLDS_FOCUSABLE, ['active', 'focus-within']],
    [`${FOCUSABLE}:not(${HOLDS_FOCUSABLE})`, ['active', 'focus', 'focus-visible', 'focus-within']],
  ],
  // One element has focus at a time, so a container and what's inside it get separate reads. Together, the link's own focus style hides what the container's does to it.
  'focus on containers': [
    [HOLDS_FOCUSABLE, ['focus-within']],
    [`${FOCUSABLE}${HOLDS_FOCUSABLE}`, ['focus', 'focus-visible', 'focus-within']],
  ],
};

// Keep one document for the whole walk, because Chromium files forced states under node ids and a new document's ids can't clear them.
async function forcer(page: Page, cdp: CDPSession) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const set = async (selector: string, classes: string[]) => {
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });

    await Promise.all(nodeIds.map((nodeId) => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })));

    return nodeIds.length;
  };

  return {
    /** Returns how many elements the last entry matched. */
    apply: async (pool: [string, string[]][]) => {
      let matched = 0;

      // Chromium doesn't cull an element while its transform is transitioning, so what's forced could stay in the recording of a scroll position far from it.
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

type Control = { element: HTMLElement; how: string; kind: string; name: string };

/** Helpers that live in the page for the length of the walk. */
type Walk = {
  listening: Map<Element, Set<string>>;
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
};

/** What was visible before a press, and how much room each element took up. */
type Shown = Map<Element, number>;

declare global {
  interface Window {
    stetWalk: Walk;
  }
}

function installWalk() {
  // Pressing things must not leave the page.
  (window as unknown as { navigation: EventTarget }).navigation.addEventListener('navigate', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
  });

  window.open = () => null;

  const HOVERS = ['mouseenter', 'mouseover', 'pointerenter'];
  const LEAVES: Record<string, string> = { mouseenter: 'mouseleave', mouseover: 'mouseout', pointerenter: 'pointerleave' };
  const shown = (element: Element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const room = (element: Element) => {
    const box = element.getBoundingClientRect();

    return box.width * box.height;
  };
  // A panel collapsed with height 0 counts as visible, along with everything inside it, so it has to be judged by the room it took up.
  const appeared = (element: Element, before: Shown) => shown(element) && !before.get(element) && room(element) > 0;
  const appearedInside = (element: Element, before: Shown) => {
    for (let current: Element | null = element; current && current !== document.body; current = current.parentElement) {
      if (appeared(current, before)) {
        return true;
      }
    }

    return false;
  };
  const name = (element: Element) =>
    (element.getAttribute('aria-label') || element.textContent || element.getAttribute('title') || element.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const fire = (control: Control, type: string) =>
    control.element.dispatchEvent(new MouseEvent(type, { bubbles: control.how === 'mouseover', cancelable: true, view: window }));
  // Links that go somewhere and form fields do what their markup says, and pressing one wouldn't reveal anything to compare.
  const leavesThePage = (element: Element) =>
    element.matches('[type=submit],[type=reset],input,select,textarea') ||
    (element instanceof HTMLButtonElement && Boolean(element.form) && element.type === 'submit') ||
    (element instanceof HTMLAnchorElement && !/^#|^$/.test(element.getAttribute('href') ?? '') && !element.matches('[role=tab],[aria-expanded],[aria-controls]'));

  window.stetWalk = {
    listening: new Map(),
    driven: new Set(),
    found: new Set(),
    name,
    shown,

    // With `before`, only what a press revealed, so a nested control runs while what reveals it is still open.
    controls(before) {
      const found = new Map<Element, Control>();
      const add = (element: Element, how: string, kind: string) => {
        const usable = shown(element) && !element.matches('html,body,[disabled]') && !element.closest('[inert]') && !this.driven.has(element) && (!before || appearedInside(element, before));

        if (usable && !found.has(element) && (how !== 'click' || !leavesThePage(element))) {
          found.set(element, { element: element as HTMLElement, how, kind, name: name(element) });
          this.found.add(element);
        }
      };

      document.querySelectorAll('summary').forEach((element) => add(element, 'click', 'details'));
      document.querySelectorAll('[role=tab]').forEach((element) => add(element, 'click', 'tab'));
      document.querySelectorAll('[aria-expanded="false"],[aria-controls]').forEach((element) => {
        // Some menus put aria-expanded on a list item and open on hover, which clicking it wouldn't do.
        if (element.matches('button,summary,a,[role=button],[tabindex]') || this.listening.get(element)?.has('click')) {
          add(element, 'click', element.getAttribute('aria-expanded') === 'false' ? 'disclosure' : 'control');
        }
      });
      document.querySelectorAll('[popovertarget],[commandfor],[aria-haspopup=dialog],[data-bs-toggle],[data-toggle]').forEach((element) => add(element, 'click', 'control'));

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
        element.matches('[command=close],[command=hide-popover],[popovertargetaction=hide]') || /^(close|dismiss|cancel)\b/i.test(name);

      return [...found.values()].sort((a, b) => Number(closes(a)) - Number(closes(b)));
    },

    everythingShown: () => new Map([...document.querySelectorAll('body *')].filter(shown).map((element) => [element, room(element)])),

    press(controls) {
      for (const control of controls) {
        if (control.how === 'click') {
          control.element.click();
        } else {
          fire(control, control.how);
        }
      }
    },

    // Put the page back: leave what was hovered, press what's still expanded again, and close what opened.
    release(controls, openBefore) {
      for (const control of controls) {
        if (LEAVES[control.how]) {
          fire(control, LEAVES[control.how]!);
        } else if (control.element.getAttribute('aria-expanded') === 'true' || (control.kind === 'details' && control.element.closest('details')?.open)) {
          control.element.click();
        }
      }

      document.querySelectorAll('dialog[open]').forEach((dialog) => {
        if (!openBefore.has(dialog)) {
          (dialog as HTMLDialogElement).close();
        }
      });
      document.querySelectorAll('[popover]:popover-open').forEach((popover) => {
        if (!openBefore.has(popover)) {
          (popover as HTMLElement).hidePopover();
        }
      });
    },

    // Controls share a read only if they all stayed on and what they revealed doesn't overlap, because one could hide another.
    holdTogether(controls, before) {
      const on = controls.every((control) => control.element.getAttribute('aria-expanded') !== 'false' && control.element.getAttribute('aria-selected') !== 'false');
      const fresh = new Set([...document.querySelectorAll('body *')].filter((element) => appeared(element, before)));
      const boxes = [...fresh]
        .filter((element) => !fresh.has(element.parentElement!))
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width && box.height);
      const overlaps = boxes.some((a, index) => boxes.slice(index + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));

      return on && !overlaps;
    },

    revealedControls: (before) =>
      [...document.querySelectorAll('a[href],button,summary,input:not([type=hidden]),select,textarea')].some((element) => shown(element) && appearedInside(element, before)),
  };
}

// One call lists every listener on the page, which finds controls that have no ARIA at all.
async function findListeners(page: Page, cdp: CDPSession) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId!, depth: -1, pierce: true });

  for (const listener of listeners.filter(({ type, backendNodeId }) => ['click', 'mouseenter', 'mouseover', 'pointerenter'].includes(type) && backendNodeId)) {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: listener.backendNodeId! });

    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId!,
      functionDeclaration: 'function (type) { if (this.nodeType === 1) { const seen = window.stetWalk.listening; seen.set(this, (seen.get(this) ?? new Set()).add(type)); } }',
      arguments: [{ value: listener.type }],
    });
  }
}

/** Puts the page into every state it can reach and reads each one. Timers run only when told to, so nothing here waits on the real clock. */
export async function walkStates(page: Page, readPaint: () => Promise<PaintRecord>, driveControls: boolean) {
  const cdp = await page.context().newCDPSession(page);
  const pools: State[] = [];
  const controls: State[] = [];
  let reads = 0;

  const read = async (into: State[], label: string) => {
    into.push({ label, group: into === pools ? 'pool' : 'control', paint: await readPaint(), aria: `${await page.locator('body').ariaSnapshot()}\n` });
  };

  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await page.evaluate(installWalk);

  const forced = await forcer(page, cdp);
  const atLoad = await page.evaluateHandle(() => window.stetWalk.everythingShown());

  // Details stay in flow, so they can't hide each other, and the pools below then reach what's inside them. An exclusive group would allow only one, so it's lifted while they're open.
  const opened = await page.evaluate(() => {
    let total = 0;

    for (let closed = 1; closed; total += closed) {
      const summaries = [...document.querySelectorAll('details:not([open]) > summary')].filter((summary) => window.stetWalk.shown(summary)) as HTMLElement[];

      closed = summaries.length;

      for (const summary of summaries) {
        const details = summary.parentElement as HTMLDetailsElement;

        details.dataset.stetName = details.name;
        details.name = '';
        summary.click();
        window.stetWalk.driven.add(summary);
      }
    }

    return total;
  });

  if (opened) {
    await settle(page);
    await read(pools, `all ${opened} closed details open`);
  }

  for (const [label, pool] of Object.entries(POOLS)) {
    const matched = await forced.apply(pool);

    // A page with no focusable containers has nothing to show in that read, and it's the only one that can be empty.
    if (matched || label !== 'focus on containers') {
      await settle(page);
      await read(pools, `${label} on every element`);
    }

    await forced.clear();
  }

  const close = async () => {
    await page.evaluate(() => {
      for (const details of document.querySelectorAll<HTMLDetailsElement>('details[data-stet-name]')) {
        details.open = false;
        details.name = details.dataset.stetName!;
        delete details.dataset.stetName;
      }
    });
    await settle(page);
  };

  if (!driveControls) {
    await close();

    return { pools, controls, notDriven: [] as string[] };
  }

  await findListeners(page, cdp);

  const labelFor = (group: Pick<Control, 'how' | 'kind' | 'name'>[]) => {
    const first = group[0]!;
    const verb = first.kind === 'tab' ? 'tab' : first.how === 'click' ? 'pressing' : 'hovering';

    return `${verb} "${first.name}"${group.length > 1 ? ` and ${group.length - 1} more` : ''}`;
  };

  const drive = async (group: JSHandle<Control[]>) => {
    const facts = await group.evaluate((list) => list.map(({ how, kind, name }) => ({ how, kind, name })));

    if (!facts.length || reads >= MOST_CONTROL_READS) {
      return;
    }

    const before = await page.evaluateHandle(() => window.stetWalk.everythingShown());
    const openBefore = await page.evaluateHandle(() => new Set(document.querySelectorAll('dialog[open],[popover]:popover-open')));
    const release = async () => {
      await group.evaluate((list, open) => window.stetWalk.release(list, open), openBefore);
      await settle(page);
    };

    await group.evaluate((list) => window.stetWalk.press(list));
    await settle(page);

    if (facts.length > 1 && !(await group.evaluate((list, shownBefore) => window.stetWalk.holdTogether(list, shownBefore), before))) {
      const half = Math.ceil(facts.length / 2);

      await release();
      await drive(await group.evaluateHandle((list, half) => list.slice(0, half), half));
      await drive(await group.evaluateHandle((list, half) => list.slice(half), half));

      return;
    }

    const label = labelFor(facts);

    reads++;
    await read(controls, label);
    // Counted only once read, so a control the read limit cuts off is reported as not driven.
    await group.evaluate((list) => list.forEach(({ element }) => window.stetWalk.driven.add(element)));

    if (await page.evaluate((shownBefore) => window.stetWalk.revealedControls(shownBefore), before)) {
      reads++;
      await forced.apply(POOLS.hover!);
      await settle(page);
      await read(controls, `${label}, then hover on every element`);
      await forced.clear();
      await settle(page);
    }

    await explore(before);
    await release();
  };

  const explore = async (before?: JSHandle<Shown>) => {
    while (reads < MOST_CONTROL_READS) {
      const pending = await page.evaluateHandle((before) => window.stetWalk.controls(before), before);
      const disclosures = await pending.evaluateHandle((list) => list.filter(({ kind }) => kind === 'disclosure'));
      const hasDisclosures = await disclosures.evaluate((list) => list.length > 0);
      const next = hasDisclosures ? disclosures : await pending.evaluateHandle((list) => list.slice(0, 1));

      if (!(await next.evaluate((list) => list.length))) {
        return;
      }

      await drive(next);
    }
  };

  // What was inside closed details needs pressing while they're open.
  await explore(atLoad);
  await close();

  // Tabs replace each other within a list and don't touch other lists, so a read can take one from each.
  const rounds = await page.evaluateHandle(() => {
    const lists = new Map<Element, Control[]>();

    for (const control of window.stetWalk.controls().filter(({ kind }) => kind === 'tab')) {
      const list = control.element.closest('[role=tablist]') ?? control.element.parentElement!;

      lists.set(list, [...(lists.get(list) ?? []), control]);
    }

    const longest = Math.max(0, ...[...lists.values()].map((list) => list.length));

    return Array.from({ length: longest }, (_, index) => [...lists.values()].map((list) => list[index]).filter((control) => control !== undefined));
  });

  for (let round = 0; round < (await rounds.evaluate((all) => all.length)); round++) {
    await drive(await rounds.evaluateHandle((all, round) => all[round]!, round));
  }

  // Back to each list's first tab, so what follows starts from how the page loaded.
  await rounds.evaluate((all) => all[0]?.forEach((control) => control.element.click()));
  await settle(page);
  await explore();

  return { pools, controls, notDriven: await page.evaluate(() => [...window.stetWalk.found].filter((element) => !window.stetWalk.driven.has(element)).map(window.stetWalk.name)) };
}

const stateHash = ({ paint, aria }: State) => createHash('sha1').update(paintSummary(paint)).update(aria).digest('hex');

/** The verdict for a set of states, in an order that doesn't depend on how the markup lists its controls. */
export const stateHashes = (states: State[]) => `${states.map(stateHash).sort().join('\n')}\n`;

/** Names the controls, or failing that the smallest elements, at these places on the page. */
export function namesAt(page: Page, points: { x: number; y: number }[]) {
  return page.evaluate((points) => {
    const boxes = [...document.querySelectorAll('body *')].map((element) => ({ element, box: element.getBoundingClientRect() })).filter(({ box }) => box.width && box.height);
    const names = new Set<string>();

    for (const { x, y } of points) {
      const smallest = boxes
        .filter(({ box }) => x >= box.left + scrollX && x <= box.right + scrollX && y >= box.top + scrollY && y <= box.bottom + scrollY)
        .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0]?.element;

      if (smallest) {
        const named = smallest.closest('a,button,summary,input,select,textarea,[role=button],[role=tab],h1,h2,h3,h4,h5,h6,li,p,figure') ?? smallest;
        const text = (named.getAttribute('aria-label') || named.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);

        names.add(`${named.tagName.toLowerCase()} "${text}"`);
      }
    }

    return [...names].slice(0, 6);
  }, points);
}

/** Say which states differ. This only explains. The comparison of the hashes decides. */
export async function explainStates(page: Page, saved: { rest: PaintRecord; states: State[] }, now: State[], rest: PaintRecord) {
  const savedHashes = new Set(saved.states.map(stateHash));
  const nowHashes = new Set(now.map(stateHash));
  const changes: string[][] = [];

  for (const before of saved.states.filter((state) => !nowHashes.has(stateHash(state)))) {
    const after = now.find(({ label }) => label === before.label);

    if (!after) {
      changes.push([`The state "${before.label}" is gone.`]);
    } else if (paintSummary(after.paint) === paintSummary(rest) && paintSummary(before.paint) !== paintSummary(saved.rest)) {
      changes.push([`"${after.label}" no longer changes anything on the page.`]);
    } else {
      // Node marks entries from its first argument with 1 and those only in its second with -1.
      const text = diff(after.aria.split('\n'), before.aria.split('\n')).filter(([change]) => change !== 0);
      const names = await namesAt(page, changedPoints(before.paint, after.paint));

      changes.push([
        `In the state "${after.label}":`,
        ...(names.length ? [`  Near ${names.join(', ')}.`] : []),
        ...(paintSummary(after.paint) === paintSummary(before.paint) ? [] : explainPaint(before.paint, after.paint).map((line) => `  ${line}`)),
        ...text.slice(0, 8).map(([change, line]) => `  ${change < 0 ? '-' : '+'} ${line}`),
      ]);
    }
  }

  for (const after of now.filter((state) => !savedHashes.has(stateHash(state)) && !saved.states.some(({ label }) => label === state.label))) {
    changes.push([`The state "${after.label}" is new.`]);
  }

  // A change to the whole page shows in every state, and the first few say all there is to say.
  return [...changes.slice(0, 3).flat(), ...(changes.length > 3 ? [`${changes.length - 3} more states changed.`] : [])];
}
