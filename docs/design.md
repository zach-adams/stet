# Design

Stet answers one question: did this change alter what these pages render in the captured states? It can't prove a site still looks and works the same, because anything uncaptured stays unknown.

## What decides pass or fail

Full-page lossless screenshots decide, compared with a reference for the same page and device at a threshold of 0. Any changed pixel fails.

Screenshots stay correct when a refactor changes the DOM, such as replacing a custom block with core blocks, because they ignore structure. A layout tree comparison gets both directions wrong. It passes a changed image source or SVG fill when the boxes match, and it reports a removal and an addition when a wrapper shifts index-based paths. Reliable general DOM matching would be a large project of its own. Geometry and styles may explain a failure later, but they never make one pass.

## References

- `verify` never writes references, and a missing reference fails.
- References get replaced as complete page and device captures, after user approval. There is no per-change accept, because partial updates can produce a reference no browser ever rendered.
- A failed load fails before comparison, so a blank image or error page can't become an accepted reference through `verify`. That check covers the response status, visible images and fonts.

## Built

Explicit page lists per site, desktop and phone capture, load checks, and references stored outside the repo.

## Next, in order

1. Commit fixture checks in `tests/`. A harmless added wrapper passes. A one-step color change, a missing image, an error status and a missing reference fail.
2. Add named behavior scenarios per site: link destinations, mobile menu, disclosures, dialogs, keyboard focus and closing. Never submit real forms. Done when the removed-link fixture fails, which it doesn't today.
3. Replace raw output with a short agent report. It separates unchanged, changed, incomplete and unstable, and labels each changed region with the element at that position on the current page. Labels need no DOM matching. Done when an agent can name the changed element without opening an image.
4. Record provenance with each reference: theme commit, built asset hash and content snapshot identity. A theme commit alone can't identify ignored build output or database content.
5. Capture repeatedly during baseline to expose unstable pages. Unstable never counts as unchanged.
6. Add site-level exclusions with a stated reason, printed in every report.
7. Declare expected changes. The default is no visual change. An intended redesign lists which pages may change, and anything else fails.
8. Add widths around each site's breakpoints.
9. Run WebKit and Firefox on representative templates before a migration signs off, with separate references.

## Deferred

- CSS rule knockout can suggest candidates, but individually harmless deletions can fail together and untested states stay unknown.
- Ownership tracking needs more than matched rules, which are inputs to the cascade and not a full attribution of each value.
- A second running copy of the site isn't needed yet. A manually preserved reference environment covers recaptures.
- History and bisect need reproducible content and assets first.
- A width sweep may suggest widths to test, but it misses color, crop and typography changes and can't replace a declared test matrix.

## Left out

A layout tree verdict, generic DOM matching, an accept command, a custom image comparator, Figma comparison, a database and an MCP server.

## Known limits

- Screenshots can't see behavior, so a removed `href` passes until scenarios exist. Hover states, open menus and dialogs aren't captured yet either.
- Only Chromium runs today. Playwright's WebKit is useful coverage but isn't branded Safari.
- Front-end parity can't show that Gutenberg markup is valid or that a setting moved into the editor. Those need separate editor checks.
- Playwright 1.64.1 fails to read PNGs on Node 27 alpha, so `devEngines` pins Node 24.
