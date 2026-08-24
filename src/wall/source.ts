import { decodeChunk, type ChunkBody } from "./chunk";
import { allChunks, chunkKey, type Chunk, type Rect } from "./geometry";
import type { Quote } from "./pricing";
import { rasterise, tileEdge } from "./raster";

/**
 * Where the wall comes from.
 *
 * The client's half of the caching arrangement, and it is mostly an exercise in
 * not asking. A chunk body's URL contains its version and the body is
 * `immutable` for a year, so the browser cache answers a second request for one
 * without a network round trip. All this has to be careful about is *which
 * version to ask for*, and that comes from an index it re-reads every thirty
 * seconds at most.
 *
 * The wall is sixteen chunks, so there is no region grid and no viewport-shaped
 * query: the client fetches the whole board and keeps it. That is the bound in
 * `geometry.ts` paying for itself twice — once as scarcity, which is the
 * product, and once as an index that is a single shared URL.
 *
 * One consequence worth stating, because it looks like a bug from the outside:
 * a stranger's claim takes up to half a minute to appear. Your own appears
 * instantly, because the canvas draws it optimistically rather than because
 * this fetched it back.
 */

export type Wall = {
  chunks: Map<string, ChunkBody>;
  /** Cells claimed across the whole wall, and cents taken. Neither is derivable
   * from the chunks a client happens to hold. */
  claimed: number;
  cents: number;
};

export type Source = {
  /**
   * Bring the wall up to date, and say whether anything changed.
   *
   * `false` means the caller has nothing to redraw, which is the common case:
   * the index is fresh, every chunk is held at its current version, and this
   * resolves without touching the network.
   */
  load(force?: boolean): Promise<boolean>;
  wall(): Wall;
  /**
   * Cells claimed locally, before — and regardless of — the server hearing
   * about it.
   *
   * The canvas draws from these bodies, so this is what makes a purchase appear
   * where the buyer put it rather than thirty seconds later. Until the index
   * catches up, the chunks it landed in are held back from being refetched: a
   * body fetched at the old version would be the wall *without* the claim
   * somebody just paid for, arriving a moment after they paid and taking it
   * away again.
   */
  claim(body: { rect: Rect; claim: ChunkBody["claims"][number]; prices: number[] }): void;
};

/** How long the index is trusted. Matches the `max-age` the Worker sets, so
 * this is a courtesy to the edge rather than a second cache policy that could
 * disagree with it. */
const INDEX_MS = 30_000;

type Index = { at: number; versions: Record<string, number>; claimed: number; cents: number };

/**
 * `now` is injectable for one reason: the thirty-second TTL is a behaviour
 * worth testing — a redraw inside it must cost nothing, and an optimistic claim
 * must survive it — and a test that waits half a minute to assert that is a
 * test nobody runs.
 */
