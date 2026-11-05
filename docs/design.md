# Design

Stet answers one question: did this change alter what these pages render in the captured states? It can't prove a site still looks and works the same, because anything uncaptured stays unknown.

## What decides pass or fail

Pixels decide, and any changed pixel fails. Three checks run for each page and size, because each sees what the others can't:

- **Paint record.** `compare` reads each compositor layer's paint record through `LayerTree` and rasterizes it with `replaySnapshot`, without the compositor. It compares a hash of those pixels plus each layer's size and transform. Carousel position and in-flight motion can't change what a layer paints, so this is identical on the first read across fresh loads, at about 2 seconds per page and size. It also sees off-screen carousel slides and the full width of a page wider than a phone. The drawing commands are stored only to explain a failure, because harmless reordering changes them while the pixels stay the same.
- **Aria snapshot.** Pixels can't see where a link goes or what a control is called, so a removed `href` passes every pixel check. Playwright's snapshot ignores wrapper elements, so a DOM-changing refactor still passes.
- **Screenshots.** `compare --full` adds one real screenshot per screen. Compositing effects, such as a carousel layer's opacity, don't appear in the paint record, so screenshots stay as the check before calling a change done. They can't see an off-screen slide. They pass a color 1 level off out of 255, and some up to 3 off in blue, because a logo on a few phone screens varies by one level between loads. The paint record still compares exact pixels.

The paint record and aria snapshot repeat in every state below, so what's hidden at rest gets compared too.

Width and height are also compared, so a page can't shrink or grow unnoticed.

All of this stays correct when a refactor changes the DOM, such as replacing a custom block with core blocks. A DOM or layout tree comparison gets both directions wrong. It passes a changed image source or SVG fill when the boxes match, and it reports a removal and an addition when a wrapper shifts index-based paths. Geometry and styles may explain a failure, but they never make one pass.

## States

A walker that drives each control, reads the whole page and puts it back took 56 to 76 seconds per page and size, and it only sampled hover and focus on one element per look. Nearly all of that went on one full read per state and on waiting. Stet removes the waiting and most of the reads. Run alone, `compare` takes about 4 to 8 seconds per page and size. `--full` takes about 26 to 47 on the pages that prototype was measured on, and every one of its elements is now covered. A page with few controls takes a few seconds, and height matters too, because it sets how many reads each state takes. Reuse of a layer Chromium hasn't repainted looked like a further saving, but its `paintCount` doesn't follow forced states: 913 of 2,339 reuses would have been wrong.

**Pooling.** Rather than test each element, force a state on all of them at once with `CSS.forcePseudoState` and read the page once. Robert Dorfman proposed the same idea in 1943 for screening World War II draftees: mix many samples and test the mixture, and test individually only if it comes back positive. A passing pool answers for every element in one read. A failing one needs no second round, because the drawing commands say where it changed and the page says what's there. `compare` reads the pools for hover, focus with press, and focus on containers when a page has any, plus every closed details element opened together, since those stay in flow and can't hide each other.

Pooling can hide a change when elements share a state a visitor could never put them in together, so a rule loses to another that wouldn't apply at the same time. Only one element can have focus, so a focusable container and what's inside it get separate reads. Known limits has the measured rate.

Transitions are off while a state is forced, because Chromium doesn't cull an element while its transform is transitioning, so a forced button could stay in the recording of a scroll position 7,000px away from it. Focus goes only on what can take focus. On anything else, the browser's own stylesheet draws a focus ring no visitor could see, which would fail a harmless added wrapper. Before the focus reads, Stet presses a real Tab and then blurs, because a page that hides focus rings after mouse input, as some themes do, takes the clicks that open details for a mouse. One such theme hid every focus ring on 23 of 50 pages that way. Forced states are filed under node ids, so the walk keeps one `DOM.getDocument` throughout, because a new one leaves the old states on with no way to clear them.

**Finding controls.** `DOMDebugger.getEventListeners` with `depth: -1` lists every listener on the page in one call, in about a millisecond, which finds controls that have no ARIA. Markup finds the rest: `summary`, tabs, `aria-expanded`, `aria-controls`, `popovertarget` and `commandfor`.

**Driving them with `--full`.** A control that reveals something gets a second read with hover forced, so a link inside an open menu gets its hover state compared. What it revealed is then pressed while it's still open, and only what it revealed, with anything that closes it last, so a later tab or a Close button can't hide what's being explored. Controls inside closed details are pressed the same way, before the details close. Reads stay few:

- Tabs take one tab from each list per read, because they replace each other only within a list.
- Disclosures press together while they all stay open and what they revealed doesn't overlap. If not, the group splits in half and each half tries again, so an accordion takes one read and a mega menu takes one per panel. A panel collapsed with `height: 0` counts as visible to `checkVisibility`, so what appeared is judged by the room it takes up.
- Everything else takes one read each, because it may open over something else.

