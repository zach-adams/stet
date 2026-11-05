import { siteDirs, type Run } from './site.ts';

if (!process.env.STET_RUN) {
  throw new Error('Run Stet through the `stet` command.');
}

export const run: Run = JSON.parse(process.env.STET_RUN);
export const dirs = siteDirs(run.baseURL);
export const referencesDir = run.saving ? dirs.candidate : dirs.saved;
