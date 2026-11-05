# Design

Stet answers one question: did this change alter what these pages render in the captured states? It can't prove a site still looks and works the same, because anything uncaptured stays unknown.

## What decides pass or fail

Pixels decide. Each page is captured one screen at a time and compared with a reference for the same page, size and screen at a threshold of 0, so any changed pixel fails. The page's width and height are compared too, so a page can't shrink or grow unnoticed.

Pixels stay correct when a refactor changes the DOM, such as replacing a custom block with core blocks, because they ignore structure. A DOM or layout tree comparison gets both directions wrong. It passes a changed image source or SVG fill when the boxes match, and it reports a removal and an addition when a wrapper shifts index-based paths. Geometry and styles may explain a failure later, but they never make one pass.

## Capture

Full-page screenshots are out, because they disturb the page. Measured on a real site, one full-page capture fires `resize`, briefly narrows the viewport so a `(max-width: 100px)` media query flips even at 1920, and makes the browser pick and download different `srcset` files (5 to 11 requests per page, against 0 for a viewport capture). Repeated captures also moved a carousel 68px in 2 of 8 loads. Waiting for two identical screenshots hides some of this and adds to the rest.

Each capture does the following, in order:

1. Block third parties and replay the saved responses of those the site file names. A third party that varies between runs can't be compared, and blocking all of them silently removes content the theme styles, such as an embedded form.
2. Load the page, scroll it instantly to start lazy loading, wait for network activity to stop, and fail if a visible image or font didn't load.
3. Reset the screen to the top with `scrollIntoView`. When a page grows during the scroll pass on phone emulation, scroll anchoring pans the visual viewport, and `scrollTo` can't undo that even though `scrollY` reads 0.
4. Take one screenshot per screen. Before each, finish animations and wait for page height and scroll offsets to hold, which also catches JavaScript smooth scrolling that `getAnimations()` can't see.

## References

- `compare` never writes references, and a missing reference fails.
- `save-references` refuses to replace existing references without `--user-approved`. It captures into an empty folder and promotes the result only if everything succeeds, because Playwright keeps an unstable capture when it overwrites a reference, and a failed run must not leave some references replaced.
- References get replaced as complete page and size captures, after user approval. There is no per-change accept, because partial updates can produce a reference no browser ever rendered.
- A failed load fails before comparison, so a blank image or error page can't become an accepted reference through `compare`. That check covers the response status, visible images and fonts.
- Saved third-party responses live with the references and change only when they do.

## Built

Explicit page lists per site, load checks, references stored outside the repo, third-party blocking with saved responses, and a text report that names the changed pages, screens and pixel counts and lists every blocked host.

Capture uses six common screen sizes. `compare` runs desktop and a 360 phone while editing, and `compare --all-sizes` runs all six.

## Next, in order

1. Compare Chromium's paint record per layer, and add aria snapshots, for use while editing. `LayerTree.makeSnapshot` and `replaySnapshot` rasterize what Chromium recorded for each layer, without the compositor. Measured results: identical on the first read across fresh loads at about 2 seconds per page and size, unaffected by carousel position, and it sees off-screen carousel slides and the full width of a page wider than a phone. Compare replay pixels plus each layer's size and transform, and keep the command log for explaining a failure, because harmless paint reordering changes it. It reads past the viewport only about 4000px, so long pages need scroll stops. Compositing-only effects, such as a carousel layer's opacity, don't appear in it, so screen-by-screen capture stays as the sign-off check. `LayerTree` is an experimental protocol domain, so an upgrade of the pinned Playwright could break it. Aria snapshots catch a removed or changed link, which pixels can't. Done when the removed-link fixture and an off-screen slide change both fail.
2. Walk interaction states. Find details, expandable controls, tabs and popovers, drive each one, and record the result under its role and accessible name so wrappers don't break matching. Use `CSS.forcePseudoState` for hover and focus, and a real mouse for menus that open on `mouseenter`. A control that disappears or appears fails, and one that has no effect is listed. Use `page.clock` and a seeded `Math.random` for sites with JavaScript autoplay. Done when a planted hover change and a planted change in closed details both fail by name.
3. Commit fixture checks in `tests/`. A harmless added wrapper passes. A one-step color change, a missing image, an error status and a missing reference fail.
4. Label each changed region with the element at that position on the current page. Labels need no DOM matching. Done when an agent can name the changed element without opening an image.
5. Record provenance with each reference: theme commit, built asset hash and content snapshot identity. A theme commit alone can't identify ignored build output or database content.
6. Capture repeatedly during `save-references` to expose unstable pages. Unstable never counts as unchanged.
7. Add site-level exclusions with a stated reason, printed in every report.
8. Declare expected changes. The default is no visual change. An intended redesign lists which pages may change, and anything else fails.
9. Add widths around each site's breakpoints.
10. Run WebKit and Firefox on representative templates before a migration signs off, with separate references.

## Deferred

- CSS rule knockout can suggest candidates, but individually harmless deletions can fail together and untested states stay unknown. CSS coverage can list what no captured state applied, which is a candidate list and not proof a rule is unused.
- Ownership tracking needs more than matched rules, which are inputs to the cascade and not a full attribution of each value.
- A second running copy of the site isn't needed yet. A manually preserved reference environment covers recaptures.
- History and bisect need reproducible content and assets first.
- A width sweep may suggest widths to test, but it misses color, crop and typography changes and can't replace a declared test matrix.

## Left out

A layout tree verdict, generic DOM matching, a per-change accept command, a custom image comparator, Figma comparison, a database and an MCP server. Frame-by-frame browser control through `HeadlessExperimental.beginFrame` isn't supported on macOS, and freezing the page with `Page.setWebLifecycleState` made captures less repeatable.

## Known limits

- Screenshots can't see behavior, so a removed `href` passes until aria snapshots exist. Hover states, open menus, dialogs and carousel slides past the first aren't captured yet either.
- A page wider than a phone screen can't be fully compared, because script scrolling can't pan across it. The report lists the uncompared width and height for each size.
- Blocked third parties aren't compared, including consent banners and embedded players loaded from another origin. Replayed responses stay frozen until the references are replaced, so a vendor's own change won't show.
- Playwright routes only the first request of a redirect chain, so a first-party request that redirects to a third party can't be blocked or saved. The report lists those hosts. Pixels still decide, so one that varies fails the comparison.
- A page that keeps changing fails as unstable. Stet reports that and doesn't work around it, because it can point to a real layout problem.
- A site that never stops making first-party network requests will time out at the load check.
- Only Chromium runs today. Playwright's WebKit is useful coverage but isn't branded Safari.
- Front-end parity can't show that Gutenberg markup is valid or that a setting moved into the editor. Those need separate editor checks.
- Playwright 1.64.1 fails to read PNGs on Node 27 alpha, so `devEngines` pins Node 24.
