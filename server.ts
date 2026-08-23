import { serve, type HTMLBundle } from "bun";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { documentPath, writePages } from "./document";
import { writeFavicon } from "./favicon";
import { ALIASES, PAGES } from "./manifest";
import { writeSitemap } from "./sitemap";
import { PREFIX as WALL, artworkRoute, wall, type R2Bucket, type WallidEnv } from "./worker/wall/index";
import { sqliteD1 } from "./worker/wall/sqlite";
import { TEST_SECRET } from "./worker/wall/turnstile";

// All three before anything reads for them: importing a document is what
// resolves its `<link rel="icon">` href, the documents themselves do not exist
// until `writePages` runs, and the asset routes below enumerate `public/` —
// which is where `sitemap.xml` is written. On a clean checkout none of the
// three generated inputs is there yet.
await writeFavicon();
await writePages();
await writeSitemap();

/**
 * One document per manifest entry.
 *
 * Imported by path rather than by a literal specifier, which is what lets this
 * loop exist at all — Bun resolves an HTML import into a bundle it serves and
 * hot-reloads, and it does that for a computed path the same as a written one.
 */
const documents = new Map<string, HTMLBundle>(
  await Promise.all(
    PAGES.map(
      async page => [page.name, (await import(documentPath(page.name))).default] as const,
    ),
  ),
);

/**
 * Manifest routes, in the order `Bun.serve` has to see them.
 *
 * The page that claims `"/"` becomes the catch-all and must come last. Every
 * other page is served at both spellings of its URL, because that is what the
 * deployment does: `html_handling: "auto-trailing-slash"` maps `/rules` onto
 * `rules.html`, and a dev server that answered only one of them would disagree
 * with production about a link somebody had already shared.
 */
const routes = Object.fromEntries(
  PAGES.flatMap(page => {
    const document = documents.get(page.name)!;
    return page.route === "/"
      ? [["/*", document] as const]
      : [
          [page.route, document] as const,
          [`${page.route}.html`, document] as const,
        ];
  }).sort(([a], [b]) => (a === "/*" ? 1 : b === "/*" ? -1 : 0)),
);

const aliases = Object.fromEntries(
  ALIASES.map(({ from, to, status }) => [
    from,
    () => Response.redirect(new URL(to, server.url), status),
  ]),
);

/**
 * `public/` at the root, mirroring what the build copies into `dist`.
 *
 * Enumerated at boot rather than matched with a wildcard: `/:file` would sit in
 * front of the catch-all and have to decide, per request, whether a miss is a
 * missing asset or a route the page should render. One entry per real file has
 * no such ambiguity. Recursive, because Cloudflare serves `dist/` as a tree and
 * does not care how deep a file sits.
 */
