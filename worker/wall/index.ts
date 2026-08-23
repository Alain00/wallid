import { bodyFromRows, encodeChunk } from "../../src/wall/chunk";
import {
  MAX_SIDE,
  allChunks,
  cellKey,
  cellsIn,
  chunkKey,
  chunkOf,
  inBounds,
  isValidRect,
  parseChunkKey,
  type Held,
  type Rect,
} from "../../src/wall/geometry";
import { beats, quote, type Quote } from "../../src/wall/pricing";
import {
  cellHistory,
  cellsInBox,
  chunkCells,
  chunkVersions,
  claimById,
  claimsByOwner,
  counters,
  insertPendingClaim,
  markLost,
  recountClaimed,
  settleClaim,
  type D1Database,
} from "./db";
import {
  addressOf,
  hashToken,
  newClaimId,
  newToken,
  sameSecret,
  setCookie,
  tokenFrom,
} from "./identity";
import { checkLabel } from "./moderation";
import { fetchFavicon, keyFor, looksLikeKey, MAX_BYTES, normaliseUrl, sniff } from "./artwork";
import { createCheckout, refund, verifyWebhook } from "./stripe";
import { verifyTurnstile } from "./turnstile";

/**
 * The wall, over HTTP.
 *
 * The cache headers are as much of the design as the bodies. `wrangler.jsonc`
 * is built around assets being free and Worker requests being billed, so every
 * route here is a deliberate spend. What pays it back is that almost every
 * response is cached twice: a chunk body is `immutable` for a year under a URL
 * containing its version, so a client fetches any given body at most once ever,
 * and behind that the same answers sit in the edge cache, so a client that has
 * never been here is usually not a D1 read either.
 *
 * The rules themselves are not in this file. They are in `src/wall/pricing.ts`
 * and `src/wall/geometry.ts`, imported by both sides, because a client that
 * quotes a price the server would refuse is a buyer about to be surprised by
 * their own receipt.
 */

export const PREFIX = "/wall/";

/** Structural, like the D1 shims in `db.ts`, and for the same reason: this is
 * the whole of R2 the wall touches. */
export type R2Bucket = {
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export type WallidEnv = {
  WALLID: D1Database;
  ART: R2Bucket;
  WALL_SECRET: string;
  TURNSTILE_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  WALL_ADMIN_TOKEN?: string;
  WALL_BLOCKLIST?: string;
  SITE_URL?: string;
};

type Ctx = { waitUntil(promise: Promise<unknown>): void } | undefined;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });

/** A refusal the interface can render as a sentence. Every rejection on the
 * buying path says why, because "something went wrong" on a page where money
 * is about to move is the worst message this site could show. */
const refuse = (status: number, message: string) => json({ error: message }, { status });

const now = () => Math.floor(Date.now() / 1000);

/**
 * The edge cache, and what it is doing here.
 *
 * The cache headers below read as though something upstream honoured them, and
 * for a browser they are. Cloudflare is not that something: a Response a Worker
 * *constructs* is handed straight back to the eyeball, because the CDN caches
 * what comes back from an origin `fetch`, not what a Worker made up. Without
 * this, every cold client pays the full D1 cost of every chunk in its viewport,
 * and a loop over `curl` pays it as fast as it can ask.
 *
 * Worth wiring only to the GET routes whose URL is the whole of their identity.
 */
async function cached(request: Request, ctx: Ctx, build: () => Promise<Response>) {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return build();

  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await build();
  if (response.ok) {
    const copy = response.clone();
    if (ctx) ctx.waitUntil(cache.put(request, copy));
    else await cache.put(request, copy);
  }
  return response;
}

