# Stet

Stet checks whether a change altered what a WordPress site renders. It compares full-page screenshots against saved references at desktop and phone sizes, so an agent can run it after each edit during a refactor. The name is the proofreading mark for "let it stand".

A pass means no pixel changed on the listed pages and devices. It says nothing about states or pages Stet didn't capture. [docs/design.md](docs/design.md) covers what it decides, its limits and what comes next.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

pnpm runs the project on Node 24 whatever the shell's default is.

## Use

Copy `sites/example.ts` to `sites/<name>.ts` and list the site's URL and pages. Files in `sites/` other than the example stay out of Git.

```bash
STET_SITE=<name> pnpm baseline               # capture references from a known-good site
STET_SITE=<name> pnpm verify                 # compare the site with its references
STET_SITE=<name> pnpm verify -g fleet        # only pages matching a pattern
STET_SITE=<name> pnpm verify --project=phone # only one device
```

`verify` exits nonzero when a page changed, a reference is missing, a page returns an error status, or a visible image or font fails to load.

References and results live in `~/.local/state/stet/<name>/`. Each failed comparison leaves expected, actual and diff images under `results/`.
