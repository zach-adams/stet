# Stet

Stet checks whether a code change altered how a website renders. You save references from a known-good version of your site, make your change and run `stet compare`. Stet fails if a saved page renders differently, at up to seven screen sizes and in every hover, focus, open or pressed state it can reach, and its report says what changed and where.

Stet is built for refactors, where the code changes and the site should look exactly the same, such as moving to a new CSS framework, upgrading a component library or rewriting templates. It works with any site Chromium can load, from static HTML to a CMS or a JavaScript framework, whether it runs on your machine or on a staging server. It's quick enough to run after each edit, and it prints its own guide for AI coding agents so they can check their work as they go. It runs on [Playwright](https://playwright.dev) and Chromium.

The name is the proofreading mark for "let it stand".

## What it compares

For each page and screen size, Stet compares:

- the pixels each layer paints, read from Chromium's paint record, including parts of the page that are off screen, such as hidden carousel slides
- the accessibility tree, so a changed link or a renamed button fails even when no pixel changes
- how many elements set each `cursor` and `pointer-events` value, and how many transitions and animations they have, so a button that `pointer-events: none` stops from taking clicks fails even when it looks the same
- real screenshots of every screen, with `--full`

The first three checks repeat with every element hovered at once, every focusable element focused at once and every closed `details` element open. With `--full` they also repeat as Stet opens each menu, tab and dialog it finds. Screenshots show the page at rest. Timers, animations, video and random numbers are frozen, so a carousel or a delayed menu shows the same thing on every run. A refactor that changes the HTML but not what the page shows, such as an added wrapper element, still passes.

[docs/design.md](docs/design.md) explains each decision, what was measured and the known limits.

## Requirements

