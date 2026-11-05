# Stet

Stet is a local visual regression checker for WordPress sites. The `stet` command in `src/stet.ts` runs it, and Playwright Test does the capture and comparison. To use Stet rather than change it, read `skills/core/SKILL.md`, which `stet skills get core` prints. Before changing what it compares, stores or reports, read [docs/design.md](docs/design.md) and update it if a decision changes.

## Rules

- Run it against local sites. Use a production or live URL only when the user asks for that run, and keep the refusal that requires `--allow-live`.
- Fix or report a failing `compare`. Pass `--user-approved` to `save-references` only after the user approves replacing those references, because an agent that can replace references can approve its own regressions.
- Let pixels decide pass or fail. Geometry, styles, paint commands and element labels may explain a failure but must never turn it into a pass. The aria snapshot is the exception, because it checks what pixels can't see.
- Capture one screen at a time and never with `fullPage`, which disturbs the page. [docs/design.md](docs/design.md) has the measurements.
- Get user approval for any mask, exclusion or tolerance, and make it visible in the report.
- Keep client names and URLs out of tracked files, including tests and docs. Use `example.test` or generic descriptions.
- Prefer what Playwright already provides over new code or dependencies. `src/stet.ts` only names commands and hands them to Playwright Test.
- Keep `skills/core/SKILL.md` matching what the commands do and what they print.

## Checks

A change is done when `pnpm typecheck` and `pnpm test` pass and, for anything affecting capture or comparison, `stet compare <url> --full` gives the expected result on a real local site.