export function createSource(base = "", now: () => number = Date.now): Source {
  const chunks = new Map<string, ChunkBody>();
  /** Chunks holding an optimistic claim, and the index version at which that
   * claim was made. Refetching one before the index moves past that version
   * would undo a purchase in front of the person who made it. */
  const pending = new Map<string, number>();
  let index: Index | null = null;
  let claimed = 0;
  let cents = 0;

  async function readIndex(force = false): Promise<Index | null> {
    if (!force && index && now() - index.at < INDEX_MS) return index;
    try {
      /*
       * Three caches sit between a settled claim and the wall, and a forced
       * read has to get past all of them.
       *
       * The first is this TTL. The second is the browser's own HTTP cache,
       * which honours the `max-age=30` the index is served with — invisible
       * from here, uninvalidatable, and the one that shows a buyer returning
       * from Stripe a wall without their purchase on it. The third is the edge,
       * which is the one worth keeping: it is what stops a page view costing a
       * D1 read.
       *
       * A cache-busting parameter misses all three, which is why it is spent
       * only on the moment somebody has just paid rather than on every poll.
       */
      const url = force ? `${base}/wall/i?t=${Date.now()}` : `${base}/wall/i`;
      const response = await fetch(url);
      if (!response.ok) return index;
      const body = (await response.json()) as {
        chunks?: Record<string, number>;
        claimed?: number;
        cents?: number;
      };
      index = {
        at: now(),
        versions: body.chunks ?? {},
        claimed: body.claimed ?? 0,
        cents: body.cents ?? 0,
      };
      claimed = index.claimed;
      cents = index.cents;
      return index;
    } catch {
      // Offline, or a blip. The wall already drawn stays drawn; the alternative
      // is blanking a board somebody is looking at because one poll failed.
      return index;
    }
  }

  return {
    async load(force = false) {
      const current = await readIndex(force);
      if (!current) return false;

      let changed = false;
      await Promise.all(
        allChunks().map(async chunk => {
          const key = chunkKey(chunk);
          const version = current.versions[key] ?? 0;
          // An unwritten chunk has no row and no version. Nothing to fetch, and
          // asking would be a D1 read to be told a body is empty.
          if (version === 0) return;

          const held = chunks.get(key);
          if (held?.version === version) return;

          const optimistic = pending.get(key);
          if (optimistic !== undefined && version <= optimistic) return;
          pending.delete(key);

          try {
            const response = await fetch(`${base}/wall/c/${key}/${version}`);
            if (!response.ok) return;
            const body = decodeChunk(await response.text());
            // A body that will not decode is discarded rather than half-drawn.
            // These are cached for a year under an immutable URL, in a browser
            // cache this code cannot reach, so a format that changes has to
            // survive meeting last year's payload.
            if (!body) return;
            chunks.set(key, { ...body, version });
            changed = true;
          } catch {
            // Same reasoning as the index: keep what is drawn.
          }
        }),
      );
      return changed;
    },

    wall: () => ({ chunks, claimed, cents }),

    claim({ rect, claim, prices }) {
      const version = index?.versions ?? {};
      for (let dy = 0; dy < rect.h; dy++) {
        for (let dx = 0; dx < rect.w; dx++) {
          const x = rect.x + dx;
          const y = rect.y + dy;
          const chunk = { cx: Math.floor(x / 32), cy: Math.floor(y / 32) };
          const key = chunkKey(chunk);
          const body = chunks.get(key) ?? { key, version: version[key] ?? 0, cells: [], claims: [] };

          const index = (y - chunk.cy * 32) * 32 + (x - chunk.cx * 32);
          const entry = {
            index,
            claim: claim.id,
            priceCents: prices[dy * rect.w + dx] ?? 0,
          };
          body.cells = [...body.cells.filter(cell => cell.index !== index), entry];
          if (!body.claims.some(existing => existing.id === claim.id)) body.claims.push(claim);

          chunks.set(key, body);
          pending.set(key, body.version);
        }
      }
      claimed += rect.w * rect.h;
    },
  };
}

/** A price for a rectangle, from the server that will charge it. The client can
 * compute the same number from the chunks it holds and does, for the figure
 * that follows the cursor; this is the one the checkout is built on. */
export async function priceOf(rect: Rect, base = ""): Promise<Quote | null> {
  const query = new URLSearchParams({
    x: String(rect.x),
    y: String(rect.y),
    w: String(rect.w),
    h: String(rect.h),
  });
  try {
    const response = await fetch(`${base}/wall/quote?${query}`);
    return response.ok ? ((await response.json()) as Quote) : null;
  } catch {
    return null;
  }
}

export type Checkout =
  | { ok: true; url: string; claimId: string; totalCents: number }
  | { ok: false; error: string };

/**
 * Buy a rectangle.
 *
 * Returns Stripe's hosted URL rather than navigating, so the caller decides
 * when the page goes away — there is a panel to close and an optimistic draw to
 * schedule first, and a redirect fired from inside a fetch handler takes both
 * of those with it.
 */
