# TypeScript style

Stet follows the [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
with project readability additions. Write source for a person reviewing a change.

## Automatic checks

The configurations are the source of truth for enforceable conventions:

- [Oxfmt](../.oxfmtrc.json) owns formatting, including 100-column wrapping and
  compact objects that fit on a line. It doesn't wrap comments, so keep those
  within 100 columns by hand.
- [Oxlint](../oxlint.config.ts) owns code conventions through native rules
  wherever available, alongside the anti-slop rules.
- [The local plugin](../tools/oxlint/readability.ts) fills four gaps in the
  native rules: top-level function declarations while allowing local closures,
  PascalCase type names, statement spacing, and `? [x] : []` in a spread or a
  `flatMap` callback. It groups short declarations and keeps gaps around control
  flow.

`tools/oxlint/anti-slop/` is vendored and excluded from both tools.
[Its provenance](../tools/oxlint/anti-slop/UPSTREAM.md) says how to update it.

The Oxlint configuration and plugin entry point use default exports because
Oxlint requires them. `playwright.config.ts` and `src/report.ts` do because
Playwright requires them.

## Code that runs in the page

Playwright serializes a function passed to `evaluate`, `evaluateHandle` or
`addInitScript` and runs it in the browser, where nothing from module scope
exists. Keep what such a function needs inside it, as local closures, and pass
values in as arguments. Moving a helper out to module scope passes type checking
and lint and then fails at run time.

## Review conventions

Tools cannot determine whether a name explains its purpose or whether a function
does too much. Review these points:

- Use names that explain purpose. A mechanically valid name can still be
  unhelpful. Short names are fine in small callbacks.
- Split dense expressions into named steps when the intermediate value helps
  explain the decision. Use guard clauses for eligibility checks and `if` or
  `switch` for several outcomes. Preserve short-circuiting around expensive or
  stateful calls.
- Use `.filter().map()` to keep some items and transform each one. Use a loop
  with `if` and `push` when a step needs more, such as a computed value, an
  `await` or an early exit. Use `flatMap` only when one item becomes several.
- Keep functions focused on one operation. Extract a helper when it names a real
  responsibility, not just to lower a line count.
- Let TypeScript infer obvious local types. Annotate public contracts and
  recursive functions where the declaration helps a reader.
- Comment non-obvious intent, constraints, and usage contracts. Avoid comments
  that repeat the statement beneath them.

## Development commands

```sh
pnpm format
pnpm lint:fix
pnpm format
pnpm check
```

`pnpm check` runs formatting, linting, type checking and tests. Fix the code
rather than adding suppressions or changing rules to pass a check.

The pre-commit hook runs everything except the tests, which take about three
minutes and drive browsers. Run `pnpm check` before calling a change done.
