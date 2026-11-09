import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the `stet` command hands to the Playwright run. */
export interface Run {
  baseURL: string;
  pages: string[];
  /**
   * Third-party scripts and requests to save and replay. Fonts, stylesheets and images always
   * are.
   */
  replay?: string;
  saving: boolean;
  /** Also compare real screenshots, which see how the compositor puts layers together. */
  full: boolean;
}

/** A file a comparison saw, and the reference it differed from. */
export interface Observed {
  observed: string;
  reference: string;
}

/** A page and size whose last comparison found only changes that `stet accept-changes` can keep. */
export interface Changed {
  page: string;
  size: string;
  files: Observed[];
}

export const stateRoot = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'),
  'stet',
);

export function siteDirs(baseURL: string) {
  const state = join(stateRoot, new URL(baseURL).host.replace(':', '_'));

  return {
    state,
    manifest: join(state, 'site.json'),
    saved: join(state, 'references'),
    // Playwright keeps an unstable capture when overwriting a reference, so saving starts empty
    // and is promoted only if it all succeeds.
    candidate: join(state, 'references-candidate'),
    // Playwright empties this once a run starts, not if it fails before then.
    results: join(state, 'results'),
    changed: join(state, 'results', 'changed.json'),
  };
}
