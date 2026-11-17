import { sizes } from './sizes.ts';

export const sizeNames = sizes.map((size) => size.name).join(', ');

export const overview = `Stet checks whether a change altered what a site renders, by comparing it with references saved from a known-good state. AI agents: run \`stet skills get core\` first.

  stet save-references <url> [page ...]   Save how these pages render now, at all seven sizes.
  stet compare <url> [page ...]           Compare with the references at desktop and small-phone, at rest and with hover, focus and closed details open. Never changes references.
  stet compare <url> --full               Also compare all seven sizes, every menu, tab and dialog, and real screenshots, before calling a change done.
  stet accept-changes <url> [page ...]    Make what the last compare reported as changed on these pages their new references. Only after the user approves.
  stet list                               Show sites and pages with references.
  stet skills get core                    Print how to use Stet, written for AI agents.
  stet help <topic>                       Explain a command, or one of: sizes, third-parties, files.

Pages are paths or full URLs on the same site. With none, save-references uses <url> itself, compare uses every saved page and accept-changes every page the last compare reported, unless <url> names one.

  --size <name>       Only one size: ${sizeNames}.
  --replay <pattern>  With save-references, also save and replay third parties whose URL matches, such as an embedded form's scripts.
  --user-approved     Required by accept-changes, and by save-references to replace pages that already have references. Only after the user approves.
Exit codes: 0 nothing changed, 1 something changed or couldn't be compared, 2 the command was refused.`;

const sizeRows = sizes
  .map(({ name, use }) => `  ${name.padEnd(15)}${use.viewport.width} x ${use.viewport.height}`)
  .join('\n');

