import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const clean = {
  status: 200,
  assetStatus: 200,
  moving: false,
  wrapped: false,
  headingColor: 'rgb(10, 20, 30)',
  headingMargin: 20,
  image: '#336699',
  thirdPartyImage: '#996633',
  fill: '#663399',
  href: '/about/',
  slide: 'Second slide',
  opacity: 1,
  hoverColor: 'rgb(0, 0, 200)',
  focusRing: 'rgb(0, 0, 200)',
  answer: 'An answer',
  menuOpens: true,
  tabText: 'Second tab',
  behindNestedButton: 'Behind a nested button',
  behindTabButton: 'Behind a button on a tab',
  coveredPanel: 'rgb(0, 0, 0)',
  extraControls: 0,
  behindCustomControl: 'Behind a custom control',
};

type CleanState = typeof clean;

interface FixtureState extends CleanState {
  recoversAfter?: number;
}

let state: FixtureState = { ...clean };
let port = 0;
let writes = 0;
let departures = 0;

function svg(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`;
}

function page() {
  const heading = `<h1 style="color:${state.headingColor};margin-top:${state.headingMargin}px">Heading</h1>`;

  return `<!doctype html><meta name="viewport" content="width=device-width"><title>Fixture</title>
<body style="margin:0;font:18px sans-serif">
${state.wrapped ? `<div>${heading}</div>` : heading}
<img src="/image.svg" width="40" height="40" alt="photo">
<img src="http://127.0.0.1:${port}/third.svg" width="40" height="40" alt="third party">
<img src="/moved.svg" width="40" height="40" alt="redirected to a third party">
<p><a ${state.href ? `href="${state.href}"` : ''}>A link</a></p>
<svg width="40" height="40"><circle cx="20" cy="20" r="20" fill="${state.fill}"/></svg>
<div style="overflow:hidden;width:300px"><div style="display:flex;width:600px;will-change:transform;opacity:${state.opacity}">
<div style="width:300px">First slide</div><div style="width:300px">${state.slide}</div></div></div>
<script src="http://127.0.0.1:${port}/third.js"></script>
${state.moving ? `<script>let n = 0; setInterval(() => { document.querySelector('h1').style.marginTop = ++n + 'px'; }, 16);</script>` : ''}
<style>.cta:hover { color: ${state.hoverColor} } .cta:focus-visible { outline: 3px solid ${state.focusRing} } html[data-input="mouse"] :focus { outline: none } .panel { display: none } .menu.open .panel { display: block }</style>
<p><a class="cta" href="/cta/">Call to action</a></p>
<details name="faq"><summary>First question</summary><p>${state.answer}</p><button id="nested" aria-expanded="false">More</button><p id="nested-text" hidden>${state.behindNestedButton}</p></details>
<details name="faq"><summary>Second question</summary><p>Another answer</p></details>
${state.wrapped ? '<div>' : ''}
<div class="menu"><span>Menu</span><div class="panel"><a href="/sub/">Sub page</a></div></div>
<div role="tablist"><button role="tab" aria-selected="true">One</button><button role="tab" aria-selected="false">Two</button></div>
<div id="tab-panel">First tab</div>
<div id="tab-two" hidden><button id="on-tab" aria-expanded="false">On a tab</button><p id="on-tab-text" hidden>${state.behindTabButton}</p></div>
${state.wrapped ? '</div>' : ''}
<div style="position:relative;height:60px">
<button class="flyout" aria-expanded="false">Flyout one</button><div class="flyout-panel" style="position:absolute;top:30px;left:0;width:200px;height:0;overflow:hidden;background:#fff;color:${state.coveredPanel}">First flyout</div>
<button class="flyout" aria-expanded="false">Flyout two</button><div class="flyout-panel" style="position:absolute;top:30px;left:0;width:200px;height:0;overflow:hidden;background:#eee">Second flyout</div>
</div>
<button id="reveals-custom" aria-expanded="false">Show custom control</button><div id="custom-area" hidden><button id="close-custom">Close</button><div id="custom" role="button" tabindex="0">Custom control</div></div><p id="custom-text" hidden>${state.behindCustomControl}</p>
<button id="saver">Save something</button> <button id="leaver">Go elsewhere</button> <button id="popup">Open a window</button>
${Array.from({ length: state.extraControls }, (_, index) => `<button class="extra">Extra ${index}</button>`).join('')}
<p id="autoplay">Slide 0</p>
<script>
  addEventListener('click', () => { document.documentElement.dataset.input = 'mouse'; }, true);
  addEventListener('keydown', () => { document.documentElement.dataset.input = 'keyboard'; }, true);
  const menu = document.querySelector('.menu');
  ${state.menuOpens ? `menu.addEventListener('mouseenter', () => setTimeout(() => menu.classList.add('open'), 300));` : ''}
  menu.addEventListener('mouseleave', () => setTimeout(() => menu.classList.remove('open'), 300));
  const tabs = document.querySelectorAll('[role=tab]');
  tabs.forEach((tab, index) => tab.addEventListener('click', () => {
    tabs.forEach((other) => other.setAttribute('aria-selected', other === tab));
    document.querySelector('#tab-panel').textContent = index ? ${JSON.stringify(state.tabText)} : 'First tab';
    document.querySelector('#tab-two').hidden = !index;
  }));
  for (const [button, target] of [['#nested', '#nested-text'], ['#on-tab', '#on-tab-text']]) {
    document.querySelector(button).addEventListener('click', (event) => {
      const open = event.target.getAttribute('aria-expanded') === 'false';
      event.target.setAttribute('aria-expanded', open);
      document.querySelector(target).hidden = !open;
    });
  }
  document.querySelectorAll('.flyout').forEach((button) => button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'false';
    button.setAttribute('aria-expanded', open);
    button.nextElementSibling.style.height = open ? '30px' : '0';
  }));
  document.querySelector('#reveals-custom').addEventListener('click', (event) => {
    const open = event.target.getAttribute('aria-expanded') === 'false';
    event.target.setAttribute('aria-expanded', open);
    document.querySelector('#custom-area').hidden = !open;
  });
  document.querySelector('#close-custom').addEventListener('click', () => { document.querySelector('#custom-area').hidden = true; });
  document.querySelector('#custom').addEventListener('click', () => { document.querySelector('#custom-text').hidden = false; });
  document.querySelector('#saver').addEventListener('click', () => fetch('/write', { method: 'POST' }));
  document.querySelector('#leaver').addEventListener('click', () => { location.href = '/departed/'; });
  document.querySelector('#popup').addEventListener('click', () => { window.open('/departed/'); });
  document.querySelectorAll('.extra').forEach((button) => button.addEventListener('click', () => { button.style.color = 'red'; }));
  let slide = 0;
  setInterval(() => { document.querySelector('#autoplay').textContent = 'Slide ' + ++slide; }, 1000);
