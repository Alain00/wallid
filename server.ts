import { serve, type HTMLBundle } from "bun";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { documentPath, writePages } from "./document";
import { writeFavicon } from "./favicon";
import { ALIASES, PAGES } from "./manifest";
import { writeSitemap } from "./sitemap";
import { PREFIX as WALL, artworkRoute, wall, type R2Bucket, type WallidEnv } from "./worker/wall/index";
import {
  bumpMeta,
  cellsInBox,
  insertPendingClaim,
  recountClaimed,
  settleClaim,
  type D1Database,
} from "./worker/wall/db";
import { newClaimId } from "./worker/wall/identity";
import { CHUNK, isValidRect, type Rect } from "./src/wall/geometry";
import { quote } from "./src/wall/pricing";
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
    /*
     * The test secret, always — the matching half of the test site key
     * `Turnstile.tsx` pins in development.
     *
     * A real secret here would refuse every token the dev page can produce,
     * since that page is on the test key and localhost is not on the real
     * widget's hostname list. A machine set up for production has a real
     * secret in `.dev.vars`, so reading it was the bug: two halves from
     * different pairs, and "could not verify you are human" on every write.
     *
     * Nothing is weakened by this. `TEST_SECRET` is Cloudflare's published
     * always-passes secret, it exists for exactly this, and it can only ever be
     * read by this file — which is the development server.
     */
    TURNSTILE_SECRET: TEST_SECRET,
    STRIPE_SECRET_KEY: read("STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: read("STRIPE_WEBHOOK_SECRET"),
    WALL_ADMIN_TOKEN: read("WALL_ADMIN_TOKEN") ?? "development",
    WALL_BLOCKLIST: read("WALL_BLOCKLIST"),
    SITE_URL: process.env.SITE_URL,
    /* Reading the visitor count. Absent from a fresh clone and from most
     * `.dev.vars`, which is the ordinary case: `/wall/pulse` then answers
     * `null` and the chip does not render. Filling them in points development
     * at the production dataset, which is the only place heartbeats exist —
     * nothing local writes one. */
    PULSE_ACCOUNT_ID: read("PULSE_ACCOUNT_ID"),
    PULSE_READ_TOKEN: read("PULSE_READ_TOKEN"),
  };
};

const env = await devVars();

/**
 * Named routes rather than one `/wall/*`, because a wildcard over the whole
 * prefix would have to decide per request whether a path is an endpoint or a
 * page — the same ambiguity the asset routes are enumerated to avoid.
 */
