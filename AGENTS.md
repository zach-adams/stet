# Stet

Stet is a local visual regression checker for WordPress sites. `pnpm stet` runs it, and Playwright Test does the capture and comparison. Before changing what it compares, stores or reports, read [docs/design.md](docs/design.md) and update it if a decision changes.

## Rules

- Point site files at local sites. Use a production or live URL only when the user asks for that run.
- Fix or report a failing `compare`. Pass `--user-approved` to `save-references` only after the user approves replacing the references, because an agent that can replace references can approve its own regressions.
- Let pixels decide pass or fail. Geometry, styles, paint commands and element labels may explain a failure but must never turn it into a pass.
- Capture one screen at a time and never with `fullPage`, which disturbs the page. [docs/design.md](docs/design.md) has the measurements.
- Get user approval for any mask, exclusion or tolerance, and make it visible in the report.
- Keep client site files in the ignored `sites/` folder. Tracked files, including tests and docs, use `example.test` or generic descriptions.
- Prefer what Playwright already provides over new code or dependencies. `src/stet.ts` only names commands and hands them to Playwright Test.

## Checks

A change is done when `pnpm typecheck` passes and, for anything affecting capture or comparison, `pnpm stet compare <name> --all-sizes` gives the expected result on a real local site.
