import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sizes } from './sizes.ts';

const root = join(import.meta.dirname, '..');
const sites = readdirSync(join(root, 'sites'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.slice(0, -3));

const help = `Stet compares what a site renders now with references saved from a known-good state.

  pnpm stet compare <site>                Compare at desktop and small-phone. Never changes references.
  pnpm stet compare <site> --all-sizes    Compare at all six sizes, before calling a change done.
  pnpm stet save-references <site>        Save the current render as the references, at all six sizes.
                                          Replacing existing references needs --user-approved.

  --page <pattern>   Only pages whose path matches the pattern.
  --size <name>      Only one size: ${sizes.map((size) => size.name).join(', ')}.

Sites: ${sites.join(', ')}. Add one by copying sites/example.ts.
Exit codes: 0 nothing changed, 1 something changed or couldn't be compared, 2 the command was refused.`;

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

function options() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        'all-sizes': { type: 'boolean' },
        'user-approved': { type: 'boolean' },
        page: { type: 'string' },
        size: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return refuse(`${(error as Error).message}\n\n${help}`);
  }
}

const { positionals, values } = options();
const [command, name] = positionals;

if (!command || values.help) {
  console.log(help);
  process.exit(0);
}

if (command !== 'compare' && command !== 'save-references') {
  refuse(`Unknown command "${command}".\n\n${help}`);
}

if (!name || !sites.includes(name)) {
  refuse(`Name a site after the command. Sites: ${sites.join(', ')}.`);
}

if (values.size && !sizes.some((size) => size.name === values.size)) {
  refuse(`Unknown size "${values.size}". Sizes: ${sizes.map((size) => size.name).join(', ')}.`);
}

if (values.page) {
  try {
    new RegExp(values.page);
  } catch {
    refuse(`--page "${values.page}" isn't a valid pattern.`);
  }

  process.env.STET_PAGE = values.page;
}

process.env.STET_SITE = name;
const { candidateDir, savedDir } = await import('./site.ts');
const saved = existsSync(savedDir);

if (command === 'compare' && !saved) {
  refuse(
    `${name} has no references yet. Once the user confirms the site is in a known-good state, run: pnpm stet save-references ${name}`,
  );
}

if (command === 'save-references' && saved && !values['user-approved']) {
  refuse(
    `${name} already has references. Replacing them would hide any regression made since they were saved, so ask the user first. Once they approve, rerun with --user-approved.`,
  );
}

const args = ['test'];

if (command === 'save-references') {
  process.env.STET_SAVE = '1';
  rmSync(candidateDir, { recursive: true, force: true });
}

if (values.size) {
  args.push(`--project=${values.size}`);
} else if (command === 'compare' && !values['all-sizes']) {
  args.push('--project=desktop', '--project=small-phone');
}

const run = spawnSync(join(root, 'node_modules/.bin/playwright'), args, { cwd: root, stdio: 'inherit' });

if (command === 'save-references') {
  if (run.status === 0) {
    cpSync(candidateDir, savedDir, { recursive: true });
    console.log('References saved.');
  } else {
    console.log('No references changed, because not everything could be saved.');
  }

  rmSync(candidateDir, { recursive: true, force: true });
}

process.exit(run.status ?? 1);