const wallRoutes = Object.fromEntries(
  ["i", "pulse", "c/:key/:version", "quote", "h/:cell", "mine", "artwork", "checkout", "webhook", "hide"].map(
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
 * God mode: the wall, without Stripe.
 *
 * Two routes that place and unplace claims directly, and they exist *only in
 * this file*. That is the whole security design and it is worth stating plainly
 * rather than relying on a flag: `server.ts` is the development server, it is
 * not bundled, it is not deployed, and `wrangler.jsonc` points `main` at
 * `worker/index.ts` instead. A route that can mint free cells cannot be
 * switched on in production by an environment variable that got set by mistake,
 * because in production the code is not there.
 *
 * What they are for: everything about this wall that is hard to look at is hard
 * because filling it costs money and a Stripe redirect. Testing how a crowded
 * board reads at four zoom levels, whether a takeover animates sensibly,
 * whether the tile renderer copes with sixteen logos in one chunk — all of it
 * needs a wall with things on it, and none of it is a payments problem.
 *
 * The path is deliberately the real one. `/wall/dev/settle` runs `quote`,
 * `insertPendingClaim` and `settleClaim` — the same pricing, the same
 * constraints, the same chunk-version bumps the webhook does — so a wall built
 * with it is a wall the production code would have produced. Only the payment
 * is missing.
 */
const godRoutes = {
  /*
   * Place a claim, priced as the wall would price it.
   *
   * `quote` against what is currently held, so taking a cell from somebody
   * still costs what a takeover costs and the price ladder in a test wall
   * climbs the way a real one does. The claim is settled in the same batch
   * shape the webhook uses, with a synthetic event id — which also means the
   * idempotency key is a real one and settling the same god claim twice is
   * refused by the same primary key that refuses a Stripe redelivery.
   */
  [`${WALL}dev/settle`]: async (request: Request) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return Response.json({ error: "expected JSON" }, { status: 400 });

    const rect: Rect = {
      x: Number(body.x),
      y: Number(body.y),
      w: Number(body.w),
      h: Number(body.h),
    };
    if (!isValidRect(rect)) return Response.json({ error: "not a rectangle on the wall" }, { status: 400 });

    const db = env.WALLID;
    const rows = await cellsInBox(db, rect.x, rect.y, rect.x + rect.w - 1, rect.y + rect.h - 1);
    const held = new Map(rows.map(row => [`${row.x},${row.y}`, row.price_cents]));
    const priced = quote(rect, (x, y) => {
      const priceCents = held.get(`${x},${y}`);
      return priceCents === undefined ? null : { priceCents };
    });

    const at = Math.floor(Date.now() / 1000);
    const id = newClaimId(at);

    await insertPendingClaim(db, {
      id,
      ...rect,
      label: String(body.label ?? "god"),
      url: String(body.url ?? "https://example.com/"),
      imageKey: body.image ? String(body.image) : null,
      imageSource: body.image ? String(body.imageSource ?? "upload") : null,
      totalCents: priced.totalCents,
      prices: priced.cells.map(cell => cell.priceCents),
      // A fixed owner rather than the caller's cookie: everything god mode
      // places belongs to the same imaginary person, which is what makes
      // `/wall/mine` show a plausible list rather than one claim per browser
      // session you happened to be in when you placed it.
      ownerHash: "god",
      email: null,
      at,
    }).run();

    await db.batch([
      ...settleClaim(db, {
        eventId: `god_${id}`,
        sessionId: `god_${id}`,
        claim: { id, cells: priced.cells.map(c => ({ x: c.x, y: c.y, priceCents: c.priceCents })) },
        amountCents: priced.totalCents,
        at,
      }),
      recountClaimed(db),
    ]);

    return Response.json(
      { claimId: id, totalCents: priced.totalCents, prices: priced.cells.map(c => c.priceCents) },
      { headers: { "cache-control": "no-store" } },
    );
  },

  /*
   * Unplace: a rectangle, or the whole wall.
   *
   * There is no production equivalent and there should not be — a wall where
   * cells can be taken back is not the promise the front page makes. Here it is
   * the point: a test wall you cannot clear is a test wall you use once.
   *
   * The chunk versions are bumped for the same reason the settle path bumps
   * them: a body is cached under its version for a year, so cells deleted
   * without a bump stay on screen until the browser's disk cache is cleared by
   * hand. `uncached` below covers this server's own responses; the version is
   * what covers everything downstream of them.
   */
  [`${WALL}dev/free`]: async (request: Request) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const db: D1Database = env.WALLID;

    if (body?.all) {
      const chunks = await db.prepare("SELECT cx, cy FROM chunks").all<{ cx: number; cy: number }>();
      await db.batch([
        db.prepare("DELETE FROM cells"),
        db.prepare("DELETE FROM history"),
        db.prepare("UPDATE claims SET status = 'lost'"),
        db.prepare("INSERT INTO meta (k, v) VALUES ('cents', 0) ON CONFLICT (k) DO UPDATE SET v = 0"),
        recountClaimed(db),
        ...chunks.results.map(chunk =>
          db
            .prepare("UPDATE chunks SET version = version + 1 WHERE cx = ?1 AND cy = ?2")
            .bind(chunk.cx, chunk.cy),
        ),
      ]);
      return Response.json({ freed: "all" }, { headers: { "cache-control": "no-store" } });
    }

    const rect: Rect = {
      x: Number(body?.x),
      y: Number(body?.y),
      w: Number(body?.w),
      h: Number(body?.h),
    };
    if (!isValidRect(rect)) return Response.json({ error: "not a rectangle on the wall" }, { status: 400 });

    const rows = await cellsInBox(db, rect.x, rect.y, rect.x + rect.w - 1, rect.y + rect.h - 1);
    if (!rows.length) return Response.json({ freed: 0 }, { headers: { "cache-control": "no-store" } });

    const claims = new Set(rows.map(row => row.claim_id));
    // The chunk a cell is in, computed rather than read: `cellsInBox` returns
    // the cell's own columns, and the chunk coordinates are a division away.
    const chunks = new Map(
      rows.map(row => {
        const chunk = { cx: Math.floor(row.x / CHUNK), cy: Math.floor(row.y / CHUNK) };
        return [`${chunk.cx}_${chunk.cy}`, chunk];
      }),
    );
    const refunded = rows.reduce((sum, row) => sum + row.price_cents, 0);

    await db.batch([
      ...rows.map(row => db.prepare("DELETE FROM cells WHERE x = ?1 AND y = ?2").bind(row.x, row.y)),
      // A claim with nothing left is not a claim. Anything still holding cells
      // elsewhere stays active, which is what makes freeing half a rectangle
      // behave.
      ...[...claims].map(id =>
        db
          .prepare(
            `UPDATE claims SET status = 'lost'
             WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM cells WHERE claim_id = ?1)`,
          )
          .bind(id),
      ),
      ...[...chunks.values()].map(chunk =>
        db
          .prepare("UPDATE chunks SET version = version + 1 WHERE cx = ?1 AND cy = ?2")
          .bind(chunk.cx, chunk.cy),
      ),
      // The takings counter follows the cells, or a cleared wall goes on
      // claiming it earned thousands.
      bumpMeta(db, "cents", -refunded),
      recountClaimed(db),
    ]);

    return Response.json({ freed: rows.length }, { headers: { "cache-control": "no-store" } });
  },
};

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
    ...godRoutes,
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