export async function wall(request: Request, env: WallidEnv, ctx?: Ctx): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.slice(PREFIX.length);
  const db = env.WALLID;

  /*
   * The index: every chunk's version, plus the two counters.
   *
   * Sixteen entries on a 128-cell wall, so it is served whole rather than cut
   * into regions the way an unbounded wall would have to be. That is the bound
   * paying for itself: there is exactly one index URL, everybody asks for it,
   * and it is the only request here that cannot be immutable.
   *
   * Thirty seconds. A stranger's claim appears within half a minute, which is
   * invisible on a wall — the buyer sees their own immediately, from the
   * response to their own checkout.
   */
  if (path === "i") {
    return cached(request, ctx, async () => {
      const [versions, totals] = await Promise.all([chunkVersions(db), counters(db)]);
      return json(
        { chunks: Object.fromEntries(versions.map(c => [c.key, c.version])), ...totals },
        { headers: { "cache-control": "public, max-age=30" } },
      );
    });
  }

  /*
   * A chunk body, at a version.
   *
   * The version is in the path rather than in a query string because it is part
   * of the identity of the bytes, not a parameter to them. `immutable` for a
   * year: a given URL's body genuinely cannot change, since any write to the
   * chunk produces a new version and therefore a new URL.
   *
   * The requested version is not checked against the current one. A stale URL
   * returns current contents under a `max-age` a client will honour for a year,
   * which sounds wrong and is the right trade: the alternative is a D1 read of
   * the chunks table on every body request to answer a question the index
   * already answered thirty seconds ago.
   */
  const chunkMatch = /^c\/([^/]+)\/(\d+)$/.exec(path);
  if (chunkMatch) {
    const chunk = parseChunkKey(chunkMatch[1]!);
    if (!chunk) return refuse(404, "no such chunk");
    return cached(request, ctx, async () => {
      const rows = await chunkCells(db, chunk);
      const body = bodyFromRows(chunk, Number(chunkMatch[2]), rows);
      return new Response(encodeChunk(body), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    });
  }

  /*
   * A quote.
   *
   * Priced server-side even though the client can price it itself from the
   * chunks it holds, and the duplication is the point: the client's number is
   * what somebody reads before they decide, and this one is what the checkout
   * is created against. Uncached, because a quote is about a wall that is
   * moving under it.
   */
  if (path === "quote" && request.method === "GET") {
    const rect = rectFromQuery(url);
    if (!rect) return refuse(400, `a rectangle up to ${MAX_SIDE} by ${MAX_SIDE}, on the wall`);
    const held = await heldOver(db, rect);
    return json(quote(rect, held), { headers: { "cache-control": "no-store" } });
  }

  /* A cell's whole life: who has held it and at what. The payoff of keeping
   * `history` forever, and the only page on this wall that is about time. */
  const cellMatch = /^h\/(\d{1,3})_(\d{1,3})$/.exec(path);
  if (cellMatch) {
    const x = Number(cellMatch[1]);
    const y = Number(cellMatch[2]);
    if (!inBounds(x, y)) return refuse(404, "no such cell");
    return json(
      { x, y, history: await cellHistory(db, x, y) },
      { headers: { "cache-control": "public, max-age=30" } },
    );
  }

  /* What this browser owns, and how much of it survives. The durable identity
   * is the cookie; there is no login on this wall. */
  if (path === "mine") {
    const token = tokenFrom(request);
    if (!token) return json({ claims: [] }, { headers: { "cache-control": "no-store" } });
    const claims = await claimsByOwner(db, await hashToken(token, env.WALL_SECRET));
    return json({ claims }, { headers: { "cache-control": "no-store" } });
  }

  /*
   * The artwork a buyer is proposing, resolved before they pay.
   *
   * Two ways in, one out. A `url` alone means "find my favicon", which is the
   * path most buyers take: they have a domain and no design intent, and being
   * asked for a square PNG before they can spend a dollar is where most of them
   * leave. A multipart `file` is the upload they reach for when the favicon
   * turns out to be a 16px blur.
   *
   * Stored in R2 *before* payment, deliberately. An image whose claim is never
   * paid for is a few KB under a content hash, which costs less than the
   * alternative: holding bytes in a session somewhere across a redirect to
   * Stripe and back, and losing the buyer's upload if they take too long
   * finding their card.
   *
   * Turnstile guards it, because this is the one endpoint a stranger can make
   * fetch arbitrary URLs and write to our bucket without paying anything.
   */
  if (path === "artwork" && request.method === "POST") {
    const address = addressOf(request);
    if (!address) return refuse(403, "no address");

    const form = await request.formData();
    if (!(await verifyTurnstile(form.get("turnstile"), env.TURNSTILE_SECRET, address))) {
      return refuse(403, "could not verify you are human");
    }

    const file = form.get("file");
    let bytes: Uint8Array | null = null;
    let source = "upload";

    if (file && typeof file !== "string") {
      if (file.size > MAX_BYTES) return refuse(413, "that image is over 256 KB");
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const site = normaliseUrl(String(form.get("url") ?? ""));
      if (!site) return refuse(400, "that does not look like an https address");
      const found = await fetchFavicon(site);
      if (!found) return refuse(404, "could not find an icon on that site");
      bytes = found.bytes;
      source = "favicon";
    }

    const type = sniff(bytes);
    if (!type) return refuse(415, "png, jpeg, webp or ico only");

    const key = await keyFor(bytes, type);
    await env.ART.put(key, bytes, { httpMetadata: { contentType: type } });
    return json({ key, source, type }, { headers: { "cache-control": "no-store" } });
  }

  /*
   * Checkout: write the claim as pending, then hand back Stripe's URL.
   *
   * The claim row exists before the payment because its id has to travel
   * through Stripe's metadata and come back on a webhook that may arrive twice.
   * Nothing about the wall changes here — no cell is touched, no price moves —
   * so an abandoned checkout leaves a pending row and nothing else.
   */
  if (path === "checkout" && request.method === "POST") {
    if (!env.STRIPE_SECRET_KEY) return refuse(503, "payments are not configured");

    const address = addressOf(request);
    if (!address) return refuse(403, "no address");

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return refuse(400, "expected JSON");

    if (!(await verifyTurnstile(body.turnstile, env.TURNSTILE_SECRET, address))) {
      return refuse(403, "could not verify you are human");
    }

    const rect: Rect = {
      x: Number(body.x),
      y: Number(body.y),
      w: Number(body.w),
      h: Number(body.h),
    };
    if (!isValidRect(rect)) return refuse(400, `a rectangle up to ${MAX_SIDE} by ${MAX_SIDE}, on the wall`);

    const label = checkLabel(String(body.label ?? ""), env.WALL_BLOCKLIST);
    if (!label.ok) return refuse(400, label.reason);

    const site = normaliseUrl(String(body.url ?? ""));
    if (!site) return refuse(400, "that does not look like an https address");

    const imageKey = body.image === null || body.image === undefined ? null : String(body.image);
    if (imageKey !== null && !looksLikeKey(imageKey)) return refuse(400, "unknown artwork");

    const email = typeof body.email === "string" && body.email.includes("@") ? body.email.slice(0, 320) : null;

    // Priced here rather than trusted from the client. The body carries a
    // rectangle, never an amount: a request that named its own price would be
    // a wall anybody can buy for a cent.
    const priced = quote(rect, await heldOver(db, rect));

    const at = now();
    const claimId = newClaimId(at);
    const token = tokenFrom(request) ?? newToken();

    await insertPendingClaim(db, {
      id: claimId,
      ...rect,
      label: label.value,
      url: site,
      imageKey,
      imageSource: imageKey ? String(body.imageSource ?? "upload") : null,
      totalCents: priced.totalCents,
      prices: priced.cells.map(c => c.priceCents),
      ownerHash: await hashToken(token, env.WALL_SECRET),
      email,
      at,
    }).run();

    const origin = env.SITE_URL ?? url.origin;
    const session = await createCheckout(env.STRIPE_SECRET_KEY, {
      claimId,
      label: label.value,
      cells: priced.cells.length,
      amountCents: priced.totalCents,
      email,
      successUrl: `${origin}/?claim=${claimId}`,
      cancelUrl: `${origin}/?cancelled=${claimId}`,
    });

    return json(
      { url: session.url, claimId, totalCents: priced.totalCents },
      { headers: { "cache-control": "no-store", "set-cookie": setCookie(token) } },
    );
  }

  /*
   * The webhook: where a payment becomes cells.
   *
   * Everything that makes this correct is in `settleClaim`'s batch rather than
   * here — the event id as a primary key, so a redelivery loses an INSERT and
   * rolls the whole thing back; the conditional cell upsert, so a cell can only
   * be taken by a price that beats it. What is left in this function is the
   * decision the batch cannot make: whether the claim won, and what to do with
   * the money if it did not.
   */
  if (path === "webhook" && request.method === "POST") {
    const raw = await request.text();
    const event = await verifyWebhook(
      raw,
      request.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET,
      now(),
    );
    // A 400 rather than a 401: Stripe retries on 5xx and gives up on 4xx, and a
    // signature that does not verify will not verify on the retry either.
    if (!event) return refuse(400, "bad signature");
    if (event.type !== "checkout.session.completed") return json({ ok: true });

    const session = event.data.object;
    if (session.payment_status !== "paid") return json({ ok: true });

    const claimId = session.metadata?.claim_id;
    if (!claimId) return json({ ok: true });

    const claim = await claimById(db, claimId);
    if (!claim) return refuse(404, "no such claim");
    if (claim.status === "active") return json({ ok: true, already: true });

    const rect: Rect = { x: claim.x, y: claim.y, w: claim.w, h: claim.h };
    const paid = paidQuote(claim.prices, rect);
    if (!paid) return refuse(500, "claim has no prices");

    /*
     * The race, decided.
     *
     * Compared per cell against what the wall costs *now*, not against what it
     * cost when the quote was made. Two buyers quoted the same cell, both paid,
     * and the slower one's money bought a price that is no longer enough.
     *
     * All or nothing. Charging somebody for a rectangle and handing them a
     * subset of it — "you got 9 of your 12 cells" — is a support conversation
     * rather than a product, and it is the shape of failure most likely to end
     * in a chargeback. One lost cell refunds the whole claim.
     */
    if (!beats(paid, await heldOver(db, rect))) {
      await db.batch([markLost(db, claim.id)]);
      if (env.STRIPE_SECRET_KEY && session.payment_intent) {
        await refund(env.STRIPE_SECRET_KEY, session.payment_intent);
      }
      return json({ ok: true, lost: true });
    }

    try {
      await db.batch([
        // Written at the prices actually paid rather than at the lower prices
        // the wall might currently be asking. The cell's floor is what somebody
        // put down for it, which is what makes the ratchet climb.
        ...settleClaim(db, {
          eventId: event.id,
          sessionId: session.id,
          claim: { id: claim.id, cells: paid.cells },
          amountCents: session.amount_total ?? claim.total_cents,
          at: now(),
        }),
        recountClaimed(db),
      ]);
    } catch {
      // The redelivery case, and the only one this catch is for: the payment
      // row's primary key already exists, so the batch rolled back and the
      // cells were written by the first delivery. Nothing to do and nothing to
      // report — a 500 here would make Stripe retry a settled claim forever.
      return json({ ok: true, already: true });
    }

    return json({ ok: true });
  }

  /*
   * Moderation: hide a claim.
   *
   * Hiding, never deleting, and never refunding. The cells stay held and stay
   * priced, because handing the wall back to whoever put something there would
   * make moderation a discount — buy a cell, post a slur, get the cell taken
   * off you and the price reset for your next attempt.
   */
  if (path === "hide" && request.method === "POST") {
    const auth = request.headers.get("authorization") ?? "";
    if (!env.WALL_ADMIN_TOKEN || !sameSecret(auth, `Bearer ${env.WALL_ADMIN_TOKEN}`)) {
      return refuse(401, "no");
    }
    const body = (await request.json().catch(() => null)) as { id?: string; reason?: string } | null;
    if (!body?.id) return refuse(400, "expected a claim id");

    const claim = await claimById(db, body.id);
    if (!claim) return refuse(404, "no such claim");

    const touched = allChunks().filter(chunk =>
      chunkOf(claim.x, claim.y).cx <= chunk.cx &&
      chunkOf(claim.x + claim.w - 1, claim.y + claim.h - 1).cx >= chunk.cx &&
      chunkOf(claim.x, claim.y).cy <= chunk.cy &&
      chunkOf(claim.x + claim.w - 1, claim.y + claim.h - 1).cy >= chunk.cy,
    );

    await db.batch([
      db
        .prepare("UPDATE claims SET hidden_at = ?2, hidden_reason = ?3 WHERE id = ?1")
        .bind(claim.id, now(), body.reason ?? "moderation"),
      ...touched.map(chunk =>
        db
          .prepare(
            `INSERT INTO chunks (cx, cy, version) VALUES (?1, ?2, 1)
             ON CONFLICT (cx, cy) DO UPDATE SET version = chunks.version + 1`,
          )
          .bind(chunk.cx, chunk.cy),
      ),
    ]);
    return json({ ok: true });
  }

  // Not ours. `/wall` itself is a page, and it falls through to the assets.
  return null;
}