</script>`;
}

const server = createServer((request, response) => {
  if (request.method === 'POST') {
    writes++;
    response.end();
  } else if (request.url === '/departed/') {
    departures++;
    response.end('Left');
  } else if (request.url === '/image.svg' && state.recoversAfter) {
    state.recoversAfter--;
    response.writeHead(502);
    response.end();
  } else if (request.url === '/image.svg' && state.recoversAfter === 0) {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(svg(state.image));
  } else if (request.url === '/image.svg' || request.url === '/third.svg') {
    response.writeHead(request.url === '/image.svg' ? state.assetStatus : 200, {
      'content-type': 'image/svg+xml',
    });
    response.end(svg(request.url === '/image.svg' ? state.image : state.thirdPartyImage));
  } else if (request.url === '/moved.svg') {
    response.writeHead(302, { location: `http://127.0.0.1:${port}/moved-target.svg` });
    response.end();
  } else if (request.url === '/moved-target.svg') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(svg('#339966'));
  } else if (request.url === '/third.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(`document.body.append('A third-party script ran');`);
  } else {
    let status = 404;

    if (request.url === '/') {
      status = state.status;
    } else if (request.url === '/_home/' || request.url === '/_many/') {
      status = 200;
    }

    response.writeHead(status, { 'content-type': 'text/html' });
    response.end(page());
  }
});

const stateHome = mkdtempSync(join(tmpdir(), 'stet-test-'));
const bin = join(import.meta.dirname, '../bin/stet');

function site() {
  return `http://localhost:${port}`;
}

