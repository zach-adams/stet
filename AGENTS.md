# Stet

Stet is a local visual regression checker for WordPress sites, built as a thin layer over Playwright Test. Before changing what it compares, stores or reports, read [docs/design.md](docs/design.md) and update it if a decision changes.

## Rules

- Point site files at local sites. Use a production or live URL only when the user asks for that run.
- Fix or report a failing `verify`. Run `baseline` over existing references only after the user approves replacing them, because an agent that can replace references can approve its own regressions.
- Let screenshots decide pass or fail. Geometry, styles and element labels may explain a failure but must never turn it into a pass.
- Get user approval for any mask, exclusion or tolerance, and make it visible in the report.
- Keep client site files in the ignored `sites/` folder. Tracked files, including tests and docs, use `example.test` or generic descriptions.
- Prefer what Playwright already provides over new code, dependencies or a custom CLI.

## Checks

A change is done when `pnpm typecheck` passes and, for anything affecting capture or comparison, `STET_SITE=<name> pnpm signoff` gives the expected result on a real local site.
