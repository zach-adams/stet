import { homedir } from 'node:os';
import { join } from 'node:path';

export type Site = {
  baseURL: string;
  pages: string[];
};

const name = process.env.STET_SITE;

if (!name) {
  throw new Error('Set STET_SITE to a file name in sites/, as in STET_SITE=example pnpm verify.');
}

export const site: Site = (await import(`../sites/${name}.ts`)).default;
export const stateDir = join(homedir(), '.local/state/stet', name);