/**
 * The artwork route, outside the wall prefix because it is not the wall.
 *
 * Content-addressed keys, so `immutable` is not a promise about our behaviour
 * but a fact about the URL: the bytes under a key are the key.
 */
export async function artworkRoute(request: Request, env: WallidEnv): Promise<Response | null> {
  const match = /^\/img\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (!looksLikeKey(match[1]!)) return new Response("no", { status: 404 });

  const object = await env.ART.get(match[1]!);
  if (!object) return new Response("no", { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      // The bucket holds bytes strangers uploaded. Nothing should ever be able
      // to talk a browser into treating one as a document.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The quote a claim was created against, read back off its row.
 *
 * Reconstructed rather than stored whole: the rectangle gives the coordinates
 * row-major, so the column only has to carry the prices. Returns `null` on
 * anything malformed, which the caller turns into a 500 — a claim whose prices
 * cannot be read is one no amount of retrying will settle, and it needs a human
 * rather than another webhook delivery.
 */
function paidQuote(prices: string, rect: Rect): Quote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prices);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== rect.w * rect.h) return null;
  if (!parsed.every(n => Number.isInteger(n) && n > 0)) return null;

  const cells = cellsIn(rect).map((cell, i) => ({
    ...cell,
    priceCents: parsed[i] as number,
    heldCents: null,
  }));
  const totalCents = cells.reduce((sum, c) => sum + c.priceCents, 0);
  return {
    rect,
    cells,
    totalCents,
    perCellCents: Math.round(totalCents / (rect.w * rect.h)),
    takeovers: 0,
  };
}

/** The rectangle a quote request is asking about. */
function rectFromQuery(url: URL): Rect | null {
  const read = (name: string) => Number(url.searchParams.get(name));
  const rect = { x: read("x"), y: read("y"), w: read("w") || 1, h: read("h") || 1 };
  return isValidRect(rect) ? rect : null;
}

/** What the wall currently holds under a rectangle, as the lookup pricing
 * wants. One query over the box, never a chunk read: pricing sixteen cells
 * should not drag back four chunk-fulls of rows. */
async function heldOver(db: D1Database, rect: Rect): Promise<Held> {
  const rows = await cellsInBox(db, rect.x, rect.y, rect.x + rect.w - 1, rect.y + rect.h - 1);
  const held = new Map(rows.map(row => [cellKey(row.x, row.y), row.price_cents]));
  return (x, y) => {
    const priceCents = held.get(cellKey(x, y));
    return priceCents === undefined ? null : { priceCents };
  };
}

export { chunkKey };
