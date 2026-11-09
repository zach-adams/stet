---
name: core
description: How to check whether a change altered what a local site renders. Read this before running any stet command.
---

# Stet

Stet compares what a local site renders with references saved from a known-good state, so you can show a refactor kept the site looking and linking the same. Refactors that change the DOM but not the render pass.

## The loop

1. Run `stet list` before editing. If the site or the pages your change could touch aren't listed, ask the user whether the site is in a known-good state. Once they confirm, save references:

   ```bash
   stet save-references https://site.test / /about/ /contact/
   ```

   Pages are paths or full URLs on the same site, and they're remembered. To save every page in a sitemap, strip the domain, because sitemaps list the live site's URLs. If the sitemap lists other sitemaps, use one of those:

   ```bash
   curl -s https://site.test/sitemap.xml | grep -o '<loc>[^<]*' | sed -E 's|<loc>https?://[^/]*||' | xargs stet save-references https://site.test
   ```

   Any list of paths or URLs works the same way, such as WP-CLI's on a WordPress site:

   ```bash
   wp post list --post_type=page --post_status=publish --field=url | xargs stet save-references https://site.test
   ```

2. Compare after each edit. This covers each page at rest, with closed details open, and with every element hovered, focused and pressed. It takes about 1 to 8 seconds per page and size, depending on the page's length and how many elements it has:

   ```bash
   stet compare https://site.test              # every saved page, at desktop and small-phone
   stet compare https://site.test /about/      # only this page
   ```

3. Compare everything before calling a change done. This adds the other five sizes, real screenshots, and every menu, tab, dialog and other control, each driven for real. Real screenshots pass a color 1 level off out of 255, and some up to 3 off in blue. It takes up to about 45 seconds per page and size, depending on how many controls it has:

   ```bash
   stet compare https://site.test --full
   ```

4. When the user approves a reported change as intended, accept it:

   ```bash
   stet accept-changes https://site.test /about/ --user-approved
   ```

   This makes what the last compare saw on those pages their references, so the next compare shows only what changed after it. It captures nothing. What that compare didn't cover keeps its old references, so after accepting a default compare, `--full` still shows the change at the other sizes, in controls and on screen until you accept that run too. Prefer this to saving references again, which captures every size and control and would take in changes nobody was shown.

Exit 0 means nothing changed in what was compared. Exit 1 means something changed or couldn't be compared, so fix it or report it. Exit 2 means the command was refused, and the message says why.

## Reading a failure

```text
changed: /about/ at desktop
  Page size changed from 1920x6604 to 1920x6605.
  Layer 1920x6604, now 1920x6605, painted differently:
    + text at 611.7,977 #CC091817
    - text at 611.7,977 #CC091717
  3 more layers moved.
  Text, links or controls changed:
  -    - /url: /contact/
  +    - /url: /contact-us/
  Screens that differ: 3 (1,359 pixels).
  Images: ~/.local/state/stet/site.test/results/parity--about--desktop
```

- `Page size changed` usually explains everything below it, so fix that first. Lower content moves when a page grows.
- `In the state "..."` names a state that renders differently, such as `hover on every element`, `all 8 closed details open`, `tab "Pricing"` or `hovering "Products"`. `Near` names the elements where the drawing changed. Fix the page at rest first, because a change at rest shows in every state.
- `no longer changes anything` means a control stopped working. `is gone` and `is new` mean a control was removed or added.
- `painted differently` lists the drawing commands that changed, with their position and color. Coordinates are in that layer's own space.
- `Its drawing commands match` means the position and color stayed the same but the content of a text or image didn't.
- `Cursors, clicks, transitions or animations changed` lists counts of `cursor` and `pointer-events` values, transitions and animations that changed, such as `+ pointer-events: none on 3 elements`. Pixels can't show these, so they can fail a page whose screens all match.
- `Layers changed` means Chromium split the page differently, often from `position`, `transform` or `will-change`. Run `--full` to see whether the pixels differ.
- `Text, links or controls changed` is a diff of the accessibility tree. A removed `href` or renamed control shows up here even when no pixel changes.
- `Screens that differ` and `Images` appear with `--full`. Open the `-diff.png` files to see the change. If that's the only line and the diff shows just the edges of text in one box, it may be text landing a fraction of a pixel differently rather than a change. Report it instead of calling it a regression or a pass.
- `never held still` means the page keeps changing, which Stet reports and won't pass.
- `could not compare` covers error statuses, redirects, images or fonts that didn't load, screens that never held still, and anything else that stopped a comparison partway. Changes listed with it were found before it stopped, and it may have missed others, so fix the cause and run it again before reporting or accepting them.
- `gateway error` means the local server stayed overloaded through several tries. Runs against one site wait their turn, so find what else is hitting it and try again.

## Rules

- Never pass `--user-approved` on your own. Both `accept-changes` and `save-references` use it to replace references, and an agent that replaces references can approve its own regressions. Ask the user, and use it only for the pages they approved.
- Use `--allow-live` only when the user asks for a run against a live site.
- Compare against the same kind of server the references came from. A dev server adds its own overlays, such as Next.js's dev tools button, so references saved from a production build fail against it. A production build or preview server gives the steadiest results.
- Report what a pass covers. `compare` doesn't drive menus, tabs or dialogs, so say so until `--full` has passed. Neither says anything about pages you didn't save, about form submissions, about the browser's own video controls, which are hidden, or about what a report lists as blocked or not driven. `Not driven` names controls Stet found but didn't press.
- Stet presses every control it finds, but it can't change the site. It aborts anything other than a GET request and cancels navigation.

## Third parties

Third-party fonts, stylesheets and images are saved with the references and replayed. Third-party scripts, data requests and frames are blocked, and each report lists them, so a consent banner or video embed isn't compared.

If a blocked script draws something the page needs, such as an embedded form, ask the user to approve replacing the references and save again with a URL pattern that matches it. The pattern is remembered:

```bash
stet save-references https://site.test /contact/ --replay 'hsforms' --user-approved
```

Replayed responses stay frozen until the references are replaced, so a vendor's own change won't show.

Run `stet` with no arguments for every option.
