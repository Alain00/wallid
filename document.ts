/**
 * The HTML documents, generated from `manifest.ts`.
 *
 * These files used to be authored by hand, one per page, and were ~80% the same
 * bytes: charset, viewport, colour scheme, the favicon link, the whole OG and
 * Twitter block, and a duplicated `@font-face` rule that carried a duplicated
 * comment explaining why it had to be duplicated. Four facts differed. Those
 * four live in the manifest now and the rest lives here, once.
 *
 * Generated rather than checked in, and written before anything reads for them,
 * exactly as `favicon.ts` and `llms.ts` already do — both the build and the dev
 * server call all three at start-up, so a fresh clone has no missing-file step.
 * The output is gitignored; `apps/site/*.html` is not a file you edit.
 */
import { PAGES, type Page } from "./manifest";
import { absolute } from "./origin";

/** Attribute-safe. Everything interpolated below lands inside `content="…"`. */
const attr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * The card image, shared by every page.
 *
 * A screenshot of the hero rather than a generated composition, because the
 * hero already *is* the pitch — wordmark, tagline, a wallid and the code that
 * produced it — and a card that redraws that into a poster would say the same
 * thing less credibly. One image for the whole site for the same reason: the
 * pages are one product.
 *
 * Stated root-relative and made absolute at the tag, from `origin.ts`.
 * Crawlers will not resolve a relative one against the page they found it on.
 */
const OG_IMAGE = "/og.png";
const OG_IMAGE_ALT =
  "The wallid landing page: the wordmark, a pale blue wallid, and the four lines of JSX that render it.";

/**
 * `@font-face`, inline, rather than in `styles.css`.
 *
 * Bun's CSS bundler resolves and base64-inlines every `url()` it can reach —
 * ~188 KB of font buried in the stylesheet, render-blocking and re-fetched on
 * any class change. Marking them external fixes `bun build` but the dev server
 * takes no such option, so the two environments disagreed. An inline `<style>`
 * is left alone by both, and the files are served straight from `/fonts` in dev
 * and copied there at build time.
 *
 * The preload tags for these two faces are injected by `build.ts` rather than
 * written here, and for a related reason: the bundler resolves and hashes any
 * font URL it finds in an HTML file, so a preload written here would come out
 * pointing at `geist-variable-a1b2c3.woff2` while these rules still ask for the
 * unhashed path — two downloads of the same font, strictly worse than none.
 */
const FONTS = `<style>
      @font-face {
        font-family: "Geist";
        src: url("/fonts/geist-variable.woff2") format("woff2");
        font-weight: 100 900;
        font-display: swap;
      }

      @font-face {
        font-family: "Geist Mono";
        src: url("/fonts/geist-mono-variable.woff2") format("woff2");
        font-weight: 100 900;
        font-display: swap;
      }

      /*
        The hand.

        Every page's heading is set in it, plus the running total in the buy
        panel, so unlike the other site this borrowed from it is not an
        after-a-click face — it is above the fold on first paint and belongs in
        the preload list in \`build.ts\`.

        Which is also why it is a *Latin* subset rather than one cut to a single
        sentence. Six headings that will be reworded is not a charset anybody
        can keep in step by hand, and the failure mode of getting it wrong is
        silent: the missing glyphs fall back to whatever cursive the system has,
        which on most machines is nothing, and then to the sans. That showed up
        here as a heading whose first two letters were a serif.

        One weight, not a range: instanced at 600, which is a third of the bytes
        for a face used at exactly one weight everywhere it appears.
      */
      @font-face {
        font-family: "Caveat";
        src: url("/fonts/caveat.woff2") format("woff2");
        font-weight: 600;
        font-display: swap;
      }
    </style>`;

/**
 * The page's JSON-LD, if it declares any.
 *
 * `<` is escaped rather than the string being trusted: a `</script>` inside a
 * JSON string ends the block early in an HTML parser, which is the one way a
 * data island becomes markup. Nothing in the manifest contains one today, and
 * that is precisely the kind of thing that stops being true later.
 *
 * Written as one `application/ld+json` block per node rather than as an array
 * in a single block. Both are valid and consumers accept either; separate
 * blocks mean a page can add an identity without reformatting the one it has.
 */
/**
 * How this page wants to be indexed: a canonical, or a refusal.
 *
 * The two are exclusive on purpose. A canonical says "of the several URLs that
 * reach this page, here is the one that is the entity" — the site answers on
 * two hostnames (`www` redirects to the apex) and `auto-trailing-slash` means
 * `/editor` and `/editor/` both resolve, so every page here has more than one
 * spelling and exactly one of them should be the one that counts.
 *
 * A page the manifest marks unindexable is making the opposite claim, and
 * saying both at once is incoherent — a canonical is an instruction to index
 * *this* URL. So those pages get `noindex` and no canonical. There are two:
 * the wall preview, which renders fixture data, and the 404 document, which is
 * a page every wrong URL resolves to and none of them should be indexed as.
 */
function indexing(page: Page): string {
  return page.indexable === false
    ? '<meta name="robots" content="noindex, follow" />'
    : `<link rel="canonical" href="${attr(absolute(page.route))}" />`;
}

function schema(page: Page): string {
  return (page.schema ?? [])
    .map(
      node =>
        `\n    <script type="application/ld+json">${JSON.stringify(node).replace(/</g, "\\u003c")}</script>`,
    )
    .join("");
}

/** One page's document. Exported for `document.test.ts`, which asserts on the
 * head rather than on a built artifact — every fact it checks is decided here. */
export function render(page: Page): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <!--
      Generated from \`manifest.ts\` by \`document.ts\`. Editing this file is
      editing build output: it is rewritten on every build and every dev boot,
      and it is gitignored. Change the manifest instead.
    -->
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <!--
      The mark is generated too — see \`favicon.ts\`. Referenced relatively so
      the bundler hashes it into \`dist\` and rewrites this href; an absolute
      \`/favicon.svg\` is a resolve error, not a passthrough.
    -->
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <title>${attr(page.title)}</title>
    <meta name="description" content="${attr(page.description)}" />
    ${indexing(page)}

    <meta property="og:type" content="website" />
    <meta property="og:url" content="${attr(absolute(page.route))}" />
    <meta property="og:title" content="${attr(page.ogTitle)}" />
    <meta
      property="og:description"
      content="${attr(page.ogDescription ?? page.description)}"
    />
    <meta property="og:image" content="${attr(absolute(OG_IMAGE))}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${attr(OG_IMAGE_ALT)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:creator" content="@alain_0012" />

    ${FONTS}${schema(page)}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${attr(page.entry)}"></script>
  </body>
</html>
`;
}

/** Where a page's document lands, relative to this directory. */
export const documentPath = (name: string) =>
  new URL(`./${name}.html`, import.meta.url).pathname;

/** Materializes every document on disk. Called before the build and before dev. */
export async function writePages() {
  for (const page of PAGES) await Bun.write(documentPath(page.name), render(page));
}