/** Longer explanations, printed by `stet help <topic>` and `stet <command> --help`. */
export const topics = new Map(
  Object.entries({
    'save-references': `stet save-references <url> [page ...] [--size <name>] [--replay <pattern>] [--user-approved]

Saves how pages render now as their references, at all seven sizes. Later
compares check the site against them, so save from a version you know is
right, such as your main branch before a change.

<url> is the site, such as https://site.test. Pages are paths or full URLs on
that site. With none, it saves <url> itself. Stet remembers every page it
saves, and a compare without pages checks them all.

If any page or size can't be captured, for example because it never held
still or returned an error, no references change.

Replacing pages that already have references needs --user-approved, because
new references hide any regression made since the old ones were saved.
References belong to an address, so another project served at the same one
shares them. Run \`stet list\` first.

Options:
  --size <name>       Save only this size.
  --replay <pattern>  Also save and replay third-party requests whose URL
                      matches this regular expression, such as the scripts
                      of an embedded form. The pattern is remembered, and
                      later patterns add to it. See \`stet help third-parties\`.
  --user-approved     Replace pages that already have references.

Examples:
  stet save-references https://site.test / /about/ /contact/
  stet save-references https://site.test /contact/ --replay 'hsforms' --user-approved

To save every page in a sitemap, strip the domain from each URL, because a
sitemap lists the live site's addresses:
  curl -s https://site.test/sitemap.xml | grep -o '<loc>[^<]*' \\
    | sed -E 's|<loc>https?://[^/]*||' | xargs stet save-references https://site.test`,

    compare: `stet compare <url> [page ...] [--full] [--size <name>]

Compares how pages render now with their references. It never changes
references.

<url> is the site, such as https://site.test. Pages are paths or full URLs on
that site. With none, it compares every saved page, unless <url> names one,
such as https://site.test/about/.

A plain compare checks each page at desktop and small-phone, and takes about 1
to 8 seconds per page and size. For each it compares:
  - the pixels each layer paints, read from Chromium's paint record, including
    parts of the page that are off screen, such as hidden carousel slides
  - the accessibility tree, so a changed link or renamed button fails even
    when no pixel changes
  - how many elements set each cursor and pointer-events value, and how many
    transitions and animations they have
It repeats these with every element hovered at once, every focusable element
focused and pressed at once, and every closed details element open. Timers,
animations, video and random numbers are frozen, so a carousel shows the same
slide on every run. A change to the HTML that doesn't change what the page
shows, such as an added wrapper element, still passes.

--full adds the other five sizes, real screenshots of every screen, and every
menu, tab and dialog Stet finds, each pressed for real. Screenshots pass a
color 1 level off out of 255, and some up to 3 off in blue. It takes up to
about 45 seconds per page and size. Run it before calling a change done.

A pass says nothing about pages without references, form submissions,
controls the report lists as not driven, or third parties the report lists as
blocked. A plain compare also doesn't open menus, tabs or dialogs.

While Stet presses controls, it aborts every request other than a GET and
cancels navigation. It still loads each page several times, like a visitor
would, and the page's own scripts run while it loads. Runs against one site
wait their turn.

Options:
  --full         Compare all sizes, real screenshots and every control.
  --size <name>  Compare only this size.

Exit codes:
  0  Nothing changed in what was compared.
  1  Something changed or couldn't be compared. The report says what.
  2  The command was refused. The message says why.

The report lists each page and size that changed. When screenshots differ, it
also names the folder of expected, actual and diff images. \`stet skills get core\`
explains every line a report can print.

Examples:
  stet compare https://site.test
  stet compare https://site.test /about/ --size tablet
  stet compare https://site.test --full`,

    'accept-changes': `stet accept-changes <url> [page ...] --user-approved [--size <name>]

Makes what the last compare saw on these pages their new references, so later
compares show only what changed after it. Use it when a reported change was
intended. It captures nothing.

With no pages, it accepts every page the last compare reported as changed,
unless <url> names one. With --size, it accepts only that size.

Only what the last compare covered is accepted. After a plain compare, --full
still shows the change at the other sizes, in controls and on screen, until
you accept a --full run too. Changes the last compare couldn't finish
comparing can't be accepted, so fix what stopped it and compare again.

Prefer this to saving references again, which captures everything and would
take in changes nobody was shown.

Options:
  --user-approved  Required, because accepting a change hides it from every
                   later compare.
  --size <name>    Accept only this size.

Example:
  stet accept-changes https://site.test /about/ --user-approved`,

    list: `stet list

Shows each site that has references and the pages saved for it. Sites are
keyed by address, such as localhost:3000, so check here before saving, in
case another project served at the same address already has references.`,

    skills: `stet skills list
stet skills get <name>

Prints guides written for AI agents. \`stet skills get core\` explains how to
check a change with Stet and how to read every line of a report. People can
read it too.`,

    sizes: `Stet captures at these sizes, in CSS pixels:

${sizeRows}

A plain compare uses desktop and small-phone. --full and save-references use
all seven. The tablets and phones emulate touch devices. Every size renders at
a pixel ratio of 1 to keep captures fast. --size <name> picks one.`,

    'third-parties': `Stet treats every local server as part of the site, and compares what it
serves as it is now. Local servers are localhost and 127.0.0.1 on any port,
private network addresses such as 192.168.1.20, and hosts ending in
.localhost, .test, .local, .internal, .lan, .home.arpa, .ddev.site or
.lndo.site. A page on https://site.test that loads its CSS from a Vite server
on localhost:5173 is compared with that CSS.

Any other host than the site's own is a third party. Stet saves third-party
fonts, stylesheets and images with the references and replays them. It blocks
third-party scripts, data requests and frames, because they change between
runs, and lists them in each report. So a consent banner or video embed isn't
compared.

If a blocked script draws something a page needs, such as an embedded form,
save the references again with a pattern that matches its URL:
  stet save-references https://site.test /contact/ --replay 'hsforms' --user-approved

Replayed responses stay frozen until the references are replaced, so a
vendor's own change won't show. On a staging or live site, assets from a CDN
on another host count as third party too, so a change to them won't show.`,

    files: `Stet keeps references and results in ~/.local/state/stet/<host>/, or in
$XDG_STATE_HOME/stet/<host>/ when that's set. <host> is the site's address,
such as localhost_3000 for localhost:3000.

  site.json    The saved pages and replay pattern.
  references/  The references.
  results/     What the last compare saw. A failed --full compare leaves its
               expected, actual and diff images here.

References belong to an address, so two projects served at the same one share
them. Serve each project on its own port or hostname. Save and compare on the
same machine, because fonts and rendering differ between machines.`,
  }),
);
