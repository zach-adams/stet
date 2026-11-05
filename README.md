# Stet

Stet checks whether a change altered what a local site renders. It compares what each page paints, and what its links and controls say, at rest and in its hover, focus, open and pressed states, with references saved from a known-good state at seven screen sizes, so an agent can run it after each edit during a refactor. The name is the proofreading mark for "let it stand".

A pass means nothing changed in what Stet captured on the saved pages and sizes. It says nothing about states or pages Stet didn't capture. [docs/design.md](docs/design.md) covers what it decides, its limits and what comes next.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
ln -s "$PWD/bin/stet" /opt/homebrew/bin/stet   # or any folder on your PATH
```

`stet` runs on the project's pinned Node version whatever the shell's default is.

## Use

```bash
stet save-references https://site.test / /about/   # save these pages at all seven sizes, from a known-good site
stet compare https://site.test                     # every saved page at desktop and a 360 phone, with hover, focus and open details, while editing
stet compare https://site.test --full              # all seven sizes, every control driven, and real screenshots, before calling a change done
stet list                                          # sites and pages with references
stet skills get core                               # the full guide, written for AI agents
```

Run `stet` with no arguments for every option. `compare` exits 1 when something changed or couldn't be compared, and every command exits 2 when it refuses to run.

References and results live in `~/.local/state/stet/<host>/`. A failed `--full` comparison leaves expected, actual and diff images under `results/`.

## Develop

```bash
pnpm format
pnpm check   # formatting, lint, types and tests
```

[docs/typescript-style.md](docs/typescript-style.md) has the code conventions.