export async function checkout(
  body: {
    rect: Rect;
    label: string;
    url: string;
    image: string | null;
    imageSource?: string;
    email?: string | null;
    turnstile: string;
    /** Issued by the artwork step. See `allowed` in `worker/wall/index.ts`. */
    pass?: string;
  },
  base = "",
): Promise<Checkout> {
  try {
    const response = await fetch(`${base}/wall/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body.rect, ...body, rect: undefined }),
    });
    /*
     * A body that is not JSON is not a network failure.
     *
     * When the Worker throws, Cloudflare answers with an HTML error page, and
     * `response.json()` throws on it — which used to land in the catch below
     * and tell the buyer the wall was unreachable while it was answering
     * perfectly well. Read the status instead, and say which end went wrong.
     */
    const result = (await response.json().catch(() => null)) as Record<string, string> | null;
    if (!response.ok || !result) {
      return {
        ok: false,
        error: result?.error ?? (response.status >= 500 ? "the wall is having trouble — nothing was charged" : "that did not work"),
      };
    }
    return {
      ok: true,
      url: result.url!,
      claimId: result.claimId!,
      totalCents: Number(result.totalCents),
    };
  } catch {
    return { ok: false, error: "could not reach the wall" };
  }
}

/**
 * The artwork step, run before checkout so the buyer sees their logo in the
 * cell before they are asked for a card.
 *
 * One way in: the URL they typed, from which the Worker fetches whatever icon
 * or preview image their own site declares. There is no upload — see the panel.
 *
 * `want` picks which picture of themselves the buyer gets: the mark their site
 * declares as its icon, or the preview image it declares for social cards.
 * Neither is better in general — a preview fills a wide rectangle where an icon
 * would float in the middle of it, and an icon is the only thing that reads in
 * a single cell.
 *
 * Two calls in one case, and it is invisible from outside: artwork the wall
 * will not store as it stands — an SVG, or a preview image too large for the
 * bucket — comes back as bytes rather than a key, and this redraws it at tile
 * size (see `raster.ts`) and posts the PNG straight back through the same
 * route. The caller gets a key either way and never learns the difference.
 *
 * The `pass` in the answer is what makes the second call legal without a second
 * challenge — a Turnstile token is redeemed once, and the first call spent it.
 */
export type Artwork = { key: string; source: string; pass?: string };

export async function resolveArtwork(
  input: {
    url?: string;
    want?: "favicon" | "og";
    /** The claim's footprint, which is what decides how many pixels the artwork
     * is worth storing. A 1x1 wants a favicon's worth; a 6x3 wants far more. */
    rect: Rect;
    turnstile: string;
    pass?: string;
  },
  base = "",
): Promise<Artwork | { error: string }> {
  /*
   * `file` is still a way in here, and it is not the buyer's.
   *
   * Nobody can hand this function an image any more — the panel's upload
   * control is gone and the parameter with it. What remains is the redraw round
   * trip below: artwork the wall will not store as it stands comes back as
   * bytes, and the only thing on this side that can turn an SVG into a PNG is
   * the browser's own canvas, which then has to post the result somewhere. That
   * somewhere is the same route.
   */
  const send = async (body: { file?: File | null; url?: string; pass?: string }) => {
    const form = new FormData();
    form.set("turnstile", input.turnstile);
    if (body.pass) form.set("pass", body.pass);
    if (body.file) form.set("file", body.file);
    else {
      form.set("url", body.url ?? "");
      if (input.want) form.set("want", input.want);
    }
    const response = await fetch(`${base}/wall/artwork`, { method: "POST", body: form });
    return { ok: response.ok, result: (await response.json()) as Record<string, string> };
  };

  try {
    const first = await send({ url: input.url, pass: input.pass });
    if (!first.ok) return { error: first.result.error ?? "could not read that image" };

    if (first.result.redraw) {
      const png = await rasterise(
        fromBase64(first.result.redraw),
        first.result.type,
        tileEdge(input.rect),
      );
      if (!png) return { error: "this browser could not redraw that image" };

      // The pass, not the token: Cloudflare has already spent the token on the
      // call that fetched the original.
      const second = await send({ file: png, pass: first.result.pass });
      if (!second.ok) return { error: second.result.error ?? "could not read that image" };
      return {
        key: second.result.key!,
        // The buyer asked for their site's icon and got it. That it took a
        // detour through a canvas is not a distinction the panel should draw.
        source: first.result.source!,
        pass: second.result.pass,
      };
    }

    return { key: first.result.key!, source: first.result.source!, pass: first.result.pass };
  } catch {
    return { error: "could not reach the wall" };
  }
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

/** What this browser owns. The durable identity is a cookie; there is no login. */
export async function mine(base = ""): Promise<unknown[]> {
  try {
    const response = await fetch(`${base}/wall/mine`);
    if (!response.ok) return [];
    return ((await response.json()) as { claims?: unknown[] }).claims ?? [];
  } catch {
    return [];
  }
}
