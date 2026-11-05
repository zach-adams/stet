# Design

Stet answers one question: did this change alter what these pages render in the captured states? It can't prove a site still looks and works the same, because anything uncaptured stays unknown.

## What decides pass or fail

Pixels decide, and any changed pixel fails. Three checks run for each page and size, because each sees what the others can't:

- **Paint record.** `compare` reads each compositor layer's paint record through `LayerTree` and rasterizes it with `replaySnapshot`, without the compositor. It compares a hash of those pixels plus each layer's size and transform. Carousel position and in-flight motion can't change what a layer paints, so this is identical on the first read across fresh loads, at about 2 seconds per page and size. It also sees off-screen carousel slides and the full width of a page wider than a phone. The drawing commands are stored only to explain a failure, because harmless reordering changes them while the pixels stay the same.
- **Aria snapshot.** Pixels can't see where a link goes or what a control is called, so a removed `href` passes every pixel check. Playwright's snapshot ignores wrapper elements, so a DOM-changing refactor still passes.
- **Screenshots.** `compare --full` adds one real screenshot per screen. Compositing effects, such as a carousel layer's opacity, don't appear in the paint record, so screenshots stay as the check before calling a change done. They can't see an off-screen slide.

Width and height are also compared, so a page can't shrink or grow unnoticed.

All of this stays correct when a refactor changes the DOM, such as replacing a custom block with core blocks. A DOM or layout tree comparison gets both directions wrong. It passes a changed image source or SVG fill when the boxes match, and it reports a removal and an addition when a wrapper shifts index-based paths. Geometry and styles may explain a failure, but they never make one pass.

## Capture

Full-page screenshots are out, because they disturb the page. Measured on a real site, one full-page capture fires `resize`, briefly narrows the viewport so a `(max-width: 100px)` media query flips even at 1920, and makes the browser pick and download different `srcset` files (5 to 11 requests per page, against 0 for a viewport capture). Repeated captures also moved a carousel 68px in 2 of 8 loads. Waiting for two identical screenshots hides some of this and adds to the rest.

Each capture does the following, in order:

1. Save or replay third-party fonts, stylesheets and images, and block third-party scripts, data requests and frames unless their URL matches `--replay`. A third party that varies between runs can't be compared. Blocking everything would remove fonts and CDN images from many sites, and scripts are what vary. Blocked form scripts remove content the theme styles, which the `--replay` hint in each save report points at.
2. Load the page, scroll it instantly to start lazy loading, wait for network activity to stop, and fail if a visible image or font didn't load or the page redirected.
3. Reset the screen to the top with `scrollIntoView`. When a page grows during the scroll pass on phone emulation, scroll anchoring pans the visual viewport, and `scrollTo` can't undo that even though `scrollY` reads 0.
4. Before each read, finish animations and wait for page height and scroll offsets to hold, which also catches JavaScript smooth scrolling that `getAnimations()` can't see.
5. Read the paint record at scroll stops, because Chromium records only about 4000px past the viewport. Take the screenshots with `--full`.

## No per-site files

A site is identified by its URL. `save-references` records the pages and replay pattern in `site.json` beside the references, so `compare` needs only the URL. There's nothing to configure in the repo, and the page list stays with the references it describes. Non-local hosts are refused without `--allow-live`, because a free-form URL makes production one typo away.

## References

- `compare` never writes references, and a missing reference fails.
- `save-references` refuses to replace any page that has references without `--user-approved`. New pages don't need approval. It captures into an empty folder and promotes the result only if everything succeeds, because Playwright keeps an unstable capture when it overwrites a reference, and a failed run must not leave some references replaced.
- There is no per-change accept, because partial updates can produce a reference no browser ever rendered. Replacement happens per page and size.
- A failed load fails before comparison, so a blank image or error page can't become an accepted reference through `compare`. That check covers the response status, redirects, visible images and fonts.
- Saved third-party responses live with the references and change only when they do.
- References store a hash for the paint record, not its pixels, so a page and size costs about 30 to 60 KB without screenshots. Images for a failure come from `--full`.