Pressing can't change the site or leave the page. Non-GET requests are aborted, new windows are refused, and navigations are cancelled through the Navigation API, because aborting a navigation request replaces the page with an error page. A control that does nothing is still compared, so one that stops working fails. A page stops at 60 reads, and the report names any control it found but didn't drive.

The verdict is a sorted list of state hashes without labels, so renaming or reordering controls in the markup passes as long as every state renders the same. Labels and drawing commands are kept beside the references only to explain a failure.

## Time

Time itself was the last source of variation, and what made waiting necessary:

- **Timers.** `page.clock` freezes them from before the first script, and running a second of them takes about a millisecond. So a hover menu's delay costs nothing, and how long a request took can't change what a page shows, including where an autoplaying carousel has got to. The clock starts at a fixed date, so scripts that print a date repeat as well.
- **CSS animations.** `Animation.setPlaybackRate` at 100,000 makes them all reach their end in one frame, including ones `getAnimations()` can't list, such as an opening `details` element's height. Endless ones are cancelled.
- **Random numbers.** `Math.random` is seeded, because scripts shuffle logos and pick slides.
- **Video.** `play()` does nothing and autoplay is stopped, so video stays on its first frame. Video draws outside the paint record, so its layer is compared by size and place, and its first frame with `--full`. The browser's own video controls are hidden, because their buffered bar and loading spinner follow download timing, so a player gaining or losing them isn't noticed.

Chromium's own `Emulation.setVirtualTimePolicy` also fast-forwards timers, and it was tried first. It stops frames while paused, so screenshots hang unless nothing has changed since the last frame, and it can't let a page load while frozen. `page.clock` works in JavaScript and leaves rendering alone.

## Capture

Full-page screenshots are out, because they disturb the page. Measured on a real site, one full-page capture fires `resize`, briefly narrows the viewport so a `(max-width: 100px)` media query flips even at 1920, and makes the browser pick and download different `srcset` files (5 to 11 requests per page, against 0 for a viewport capture). Repeated captures also moved a carousel 68px in 2 of 8 loads. Waiting for two identical screenshots hides some of this and adds to the rest.

Each capture does the following, in order:

1. Save or replay third-party fonts, stylesheets and images, and block third-party scripts, data requests and frames unless their URL matches `--replay`. A third party that varies between runs can't be compared. Blocking everything would remove fonts and CDN images from many sites, and scripts are what vary. Blocked form scripts remove content the theme styles, which the `--replay` hint in each save report points at.
2. Load the page, starting each worker's first load half a second apart, because two local sites answered 502 at six full page loads at once and never at four. Scroll instantly to start lazy loading, run timers, and fail if a visible image or font didn't load or the page redirected. An overloaded server gets two more tries.
3. Reset the screen with `scrollIntoView` before each scroll. When a page grows on phone emulation, scroll anchoring pans the visual viewport, and `scrollTo` can't undo that even though `scrollY` reads 0.
4. After any change, run timers, wait for requests, finish animations, and wait for page height and scroll offsets to hold.
5. Read the paint record at scroll stops, because Chromium records only about 4000px past the viewport. A layer's drawing commands are reduced to what was drawn and where, because raw logs are megabytes of curve points.
6. Walk the states.
7. With `--full`, load the page again and take the screenshots. A separate load means every read above takes the same path whether screenshots follow or not.

Runs against one site wait their turn, because three at once made a local site answer 502 even for static files, and runs share a `results/` folder. A killed run's lock is ignored because its process is gone.

## No per-site files

A site is identified by its URL. `save-references` records the pages and replay pattern in `site.json` beside the references, so `compare` needs only the URL. There's nothing to configure in the repo, and the page list stays with the references it describes. Non-local hosts are refused without `--allow-live`, because a free-form URL makes production one typo away.

## References

- `compare` never writes references, and a missing reference fails.
- `save-references` refuses to replace any page that has references without `--user-approved`. New pages don't need approval. It captures into an empty folder and promotes the result only if everything succeeds, because Playwright keeps an unstable capture when it overwrites a reference, and a failed run must not leave some references replaced.
- There is no per-change accept, because partial updates can produce a reference no browser ever rendered. Replacement happens per page and size.
- A failed load fails before comparison, so a blank image or error page can't become an accepted reference through `compare`. That check covers the response status, redirects, visible images and fonts.
- Saved third-party responses live with the references and change only when they do.
- References store a hash for the paint record, not its pixels, so a page and size costs about 100 KB without screenshots, including every state. Images for a failure come from `--full`.

## Built