function stet(...args: string[]) {
  return new Promise<{ status: number; output: string }>((resolve) => {
    execFile(
      bin,
      args,
      { env: { ...process.env, XDG_STATE_HOME: stateHome } },
      (error, stdout, stderr) => {
        resolve({ status: error ? Number(error.code) : 0, output: stdout + stderr });
      },
    );
  });
}

function compare(...args: string[]) {
  return stet('compare', site(), '--size', 'desktop', ...args);
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  // SAFETY: listening on port 0 creates a TCP server, and the listen callback has fired.
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  rmSync(stateHome, { recursive: true, force: true });
});

test('refuses what it can be refused for', async () => {
  const live = await stet('compare', 'https://www.example.com');

  assert.equal(live.status, 2);
  assert.match(live.output, /doesn't look like a local site/);

  const unsaved = await stet('compare', site());

  assert.equal(unsaved.status, 2);
  assert.match(unsaved.output, /no references yet/);
  assert.equal((await stet('compare', 'not-a-url')).status, 2);
});

test('prints its guide for agents', async () => {
  const { status, output } = await stet('skills', 'get', 'core');

  assert.equal(status, 0);
  assert.match(output, /stet compare/);
});

test('saves references, remembers the pages and refuses to replace them unasked', async () => {
  const saved = await stet('save-references', site(), '/', '--size', 'desktop');

  assert.equal(saved.status, 0, saved.output);
  assert.match((await stet('list')).output, new RegExp(`${site()}: /\\n`));
  assert.equal((await stet('save-references', site(), '/', '--size', 'desktop')).status, 2);
});

test('passes when nothing changed and reports what it blocked', async () => {
  const { status, output } = await compare();

  assert.equal(status, 0, output);
  assert.match(output, /1 unchanged/);
  assert.match(output, /Blocked third parties/);
  // The same host was reached both ways, and each request is reported for what happened to it.
  assert.match(output, /Replayed saved responses from: 127\.0\.0\.1/);
  assert.match(
    output,
    /Reached through a first-party redirect, so neither blocked nor saved: 127\.0\.0\.1/,
  );
});

test('a server that recovers from being overloaded still gets compared', async () => {
  state = { ...clean, assetStatus: 502, recoversAfter: 1 };

  const { status, output } = await compare('/');

  state = { ...clean };
  assert.equal(status, 0, output);
});

test('an overloaded server is never reported as a change', async () => {
  state = { ...clean, assetStatus: 502, headingMargin: 21 };

  const { status, output } = await compare();

  state = { ...clean };
  assert.equal(status, 1, output);
  assert.match(output, /could not compare/);
  assert.doesNotMatch(output, /changed:|--user-approved/);
});

for (const [name, change] of Object.entries({
  'an added wrapper': { wrapped: true },
  'a third-party image, which stays frozen': { thirdPartyImage: '#000000' },
})) {
  test(`passes after ${name}`, async () => {
    state = { ...clean, ...change };

    const { status, output } = await compare('--full');

    state = { ...clean };
    assert.equal(status, 0, output);
  });
}

for (const [name, change, expected] of [
  ['a one-step color change', { headingColor: 'rgb(10, 21, 30)' }, /painted differently/],
  ['an image swapped at the same size', { image: '#336698' }, /painted differently/],
  ['a changed SVG fill', { fill: '#663398' }, /painted differently/],
  ['a 1px margin', { headingMargin: 21 }, /painted differently/],
  ['a removed link', { href: '' }, /Text, links or controls changed/],
  ['a changed link', { href: '/elsewhere/' }, /Text, links or controls changed/],
  ['text on an off-screen slide', { slide: 'Sacond slide' }, /painted differently/],
  [
    'a one-step color change only hovering shows',
    { hoverColor: 'rgb(0, 0, 201)' },
    /state "hover on every element":\n\s+Near a "Call to action"/,
  ],
  [
    'a focus ring that the page hides after a click',
    { focusRing: 'rgb(0, 0, 201)' },
    /state "focus and press on every element"/,
  ],
  [
    'text inside closed details',
    { answer: 'A different answer' },
    /state "all 2 closed details open"/,
  ],
  ['an error status', { status: 500 }, /could not compare/],
  ['an overloaded server', { assetStatus: 502 }, /gateway error/],
] as const) {
  test(`fails on ${name}`, async () => {
    state = { ...clean, ...change };

    const { status, output } = await compare();

    state = { ...clean };
    assert.equal(status, 1, output);
    assert.match(output, expected);
  });
}

test('marks what was removed and what was added the right way round', async () => {
  state = { ...clean, headingColor: 'rgb(10, 21, 30)' };

  const { output } = await compare();

  state = { ...clean };
  assert.match(output, /- text at .*#FF0A141E/);
  assert.match(output, /\+ text at .*#FF0A151E/);
});

test('only --full sees a change that happens during compositing', async () => {
  state = { ...clean, opacity: 0.9 };

  const quick = await compare();
  const full = await compare('--full');

  state = { ...clean };
  assert.equal(quick.status, 0, quick.output);
  assert.equal(full.status, 1, full.output);
  assert.match(full.output, /Screens that differ/);
});

for (const [name, change, expected] of [
  ['a menu that stops opening on hover', { menuOpens: false }, /"hovering "?Menu/],
  ['text on a tab', { tabText: 'Sacond tab' }, /state "tab "Two/],
  [
    'text behind a button inside closed details',
    { behindNestedButton: 'Bahind a nested button' },
    /pressing "More"/,
  ],
  [
    'text behind a button that only one tab shows',
    { behindTabButton: 'Bahind a button on a tab' },
    /pressing "On a tab"/,
  ],
  [
    'text behind a custom control that a press reveals',
    { behindCustomControl: 'Bahind a custom control' },
    /pressing "Custom control"/,
  ],
  [
    'a flyout that another one would cover',
    { coveredPanel: 'rgb(0, 0, 1)' },
    /\+ text at .*#FF000001/,
  ],
] as const) {
  test(`only --full drives controls, and it fails on ${name}`, async () => {
    state = { ...clean, ...change };

    const quick = await compare();
    const full = await compare('--full');

    state = { ...clean };
    assert.equal(quick.status, 0, quick.output);
    assert.equal(full.status, 1, full.output);
    assert.match(full.output, expected);
  });
}

test('pressing controls never writes to the site or leaves the page', async () => {
  writes = 0;
  departures = 0;

  const { status, output } = await compare('--full');

  assert.equal(status, 0, output);
  assert.equal(writes, 0);
  assert.equal(departures, 0);
});

test('a failed replacement leaves the references alone', async () => {
  state = { ...clean, status: 500 };

  const failed = await stet('save-references', site(), '/', '--size', 'desktop', '--user-approved');

  state = { ...clean };
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /No references changed/);
  assert.equal((await compare('--full')).status, 0);
});

test('a page that never stops changing can not replace references', async () => {
  state = { ...clean, moving: true };

  const failed = await stet('save-references', site(), '/', '--size', 'desktop', '--user-approved');

  state = { ...clean };
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /never held still/);
  assert.equal((await compare('--full')).status, 0);
});

test('saving a new page can not replace another page whose address looks similar', async () => {
  state = { ...clean, headingColor: 'rgb(200, 0, 0)' };

  const other = await stet('save-references', site(), '/_home/', '--size', 'desktop');

  state = { ...clean };
  assert.equal(other.status, 0, other.output);
  assert.equal((await compare('/')).status, 0);
});

test('runs on one site wait their turn, and a killed run does not hold them up', async () => {
  const lock = join(stateHome, 'stet', `localhost_${port}`, 'run.lock');
  const [first, second] = await Promise.all([compare('/'), compare('/')]);

  assert.equal(first.status, 0, first.output);
  assert.equal(second.status, 0, second.output);
  assert.match(first.output + second.output, /Waiting for another Stet run/);
  assert.equal(existsSync(lock), false);

  // Well above any process id macOS or Linux hands out, so nothing is running under it.
  mkdirSync(join(lock, '..'), { recursive: true });
  writeFileSync(lock, '99999999');

  const next = await compare('/');

  assert.equal(next.status, 0, next.output);
  assert.doesNotMatch(next.output, /Waiting/);
});

test('names the controls it ran out of reads for', async () => {
  state = { ...clean, extraControls: 70 };

  const { status, output } = await stet('save-references', site(), '/_many/', '--size', 'desktop');

  state = { ...clean };
  assert.equal(status, 0, output);
  assert.match(output, /Not driven on \/_many\/, so not compared: "Extra/);
});
