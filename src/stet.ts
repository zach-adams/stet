import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { overview, sizeNames, topics } from './help.ts';
import { siteDirs, stateRoot, type Changed, type Run } from './site.ts';
import { sizes } from './sizes.ts';

interface Manifest {
  baseURL: string;
  pages: string[];
  replay?: string;
}

const root = join(import.meta.dirname, '..');
const skillsDir = join(root, 'skills');

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

function options() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        full: { type: 'boolean' },
        size: { type: 'string' },
        replay: { type: 'string' },
        'user-approved': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    // SAFETY: parseArgs throws an Error when the arguments are invalid.
    return refuse(`${(error as Error).message}\n\n${overview}`);
  }
}

function readManifest(file: string): Manifest | undefined {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

// A run that was killed can't remove its lock, so a lock whose process is gone doesn't count.
function lockIsHeld(lock: string) {
  try {
    return process.kill(Number(readFileSync(lock, 'utf8')), 0);
  } catch (error) {
    // SAFETY: filesystem and process errors from these Node APIs have an optional code.
    return !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
}

// Overlapping runs overload a local server and replace each other's results, so a site takes
// one run at a time.
function waitForTurn(lock: string) {
  mkdirSync(dirname(lock), { recursive: true });

  let told = false;

  while (true) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      process.on('exit', () => rmSync(lock, { force: true }));

      return;
    } catch {
      if (!lockIsHeld(lock)) {
        rmSync(lock, { force: true });

        continue;
      }
    }

    if (!told) {
      console.error('Waiting for another Stet run on this site to finish.');
      told = true;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

function skills(args: string[]) {
  const names = readdirSync(skillsDir);
  const read = (name: string) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');

  if (args[0] === 'get' && args[1] && names.includes(args[1])) {
    console.log(read(args[1]));

    return;
  }

  if (args.length && args[0] !== 'list') {
    refuse(`Use \`stet skills list\` or \`stet skills get <name>\`. Skills: ${names.join(', ')}.`);
  }

  for (const name of names) {
    console.log(`${name}: ${read(name).match(/^description: (.+)$/m)?.[1]}`);
  }
}

function list() {
  const sites = existsSync(stateRoot) ? readdirSync(stateRoot) : [];
  const manifests = sites
    .map((site) => readManifest(join(stateRoot, site, 'site.json')))
    .filter((manifest) => manifest !== undefined);

  if (!manifests.length) {
    console.log('No site has references yet.');
  }

  for (const { baseURL, pages } of manifests) {
    console.log(`${baseURL}: ${pages.join(' ')}`);
  }
}

const { positionals, values } = options();
const [command, address, ...rest] = positionals;

if (!command || values.help || command === 'help') {
  const topic = command === 'help' ? address : command;
  const text = topic ? topics.get(topic) : overview;

  if (!text) {
    refuse(`No help for "${topic}". Topics: ${[...topics.keys()].join(', ')}.`);
  }

  console.log(text);
  process.exit(0);
}

if (command === 'skills') {
  skills(positionals.slice(1));
  process.exit(0);
}

if (command === 'list') {
  list();
  process.exit(0);
}

if (!['compare', 'save-references', 'accept-changes'].includes(command)) {
  refuse(`Unknown command "${command}".\n\n${overview}`);
}

if (!address || !URL.canParse(address)) {
  refuse(
    `Give the site's full URL after the command, as in: stet ${command} https://example.test /about/`,
  );
}

if (values.size && !sizes.some((size) => size.name === values.size)) {
  refuse(`Unknown size "${values.size}". Sizes: ${sizeNames}.`);
}

if (values.replay) {
  try {
    new RegExp(values.replay);
  } catch {
    refuse(`--replay "${values.replay}" isn't a valid pattern.`);
  }
}

const site = new URL(address);

function pageOf(page: string) {
  const url = new URL(page, site.origin);

  if (url.origin !== site.origin) {
    refuse(`${page} isn't on ${site.origin}.`);
  }

  return url.pathname + url.search;
}

const dirs = siteDirs(site.origin);

waitForTurn(join(dirs.state, 'run.lock'));

const manifest = readManifest(dirs.manifest);
let named: string[] = [];

if (rest.length) {
  named = rest.map(pageOf);
} else if (site.pathname + site.search !== '/') {
  named = [pageOf(address)];
}

if (command === 'compare' && !manifest) {
  refuse(
    `${site.origin} has no references yet. Once the user confirms the site is in a known-good state, run: stet save-references ${site.origin} <page> ...`,
  );
}

const saving = command === 'save-references';
let pages = named;

if (!pages.length) {
  pages = saving ? ['/'] : (manifest?.pages ?? []);
}

if (saving && !values['user-approved']) {
  const existing = pages.filter((page) => manifest?.pages.includes(page));

  if (existing.length) {
    refuse(
      `${existing.join(' ')} already ${existing.length === 1 ? 'has' : 'have'} references at ${site.host}. References belong to an address, so another project served there shares them, and \`stet list\` shows what's saved. Replacing them would hide any regression made since they were saved, so ask the user first. Once they approve, rerun with --user-approved.`,
    );
  }
}

if (!saving) {
  const unknown = pages.filter((page) => !manifest?.pages.includes(page));

  if (unknown.length) {
    refuse(
      `${unknown.join(' ')} ${unknown.length === 1 ? 'has' : 'have'} no references. Once the user confirms ${unknown.length === 1 ? 'it is' : 'they are'} in a known-good state, run: stet save-references ${site.origin} ${unknown.join(' ')}`,
    );
  }
}

// Copies only what the last compare saw and reported, without capturing again, so a change at a
// size or in a state it didn't compare still shows the next time that is compared.
function acceptChanges() {
  if (!values['user-approved']) {
    refuse(
      `Accepting a change replaces references, which hides it from every later comparison, so ask the user first. Once they approve, rerun with --user-approved.`,
    );
  }

  const reported: Changed[] = existsSync(dirs.changed)
    ? JSON.parse(readFileSync(dirs.changed, 'utf8'))
    : [];
  const changed = reported.filter(({ size }) => !values.size || size === values.size);
  const unseen = named.filter((page) => !changed.some((entry) => entry.page === page));

  if (!changed.length || unseen.length) {
    refuse(
      `The last compare of ${site.origin} reported no change that can be accepted${unseen.length ? ` on ${unseen.join(' ')}` : ''}${values.size ? ` at ${values.size}` : ''}. Run stet compare first. Changes that couldn't be compared, or pages without references, can't be accepted.`,
    );
  }

  const accepted = named.length ? changed.filter(({ page }) => named.includes(page)) : changed;

  for (const { files } of accepted) {
    for (const { observed, reference } of files) {
      cpSync(observed, reference);
    }
  }

  writeFileSync(
    dirs.changed,
    JSON.stringify(reported.filter((entry) => !accepted.includes(entry))),
  );
  console.log(
    `References now match what the last compare saw on ${[...new Set(accepted.map(({ page }) => page))].join(' ')}. Sizes, states and screens it didn't compare keep their old references.`,
  );
}

if (command === 'accept-changes') {
  acceptChanges();
  process.exit(0);
}

// Patterns add up, because replacing one would block what other saved pages recorded under it.
let replay = values.replay ?? manifest?.replay;

if (values.replay && manifest?.replay && manifest.replay !== values.replay) {
  replay = `${manifest.replay}|${values.replay}`;
}

const run: Run = { baseURL: site.origin, pages, replay, saving, full: Boolean(values.full) };
const args = ['test'];

if (values.size) {
  args.push(`--project=${values.size}`);
} else if (!saving && !values.full) {
  args.push('--project=desktop', '--project=small-phone');
}

if (saving) {
  rmSync(dirs.candidate, { recursive: true, force: true });
}

// Playwright empties the results only once it starts, so a run that fails before then must not
// leave an earlier comparison to accept.
rmSync(dirs.changed, { force: true });

const result = spawnSync(join(root, 'node_modules/.bin/playwright'), args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, STET_RUN: JSON.stringify(run) },
});

if (saving) {
  if (result.status === 0) {
    cpSync(dirs.candidate, dirs.saved, { recursive: true });
    mkdirSync(dirs.state, { recursive: true });

    const savedPages = [...new Set([...(manifest?.pages ?? []), ...pages])];
    const updated: Manifest = { baseURL: site.origin, pages: savedPages, replay };

    writeFileSync(dirs.manifest, `${JSON.stringify(updated, null, 2)}\n`);
    console.log('References saved.');
  } else {
    console.log('No references changed, because not everything could be saved.');
  }

  rmSync(dirs.candidate, { recursive: true, force: true });
}

process.exit(result.status ?? 1);
