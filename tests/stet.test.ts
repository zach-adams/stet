import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
};

let state = { ...clean };
let port = 0;

const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${color}"/></svg>`;

const page = () => {
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
${state.moving ? `<script>let n = 0; setInterval(() => { document.querySelector('h1').textContent = 'Tick ' + ++n; }, 16);</script>` : ''}`;
};

const server = createServer((request, response) => {
  if (request.url === '/image.svg' || request.url === '/third.svg') {
    response.writeHead(request.url === '/image.svg' ? state.assetStatus : 200, { 'content-type': 'image/svg+xml' });
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
    response.writeHead(request.url === '/' ? state.status : request.url === '/_home/' ? 200 : 404, { 'content-type': 'text/html' });
    response.end(page());
  }
});

const stateHome = mkdtempSync(join(tmpdir(), 'stet-test-'));
const bin = join(import.meta.dirname, '../bin/stet');
const site = () => `http://localhost:${port}`;

function stet(...args: string[]) {
  return new Promise<{ status: number; output: string }>((resolve) => {
    execFile(bin, args, { env: { ...process.env, XDG_STATE_HOME: stateHome } }, (error, stdout, stderr) => {
      resolve({ status: error ? Number(error.code) : 0, output: stdout + stderr });
    });
  });
}

const compare = (...args: string[]) => stet('compare', site(), '--size', 'desktop', ...args);

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
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
  assert.match(output, /Reached through a first-party redirect, so neither blocked nor saved: 127\.0\.0\.1/);
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

    const { status, output } = await compare();

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
