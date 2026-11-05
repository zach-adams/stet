import { homedir } from 'node:os';
import { join } from 'node:path';

export type Site = {
  baseURL: string;
  pages: string[];
  /** Third-party requests to save with the references and replay. All other third parties are blocked. */
  replay?: RegExp;
};

const name = process.env.STET_SITE;

if (!name) {
  throw new Error('Run Stet through `pnpm stet`, which sets the site.');
}

export const site: Site = (await import(`../sites/${name}.ts`)).default;
export const stateDir = join(homedir(), '.local/state/stet', name);
export const savedDir = join(stateDir, 'references');
// Playwright keeps an unstable capture when overwriting a reference, so saving starts empty and is promoted only if it all succeeds.
export const candidateDir = join(stateDir, 'references-candidate');
export const saving = Boolean(process.env.STET_SAVE);
export const referencesDir = saving ? candidateDir : savedDir;
