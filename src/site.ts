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

/**
 * Hosts that only this machine or its network can reach: loopback and private addresses, and
 * names reserved for local use or that local development tools point there, with or without a
 * trailing dot. A regular expression source without anchors, so a URL pattern can include it.
 */
export const LOCAL_HOST = `(?:${[
  'localhost',
  String.raw`[\w-]+(?:\.[\w-]+)*\.(?:localhost|test|local|internal|lan|home\.arpa|ddev\.site|lndo\.site)`,
  String.raw`(?:127|10)(?:\.\d{1,3}){3}`,
  String.raw`0\.0\.0\.0`,
  String.raw`192\.168(?:\.\d{1,3}){2}`,
  String.raw`172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}`,
  String.raw`169\.254(?:\.\d{1,3}){2}`,
  String.raw`\[(?:::1|f[cd][\da-f]*:[\da-f:]*|fe[89ab][\da-f]*:[\da-f:]*)\]`,
].join('|')})\\.?`;

export function isLocalHost(hostname: string) {
  return new RegExp(`^${LOCAL_HOST}$`).test(hostname);
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
