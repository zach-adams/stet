# Stet

Stet checks whether a change altered what a WordPress site renders. It compares what each page paints with references saved from a known-good state, at six screen sizes, so an agent can run it after each edit during a refactor. The name is the proofreading mark for "let it stand".

A pass means no pixel changed in what Stet captured on the listed pages and sizes. It says nothing about states or pages Stet didn't capture. [docs/design.md](docs/design.md) covers what it decides, its limits and what comes next.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

pnpm runs the project on Node 24 whatever the shell's default is.

## Use

Copy `sites/example.ts` to `sites/<name>.ts` and list the site's URL and pages. Files in `sites/` other than the example stay out of Git. Run `pnpm stet` to see the commands.

```bash
pnpm stet save-references <name>                # save references at all six sizes, from a known-good site
pnpm stet compare <name>                        # desktop and a 360 phone, for use while editing
pnpm stet compare <name> --all-sizes            # all six sizes, before calling a change done
pnpm stet compare <name> --page fleet           # only pages matching a pattern
pnpm stet compare <name> --size tablet          # only one size
pnpm stet save-references <name> --user-approved  # replace existing references, once the user approves
```

`compare` exits 1 when a page changed, a reference is missing, a page returns an error status, a visible image or font fails to load, or a page won't hold still long enough to capture. Both commands exit 2 when they refuse to run.

## Third parties

Stet blocks every third-party request and lists the blocked hosts in each report. Set `replay` in a site file to keep the third parties the page's look depends on, such as an embedded form. `save-references` saves their responses and `compare` replays them, so nothing changes between runs and they aren't called. Saved responses only update with the references.

References and results live in `~/.local/state/stet/<name>/`. Each failed comparison leaves expected, actual and diff images under `results/`.
