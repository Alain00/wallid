/**
 * Static build.
 *
 * Goes through `Bun.build` rather than the CLI because the Tailwind plugin has
 * to be passed as a plugin *object*. The CLI's `--plugin` flag does not apply
 * it to the CSS pipeline, which fails silently: `@theme` and `@apply` survive
 * into the output as unrecognized at-rules and the bundle ships uncompiled
 * Tailwind source. The size gate below is what makes that failure loud.
 */
import { cp, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { writePages } from "./document";
import { writeFavicon } from "./favicon";
import { ALIASES, PAGES } from "./manifest";
import { ORIGIN } from "./origin";
import { writeSitemap } from "./sitemap";

const OUT = "dist";

/**
 * Two independent checks, because they catch different failures.
 *
 * Surviving at-rules mean Tailwind did not run at all — the definitive compile
 * signal. The size ceiling catches something subtler: Tailwind running but
 * scanning too much, or fonts being inlined as data URIs instead of emitted as
 * files. Both compile cleanly and look fine until you check the number: either
 * mistake takes the stylesheet past 200 KB.
 *
 * The ceiling was 40 KB when one page compiled to ~25 KB. Two pages share one
 * stylesheet — Tailwind's scan is over the whole app, not per entrypoint — and
 * the editor's controls took it to ~39 KB, which left the gate firing on the
 * next ordinary change rather than on the failure it exists for. Raised with
 * that headroom restored; the failure mode it catches is five times this.
 *
 * Raised again, to 60 KB, when the wall replaced the second section: a canvas,
 * a docked panel, an expression strip and their responsive variants took it to
 * ~51 KB. Checked rather than assumed before moving it — no `base64` in the
 * output, no surviving at-rules, 779 rules, and 9.8 KB over the wire gzipped,
 * which is the number that actually reaches anybody. The scan is doing its job;
 * the app simply has more interface in it than it did.
 */
const CSS_CEILING = 60_000;
const UNCOMPILED = ["@theme", "@apply", "@tailwind"];

await rm(OUT, { recursive: true, force: true });

/*
 * The three generated inputs, all before the bundle.
 *
 * The favicon has to exist for a document to link it, so the bundler can hash
 * it into `dist` and rewrite the href; the documents themselves are what the
 * bundler is pointed at below; `sitemap.xml` lands in `public/`, which is
 * copied wholesale further down. None of the three is in the repo, so a fresh
 * clone builds only because all three run here.
 */
await writeFavicon();
await writePages();
await writeSitemap();

const result = await Bun.build({
  /*
   * One document per page, one bundle per document.
   *
   * The editor is not a route on the landing page, and this is where that
   * decision is enforced rather than merely intended: a client-side route would
   * put its slider, its twenty controls and its layout readback into the bundle
   * every visitor downloads before the hero paints — the exact cost the whole
   * rewrite pass below exists to manage. Separate entrypoints mean the landing
   * page cannot regress from anything another page grows into, and that holds
   * for every page added to the manifest, not just the two that exist today.
   *
   * Pages are rewritten differently afterwards, per their manifest entry; see
   * `finish`.
   */
  entrypoints: PAGES.map(page => `./${page.name}.html`),
  outdir: OUT,
  minify: true,
  plugins: [tailwind],
  // React ships its development build unless NODE_ENV is pinned — worth ~300 KB
  // here, and dev-only warnings have no audience on a static landing page.
  define: { "process.env.NODE_ENV": '"production"' },
  /*
   * The same prefix `bunfig.toml` gives the dev server, so a value reaches the
   * bundle by the same rule in both. Only `BUN_PUBLIC_*`: everything else in
   * the environment of whatever machine runs this build stays out of a file
   * served to the public, which is the failure this prefix exists to prevent.
   *
   * The wall's Turnstile *site* key comes through here. It is public by design
   * — it is rendered into the widget — but it is per-deployment, and a fork
   * building this site should get its own rather than inherit ours.
   */
  env: "BUN_PUBLIC_*",
});

// Copied rather than bundled: `styles.css` references these at an absolute
// `/fonts/...` URL specifically so the CSS bundler leaves them alone. See the
// comment on the @font-face rules for why.
await cp("fonts", `${OUT}/fonts`, { recursive: true });

// The OG image, at the stable path the meta tags name. Copied rather than
// bundled for exactly that reason: a hashed `og-a1b2c3.png` would be correct
// for a `<link>` the bundler rewrites and useless in a `<meta content>` it
// does not.
await cp("public", OUT, { recursive: true });

/*
 * `_redirects`, for the alias URLs.
 *
 * Cloudflare's asset pipeline reads this file out of the assets directory and
 * answers the redirects itself, which is the whole reason the aliases are
 * redirects rather than routes: a route would be a billed Worker invocation
 * per request, and `run_worker_first` in `wrangler.jsonc` exists to keep the
 * document side of this site off the Worker entirely.
 */
await Bun.write(
  `${OUT}/_redirects`,
  `${ALIASES.map(({ from, to, status }) => `${from} ${to} ${status}`).join("\n")}\n`,
);

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Reported rather than applied: `og:url`, `og:image`, the canonical and every
// URL inside the JSON-LD are written absolute by `document.ts` from this same
// constant, so there is nothing left to rewrite here. Logged because a build
// that silently shipped cards pointing at the wrong host has happened before.
console.log(`  origin                   ${ORIGIN}`);

let failed = false;

for (const output of result.outputs) {
  const bytes = output.size;
  const name = output.path.split("/").pop()!;

  if (name.endsWith(".css")) {
    const css = await Bun.file(output.path).text();
    const survived = UNCOMPILED.filter(rule => css.includes(rule));
    const ok = bytes <= CSS_CEILING && survived.length === 0;
    failed ||= !ok;

    console.log(
      `${ok ? "✓" : "✗"} ${name.padEnd(24)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`,
    );
    if (survived.length) {
      console.error(`  ${survived.join(", ")} survived — Tailwind did not run`);
    } else if (bytes > CSS_CEILING) {
      console.error(`  over ${CSS_CEILING / 1000} KB — content scan is too broad`);
    }
  } else {
    console.log(`  ${name.padEnd(24)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
  }
}

if (failed) process.exit(1);

/**
 * Everything below rewrites a built document for first paint.
 *
 * The measurements behind it, all mobile Lighthouse on the landing page: it
 * scored 94, and the reason was that nothing rendered until 113 KB of gzipped
 * JavaScript had arrived. Lighthouse's network simulation puts *any* script
 * that starts fetching before the first paint onto the critical path, so the
 * bundle's download time was the first paint, whatever else the page did.
 *
 * Three rewrites, worth roughly +2, +1 and +3 points, and each was measured on
 * its own before being kept:
 *
 *   1. prerender  — put real markup in the document instead of an empty root
 *   2. inline CSS — one round trip instead of two
 *   3. defer JS   — take the bundle off the pre-paint critical path
 *
 * The full-page prerender was tried and is *not* what this does: prerendering
 * the wall as well took the document from 1.6 KB to 28 KB and scored 93, worse
 * than doing nothing. `Wall` renders its field only after mount, so what lands
 * in the landing page is the hero, the chat, the closing section and the wall's
 * heading — every word on the page, and none of its sixty SVGs.
 *
 * Two of the three are page-level judgements rather than facts about the build,
 * which is why they are parameters rather than done unconditionally — and why
 * they are stated per page in `manifest.ts`, next to the reasoning for each,
 * rather than here. The editor takes the stylesheet inline and neither of the
 * others; a page added tomorrow says which it wants in one field each.
 */
async function finish(
  name: string,
  { prerender, defer }: { prerender?: ReactNode; defer: boolean },
) {
  const page = `${OUT}/${name}`;
  let html = await Bun.file(page).text();

  const before = html.length;

  /*
   * 0. Preload both faces.
   *
   *    Injected here rather than written into the source HTML, and the reason is
   *    the same quirk the @font-face rules work around: Bun resolves font URLs it
   *    finds in HTML and emits hashed copies, so a `<link rel="preload">` written
   *    in the source file comes out pointing at `geist-variable-a1b2c3.woff2`
   *    while the stylesheet still asks for `/fonts/geist-variable.woff2`. That is
   *    two downloads of the same font — strictly worse than not preloading. The
   *    URLs below are the ones the CSS actually uses.
   *
   *    Worth doing because both faces are above the fold and the code snippet —
   *    set in the mono face — is the LCP element, so the font is on the critical
   *    path by definition. Without a preload the browser only discovers it after
   *    parsing the inline @font-face block.
   *
   *    `crossorigin` is required even though these are same-origin: fonts are
   *    always fetched in CORS mode, and a preload missing it primes a second,
   *    separate cache entry instead of the one the CSS will ask for.
   */
  html = html.replace(
    "</head>",
    // `caveat` is in the list because every page's heading is set in it, above
    // the fold. Preloading a face nothing renders would be a wasted download;
    // preloading this one is the difference between the heading arriving with
    // the page and arriving a beat after it.
    ["geist-variable", "geist-mono-variable", "caveat"]
      .map(
        f =>
          `<link rel="preload" href="/fonts/${f}.woff2" as="font" type="font/woff2" crossorigin>`,
      )
      .join("") + "</head>",
  );

  // 1. Prerender.
  if (prerender)
    html = html.replace(
      '<div id="root"></div>',
      `<div id="root">${renderToString(prerender)}</div>`,
    );

  // 2. Inline the stylesheet — it is render-blocking, and at ~7 KB gzipped it
  //    costs a whole round trip to save nothing. The file it came from is
  //    deleted after every page has been through here rather than now: two
  //    entrypoints can share one emitted stylesheet, and removing it under the
  //    second page's feet would fail the build on a file the first page already
  //    inlined correctly.
  const link = html.match(/<link rel="stylesheet"[^>]*href="\.\/([^"]+\.css)"[^>]*>/);
  if (!link) throw new Error(`no stylesheet <link> in ${name}`);

  const cssPath = `${OUT}/${link[1]}`;
  inlined.add(cssPath);
  html = html.replace(link[0], `<style>${await Bun.file(cssPath).text()}</style>`);

  /*
   * 3. Load the bundle from an inline script on `load` rather than from a
   *    `<script src>` the preload scanner finds while parsing.
   *
   *    This is the one change here with a real cost, so it is worth being plain
   *    about: it buys first paint by delaying interactivity. The page is fully
   *    *visible* as soon as the HTML lands, but its controls do not respond
   *    until the bundle has loaded and hydrated, a few hundred milliseconds
   *    later on a slow connection.
   *
   *    That trade is defensible on a landing page whose job is to be read, whose
   *    controls are an optional flourish rather than the reason anyone arrived,
   *    and where the alternative — shipping 113 KB before showing anything — is
   *    worse for the same visitor. It is *not* defensible on the editor, which
   *    is nothing but controls: a visible-but-dead editor is a broken editor,
   *    and it has no prerendered first frame worth protecting either way.
   *
   *    The honest way to shrink this cost further is to shrink the bundle: about
   *    51 KB of it is unused on first render, most of it the Radix popover and
   *    toggle-group that only the tuning panel needs. Code-splitting those behind
   *    the trigger would let this script load earlier.
   */
  if (defer) {
    const script = html.match(
      /<script type="module"[^>]*src="\.\/([^"]+\.js)"[^>]*><\/script>/,
    );
    if (!script) throw new Error(`no module <script> in ${name}`);

    html = html.replace(
      script[0],
      `<script>addEventListener("load",function(){var s=document.createElement("script");` +
        `s.type="module";s.src=${JSON.stringify(`/${script[1]}`)};document.body.appendChild(s)})</script>`,
    );
  }

  /*
   * 4. Root-relative every asset reference the bundler left as `./…`.
   *
   *    Both files sit in `dist` root, so this changes nothing about *which*
   *    file is fetched from `/index.html`. It matters for `/editor`: the page
   *    is served from a path with no extension, and a browser resolving
   *    `./chunk-abc.js` against `/editor/` — which is what a stray trailing
   *    slash produces — asks for a file that is not there. One `/` removes the
   *    class of bug rather than the instance.
   */
  html = html.replaceAll('="./', '="/');

  await Bun.write(page, html);

  console.log(
    `  ${`${name} (rewritten)`.padEnd(24)} ${(before / 1024).toFixed(1)} KB → ${(html.length / 1024).toFixed(1)} KB`,
  );
}

/** Stylesheets that ended up inline, dropped once every page has been through. */
const inlined = new Set<string>();

/*
 * Serially, not in parallel: `finish` writes into the shared `inlined` set and
 * the pages are two file writes, so there is nothing here worth racing.
 */
for (const page of PAGES) {
  await finish(`${page.name}.html`, {
    prerender: await page.prerender?.(),
    defer: page.defer,
  });
}

// Nothing else references them, so leaving them in `dist` would only be a
// second copy for a crawler to find.
for (const css of inlined) await rm(css);

