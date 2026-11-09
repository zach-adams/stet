# Stet

Stet checks whether a code change altered how a website renders. You save references from a known-good copy of a local site, make your change and run `stet compare`. Stet fails if a saved page renders differently, at up to seven screen sizes and in every hover, focus, open or pressed state it can reach, and its report says what changed and where.

Stet was built for refactoring WordPress themes and blocks, where the code changes and the site should look exactly the same. It's quick enough to run after each edit, and it prints its own guide for AI coding agents so they can check their work as they go. It runs on [Playwright](https://playwright.dev) and Chromium.

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
- A site served locally, at `localhost`, `127.0.0.1` or a host ending in `.local`, `.test`, `.localhost`, `.ddev.site` or `.lndo.site`. Stet refuses any other host unless you add `--allow-live`.

Stet is developed and tested on macOS.

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

   Stet remembers these pages. To save every published page of a WordPress site:

   ```bash
   wp post list --post_type=page --post_status=publish --field=url | xargs stet save-references https://site.test
   ```

2. Make your change, then compare. This checks every saved page at desktop and a 360px phone, at rest and in its hover, focus and open states. It takes about 4 to 8 seconds per page and size.

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

`--size <name>` runs a single size, `--replay <pattern>` saves and replays a third party a page needs, such as an embedded form, and `--allow-live` runs against a site that isn't local.

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

Stet saves third-party fonts, stylesheets and images with the references and replays them. It blocks other third-party requests and lists them in each report, because they change between runs. `--replay` saves and replays one a page needs.

Stet only runs Chromium today. [Known limits](docs/design.md#known-limits) lists the rest.

## Where files go

References and results live in `~/.local/state/stet/<host>/`, or in `$XDG_STATE_HOME/stet/<host>/` when that's set. A failed `--full` comparison leaves its expected, actual and diff images in that folder's `results/`.

Stet doesn't write to your site or its repository. While it presses controls, it aborts every request other than a GET and cancels navigation.

## Contributing

```bash
pnpm format
pnpm check   # formatting, lint, types and tests
```

The tests drive Chromium against fixture pages and take a few minutes. [docs/typescript-style.md](docs/typescript-style.md) has the code conventions. [AGENTS.md](AGENTS.md) has the rules for changing Stet, and they apply to people too.

## License

[MIT](LICENSE)