## Built

URL-based commands, a built-in agent guide, the three checks above, third-party saving and blocking, a text report that names changed layers, drawing commands, links and screens, and fixture tests in `tests/`.

Capture uses six common screen sizes. `compare` runs desktop and a 360 phone while editing, and `compare --full` runs all six.

## Next, in order

1. Walk interaction states. Find details, expandable controls, tabs and popovers, drive each one, and record the result under its role and accessible name so wrappers don't break matching. Use `CSS.forcePseudoState` for hover and focus, and a real mouse for menus that open on `mouseenter`. A control that disappears or appears fails, and one that has no effect is listed. Use `page.clock` and a seeded `Math.random` for sites with JavaScript autoplay. Done when a planted hover change and a planted change in closed details both fail by name.
2. Label each changed region with the element at that position on the current page. Labels need no DOM matching. Done when an agent can name the changed element without opening an image.
3. Record provenance with each reference: theme commit, built asset hash and content snapshot identity. A theme commit alone can't identify ignored build output or database content.
4. Capture repeatedly during `save-references` to expose unstable pages. Unstable never counts as unchanged.
5. Add exclusions with a stated reason, printed in every report.
6. Declare expected changes. The default is no visual change. An intended redesign lists which pages may change, and anything else fails.
7. Add widths around each site's breakpoints.
8. Run WebKit and Firefox on representative templates before a migration signs off, with separate references.

## Deferred

- CSS rule knockout can suggest candidates, but individually harmless deletions can fail together and untested states stay unknown. CSS coverage can list what no captured state applied, which is a candidate list and not proof a rule is unused.
- Ownership tracking needs more than matched rules, which are inputs to the cascade and not a full attribution of each value.
- A second running copy of the site isn't needed yet. A manually preserved reference environment covers recaptures.
- History and bisect need reproducible content and assets first.
- A width sweep may suggest widths to test, but it misses color, crop and typography changes and can't replace a declared test matrix.

## Left out

A layout tree verdict, generic DOM matching, per-site config files, a per-change accept command, a custom image comparator, Figma comparison, a database and an MCP server. Frame-by-frame browser control through `HeadlessExperimental.beginFrame` isn't supported on macOS, and freezing the page with `Page.setWebLifecycleState` made captures less repeatable.

## Known limits

- Hover states, open menus, dialogs and the content of closed details aren't captured yet.
- `LayerTree` is an experimental protocol domain, so upgrading the pinned Playwright could break the paint record, and any upgrade needs new references.
- A page wider than a phone screen can't be fully screenshotted, because script scrolling can't pan across it. The report lists the width and height that only the paint record covers.
- A cross-origin iframe doesn't appear in the paint record, and blocked frames are replaced with blank documents.
- Blocked third parties aren't compared, including consent banners and embedded players. Replayed responses stay frozen until the references are replaced, so a vendor's own change won't show.
- Playwright routes only the first request of a redirect chain, so a first-party request that redirects to a third party can't be blocked or saved. The report lists those hosts. Pixels still decide, so one that varies fails the comparison.
- A page that keeps changing fails as unstable or painted differently. Stet reports that and doesn't work around it, because it can point to a real layout problem.
- A site that never stops making first-party network requests will time out at the load check.
- Local servers have limited capacity. One run at a time is fine, but three at once made a local site answer 502 even for static files. Stet stops with a clear message instead of reporting a change. Runs against one site also share a `results/` folder, so a later run replaces an earlier run's images.
- A failure's explanation pairs layers by their order, so if a change reorders layers it can describe the wrong pair. This affects only the explanation, never the verdict.
- Only Chromium runs today. Playwright's WebKit is useful coverage but isn't branded Safari.
- Front-end parity can't show that Gutenberg markup is valid or that a setting moved into the editor. Those need separate editor checks.
- Playwright 1.64.1 fails to read PNGs on Node 27 alpha, so `devEngines` pins Node 24.