const assets = Object.fromEntries(
  (await readdir("public", { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => `${entry.parentPath}/${entry.name}`.slice("public/".length))
    .map(path => [`/${path}`, new Response(Bun.file(`./public/${path}`))]),
);

/**
 * The wall's endpoints, served here rather than only by `wrangler dev`.
 *
 * This server is a `Bun.serve`, not a Worker, so without this the wall's routes
 * do not exist in development at all — the page's fetch fails and the board
 * reads as empty, which is a bad way to build the one part of this site that is
 * about other people being there.
 *
 * It runs the *same router* the Worker runs, over the same SQL and the same
 * migrations, against `bun:sqlite`. What it does not run is Cloudflare: no edge
 * cache, no real D1, no R2, no Turnstile-shaped latency. `bunx wrangler dev`
 * remains the thing to reach for when the question is about the platform rather
 * than about the wall.
 */
const DB = ".wrangler/state/wallid-dev.sqlite";
mkdirSync(".wrangler/state", { recursive: true });

/**
 * R2, as a directory.
 *
 * The bucket is three methods and content-addressed keys, so a local
 * implementation is genuinely the same contract rather than a stub with holes
 * in it: `put` writes a file named by the hash, `get` reads it back. What is
 * missing is only what R2 adds around that — no lifecycle rules, no bucket
 * metadata, no eventual consistency to trip over.
 */
const ART_DIR = ".wrangler/state/artwork";
mkdirSync(ART_DIR, { recursive: true });

const localBucket: R2Bucket = {
  async get(key) {
    const file = Bun.file(`${ART_DIR}/${key}`);
    if (!(await file.exists())) return null;
    return { body: file.stream(), httpMetadata: { contentType: file.type } };
  },
  async put(key, value) {
    await Bun.write(`${ART_DIR}/${key}`, value as Uint8Array);
  },
  async delete(key) {
    await Bun.file(`${ART_DIR}/${key}`).delete();
  },
};

/**
 * `.dev.vars` if it is there, published test values if it is not.
 *
 * Wrangler reads that file; `Bun.serve` does not, and it deliberately is not an
 * `.env` — these are Worker secrets, and the two should not be one file. A
 * clone with no `.dev.vars` still gets a working wall up to the point where
 * money is involved: Turnstile falls back to Cloudflare's always-passes test
 * secret, so the challenge is still verified for real, and the checkout route
 * refuses with "payments are not configured" rather than pretending.
 */
const devVars = async (): Promise<WallidEnv> => {
  const file = Bun.file(".dev.vars");
  const text = (await file.exists()) ? await file.text() : "";
  const read = (name: string) =>
    text.match(new RegExp(`^${name}\\s*=\\s*"?([^"\n]*)"?`, "m"))?.[1] || undefined;

  return {
    WALLID: sqliteD1(DB),
    ART: localBucket,
    WALL_SECRET: read("WALL_SECRET") ?? "a-development-pepper",
    TURNSTILE_SECRET: read("TURNSTILE_SECRET") ?? TEST_SECRET,
    STRIPE_SECRET_KEY: read("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: read("STRIPE_WEBHOOK_SECRET"),
    WALL_ADMIN_TOKEN: read("WALL_ADMIN_TOKEN") ?? "development",
    WALL_BLOCKLIST: read("WALL_BLOCKLIST"),
    SITE_URL: process.env.SITE_URL,
  };
};

const env = await devVars();

/**
 * Named routes rather than one `/wall/*`, because a wildcard over the whole
 * prefix would have to decide per request whether a path is an endpoint or a
 * page — the same ambiguity the asset routes are enumerated to avoid.
 */
const wallRoutes = Object.fromEntries(
  ["i", "c/:key/:version", "quote", "h/:cell", "mine", "artwork", "checkout", "webhook", "hide"].map(
    path => [
      `${WALL}${path}`,
      async (request: Request) => {
        // The address the Worker reads. Cloudflare sets it at the edge; here
        // there is no edge, and Turnstile's replay check needs something.
        const headers = new Headers(request.headers);
        if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", "127.0.0.1");

        const answered = await wall(new Request(request, { headers }), env);
        if (!answered) return new Response("not the wall", { status: 404 });
        return uncached(answered);
      },
    ],
  ),
);

/**
 * Cache headers, dropped on the way out.
 *
 * The Worker serves chunk bodies at version-keyed URLs with `immutable` and a
 * year of `max-age`, which is sound in production because a chunk's version
 * only ever increases — a given URL's body genuinely cannot change.
 *
 * A development database breaks that promise on purpose. Clear the wall and buy
 * something new, and chunk `0_0` is back at version 1 with different contents,
 * so the browser answers `/wall/c/0_0/1` out of its own disk cache and shows a
 * claim that no longer exists.
 */
function uncached(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

const server = serve({
  routes: {
    ...wallRoutes,
    "/img/:key": async (request: Request) =>
      (await artworkRoute(request, env)) ?? new Response("no", { status: 404 }),
    // Served straight off disk, matching the absolute `/fonts/...` URL in
    // `styles.css`. Keeping them out of the bundler is what stops Bun inlining
    // them into the stylesheet as base64.
    "/fonts/:file": req => {
      const file = Bun.file(`./fonts/${req.params.file}`);
      return new Response(file, {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      });
    },
    ...aliases,
    ...assets,
    // Every page last, so the catch-all among them cannot shadow an asset.
    ...routes,
  },
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`wallid → ${server.url}`);
