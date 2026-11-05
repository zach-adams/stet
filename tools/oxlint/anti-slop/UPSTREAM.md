# Anti-slop provenance

Copied from https://github.com/dmmulroy/anti-slop at
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` on October 2, 2026, using its
`skills/install-anti-slop/scripts/install.mjs` installer and bundled assets.

The rule implementations are unmodified. `oxlint.config.ts` enables the generic
rules and the recommended native accumulating-spread rule with upstream default
options, except `require-readable-spacing` and `no-array-filter-map`. The
maintainer requested tighter grouping of related declarations on October 4, 2026.
`no-array-filter-map` is off because the `flatMap` it asks for reads worse than
the chain it replaces.
`readability/statement-spacing` replaces
`require-readable-spacing` and reuses the unmodified vendored ESLint Stylistic engine with project
options. Effect rules are included upstream but are not enabled here.

Keep the MIT license and nested ESLint Stylistic license and provenance.
Stage future upstream updates separately and review them against this revision.
