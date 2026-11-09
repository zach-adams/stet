# Stet

Stet is a command-line visual regression checker for local WordPress sites. These instructions cover changing Stet. To run it against a site, read [skills/core/SKILL.md](skills/core/SKILL.md), which `stet skills get core` prints.

## Where things are

- `src/stet.ts` is the `stet` command. It reads the arguments, takes the per-site lock, manages references on disk and hands each run to Playwright Test.
- `src/parity.spec.ts` is the Playwright test that captures and compares one page at one size.
- `src/capture.ts` loads a page. It saves or blocks third parties, freezes time and checks that the page loaded.
- `src/paint.ts` reads each compositor layer's paint record and describes its drawing commands.
- `src/states.ts` finds the page's controls and walks its hover, focus, open and pressed states.
- `src/report.ts` is the Playwright reporter that prints the text report.
- `src/sizes.ts` lists the seven screen sizes.
- `src/site.ts` and `src/run.ts` hold the shared types, where each site's files live and the current run's settings.
- `tests/stet.test.ts` runs the `stet` command against fixture pages it serves locally.
- [docs/design.md](docs/design.md) records what Stet compares, stores and reports, and why. Read it before changing any of those, and update it when a decision changes.

## Rules

- Run it against local sites. Use a production or live URL only when the user asks for that run, and keep the refusal that requires `--allow-live`.
- Fix or report a failing `compare`. Pass `--user-approved` to `save-references` or `accept-changes` only after the user approves replacing those references, because an agent that can replace references can approve its own regressions.
- Let pixels decide pass or fail. Geometry, styles, paint commands and element labels may explain a failure but must never turn it into a pass. The aria snapshot and the counts of cursors, clicks, transitions and animations are the exceptions, because they check what pixels can't see.
- Capture one screen at a time and never with `fullPage`, which disturbs the page. [docs/design.md](docs/design.md) has the measurements.
- Get user approval for any mask, exclusion or tolerance, and make it visible in the report.
- Use `site.test` or `example.test` for URLs in docs, tests and examples.
- Prefer what Playwright already provides over new code or dependencies. `src/stet.ts` only names commands, takes the per-site lock and hands them to Playwright Test.
- Keep `skills/core/SKILL.md` and the README matching what the commands do and what they print.

## Checks

Before changing TypeScript, read [docs/typescript-style.md](docs/typescript-style.md), including what it says about code that runs in the page. After edits, run `pnpm format`, `pnpm lint:fix`, then `pnpm format`.

A change is done when `pnpm check` passes and, for anything affecting capture or comparison, `stet compare <url> --full` gives the expected result on a real local site.