URL-based commands, a built-in agent guide, the three checks above in every state, third-party saving and blocking, a text report that names changed layers, drawing commands, links, screens and nearby elements, and fixture tests in `tests/`.

Capture uses six common screen sizes, plus a 768 tablet just below WordPress's 782 breakpoint, where columns stop stacking, because none of those six falls between 415 and 799. `compare` runs desktop and a 360 phone while editing, with hover, focus and open details. `compare --full` runs all seven and drives every control.

## Next, in order

1. Capture repeatedly during `save-references` to expose unstable pages. Unstable never counts as unchanged.
2. Record provenance with each reference: theme commit, built asset hash and content snapshot identity. A theme commit alone can't identify ignored build output or database content.
3. Add exclusions with a stated reason, printed in every report.
4. Declare expected changes. The default is no visual change. An intended redesign lists which pages may change, and anything else fails.
5. Add widths around each site's breakpoints.
6. Run WebKit and Firefox on representative templates before a migration signs off, with separate references.

## Deferred

- CSS rule knockout can suggest candidates, but individually harmless deletions can fail together and untested states stay unknown. CSS coverage can list what no captured state applied, which is a candidate list and not proof a rule is unused.
- Ownership tracking needs more than matched rules, which are inputs to the cascade and not a full attribution of each value.
- A second running copy of the site isn't needed yet. A manually preserved reference environment covers recaptures.
- History and bisect need reproducible content and assets first.
- A width sweep may suggest widths to test, but it misses color, crop and typography changes and can't replace a declared test matrix.

## Left out

A layout tree verdict, generic DOM matching, per-site config files, a per-change accept command, a custom image comparator, Figma comparison, a database and an MCP server. Frame-by-frame browser control through `HeadlessExperimental.beginFrame` isn't supported on macOS, and freezing the page with `Page.setWebLifecycleState` made captures less repeatable.

## Known limits

- Pooling hid nothing in testing, but a page could still arrange it. Deleting each state rule in turn, at a desktop and a phone size, was caught 171 of 171 times on four pages of one site and the home pages of three others, counting rules whose deletion showed when only their own elements were forced. Changing one control's hover or focus at a time on one home page was caught 143 of 143 times. A fifth site's baseline varied with nothing broken, because its slider advances as the clock moves, so its 38 of 41 can't be judged either way.
- A press can hide the rest of what was revealed, such as a menu link that opens a dialog and closes the menu. Whatever that leaves unpressed is named as not driven.
- A real screenshot can vary by a fraction of a pixel where a composited element sits at a fractional position, because its text is sometimes snapped to whole pixels, depending on when the layer was drawn. One of five sites shows this, as `Screens that differ` with no layer or text change, and it can't be fixed with `--disable-lcd-text` or `--disable-threaded-animation`. A tolerance would need approval. Paint and states aren't affected.
- Focus inside shadow DOM and rules using `:not(:hover)` aren't reached, because forcing a state on everything leaves nothing outside it.
- Exclusive details are opened together with their `name` lifted, so losing exclusivity itself isn't seen.
- A control driven by a listener on `document` and no markup clue isn't found.
- Controls are pressed with `click()` and synthetic mouse events, so a handler that checks `isTrusted` or reads the mouse position behaves differently from a visitor's.
- `LayerTree` is an experimental protocol domain, so upgrading the pinned Playwright could break the paint record, and any upgrade needs new references.
- A page wider than a phone screen can't be fully screenshotted, because script scrolling can't pan across it. The report lists the width and height that only the paint record covers.
- A cross-origin iframe doesn't appear in the paint record, and blocked frames are replaced with blank documents.
- Blocked third parties aren't compared, including consent banners and embedded players. Replayed responses stay frozen until the references are replaced, so a vendor's own change won't show.
- Playwright routes only the first request of a redirect chain, so a first-party request that redirects to a third party can't be blocked or saved. The report lists those hosts. Pixels still decide, so one that varies fails the comparison.
- A page that keeps changing in layout fails as unstable, or as painted differently. Stet reports that and doesn't work around it, because it can point to a real layout problem.
- Requests can finish in a different order between loads, so a script that shows whichever arrived first still varies.
- A site that never stops making first-party network requests will time out at the load check.
- Any other load that makes a local server answer 502 past the retries stops the run with a clear message instead of reporting a change.
- A failure's explanation pairs layers by their order, so if a change reorders layers it can describe the wrong pair. This affects only the explanation, never the verdict.
- Only Chromium runs today. Playwright's WebKit is useful coverage but isn't branded Safari.
- Front-end parity can't show that Gutenberg markup is valid or that a setting moved into the editor. Those need separate editor checks.
- Playwright 1.64.1 fails to read PNGs on Node 27 alpha, so `devEngines` pins Node 24.