- [pnpm](https://pnpm.io). The repository pins the pnpm and Node versions it uses, and pnpm downloads them.
- A site to check, at any URL. Most runs use a copy on your own machine, such as a dev server or a production build, because that's where code changes happen first.

Stet is developed and tested on macOS. It hasn't been tested on Linux. On Windows, run it in WSL, because `stet` is a shell script.

## Install

```bash
git clone https://github.com/zach-adams/stet.git
cd stet
pnpm install
pnpm exec playwright install chromium
mkdir -p ~/.local/bin
ln -s "$PWD/bin/stet" ~/.local/bin/stet
```

If `~/.local/bin` isn't on your PATH, add it in your shell profile, or link `bin/stet` into another folder that is. Then run `stet` with no arguments. It prints every command and option.

## Quick start

1. Start from a version of the site you know is right, such as your main branch before the change. Save references for the pages your change could touch:

   ```bash
   stet save-references https://site.test / /about/ /contact/
   ```

   Stet remembers these pages. To save every page in a sitemap, strip the domain from each URL, because sitemaps list the live site's addresses:

   ```bash
   curl -s https://site.test/sitemap.xml | grep -o '<loc>[^<]*' | sed -E 's|<loc>https?://[^/]*||' | xargs stet save-references https://site.test
   ```

   If the sitemap lists other sitemaps, run this on one of those instead.

2. Make your change, then compare. This checks every saved page at desktop and a 360px phone, at rest and in its hover, focus and open states. It takes about 1 to 8 seconds per page and size, depending on how long the page is and how many elements it has.

   ```bash
   stet compare https://site.test
   ```

3. Before you call the change done, compare everything. This adds the other five sizes, real screenshots, and every menu, tab and dialog. It takes up to about 45 seconds per page and size, depending on how many controls the page has.

   ```bash
   stet compare https://site.test --full
   ```

4. If Stet reports a change you meant to make, accept it. What the last comparison saw on those pages becomes their new references, so later comparisons show only what changed after it.

   ```bash
   stet accept-changes https://site.test /about/ --user-approved
   ```

`compare` exits with one of these codes:

| Code | Meaning |
| --- | --- |
| 0 | Nothing changed in what was compared. |
| 1 | Something changed or couldn't be compared. |
| 2 | Stet refused to run. The message says why. |

The other commands also exit with 2 when Stet refuses them.

## Dev servers and production builds

Stet works with dev servers and with production builds, but save references from the same kind of server you compare against. A dev server adds its own overlays, such as Next.js's dev tools button, so references saved from a production build fail against a dev server. A production build or preview server, such as `next start`, `vite preview` or `astro preview`, gives the steadiest results, because a dev server compiles pages on demand.

Stet treats every local server as part of your site. A page at `https://site.test` that loads its CSS and JavaScript from a Vite dev server at `localhost:5173` is compared with those files as they are now. Local servers are `localhost` and `127.0.0.1` on any port, private network addresses such as `192.168.1.20`, and hosts ending in `.localhost`, `.test`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.ddev.site` or `.lndo.site`.

## Reading a report

A failing comparison lists each page and size that changed and what changed there. This one came from `--full`:

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

Fix a changed page size first, because a page that grows moves everything below it. `Text, links or controls changed` is a diff of the accessibility tree, and `Images` points to the expected, actual and diff images. [Reading a failure](skills/core/SKILL.md#reading-a-failure) explains every line Stet can print.

## Commands

| Command | What it does |
| --- | --- |
| `stet save-references <url> [page ...]` | Saves how these pages render now, at all seven sizes. Replacing pages that already have references needs `--user-approved`. |
| `stet compare <url> [page ...]` | Compares with the references at desktop and small phone. With no pages, it compares every saved page. It never changes references. |
| `stet compare <url> --full` | Also compares all seven sizes, real screenshots and every control it finds. |
| `stet accept-changes <url> [page ...] --user-approved` | Makes what the last `compare` reported the new references, without capturing again. |
| `stet list` | Shows the sites and pages that have references. |
| `stet skills get core` | Prints the guide for AI agents. |

`--size <name>` runs a single size, and `--replay <pattern>` saves and replays a third party a page needs, such as an embedded form.

## Screen sizes

| Name | Width x height |
| --- | --- |
| `large-desktop` | 2560 x 1440 |
| `desktop` | 1920 x 1080 |
| `small-desktop` | 1280 x 720 |
| `tablet` | 800 x 1280 |
| `small-tablet` | 768 x 1024 |
| `large-phone` | 414 x 896 |
| `small-phone` | 360 x 780 |

A plain `compare` uses `desktop` and `small-phone`, and `--full` uses all seven. The tablets and phones emulate touch devices. Every size renders at a pixel ratio of 1 to keep captures fast.

## Using Stet with an AI agent

Stet prints instructions for agents that match the installed version:

```bash
stet skills get core
```

Tell your agent to read them before it uses Stet. For example, add this line to your project's `AGENTS.md` or `CLAUDE.md`:

```markdown
Before and after a change that should leave the site looking the same, run `stet skills get core` and follow it.
```

Replacing references needs `--user-approved`, and the guide tells agents to ask you before passing it, because an agent that can replace references can approve its own regressions.

## What a pass means

A pass means nothing changed in what Stet captured on the saved pages and sizes. A plain `compare` doesn't open menus, tabs or dialogs, so run `--full` before calling a change done. Neither one covers:

- pages without references
- form submissions
- controls the report lists as not driven
- third-party scripts, data requests and frames, such as consent banners and video embeds

A third party is any host other than the site's own that isn't a local server. Stet saves third-party fonts, stylesheets and images with the references and replays them. It blocks other third-party requests and lists them in each report, because they change between runs. `--replay` saves and replays one a page needs. On a staging or live site, assets served from a CDN on another host count as third party too, so a change to them won't show.

Stet only runs Chromium today. [Known limits](docs/design.md#known-limits) lists the rest.

## Where files go

References and results live in `~/.local/state/stet/<host>/`, or in `$XDG_STATE_HOME/stet/<host>/` when that's set, such as `localhost_3000` for `localhost:3000`. A failed `--full` comparison leaves its expected, actual and diff images in that folder's `results/`.

References belong to an address, so two projects served at the same one, such as `localhost:3000`, share them. Serve each project on its own port or hostname, and check `stet list` before saving. Save and compare on the same machine too, because fonts and rendering can differ between machines and operating systems, so references from another one may fail where nothing changed.

Stet doesn't write to your site or its repository. While it presses controls, it aborts every request other than a GET and cancels navigation. A run against a live site still loads each saved page several times, like a visitor would, and the page's own scripts run while it loads.

## Contributing

```bash
git config core.hooksPath .githooks   # once, so each commit checks formatting, lint and types
pnpm format
pnpm check                            # formatting, lint, types and tests
```

The tests drive Chromium against fixture pages and take a few minutes. [docs/typescript-style.md](docs/typescript-style.md) has the code conventions. [AGENTS.md](AGENTS.md) has the rules for changing Stet, and they apply to people too.

## License

[MIT](LICENSE)
