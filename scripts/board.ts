#!/usr/bin/env bun
/**
 * Save and rebuild a development wall. `bun run board save`, `bun run board load`.
 *
 * A demo board is twenty hand-placed claims, each one a rectangle dragged out,
 * a domain typed, an artwork waited for. That is twenty minutes of work living
 * in a gitignored SQLite file, one `clear the wall` away from gone — and the
 * board is the thing every screenshot of this project is *of*. So it becomes a
 * file: `scripts/board.json`, in the repo, rebuildable in one command.
 *
 * It goes through god mode's routes (`/wall/dev/*` in `server.ts`), which means
 * it goes through the real pricing, the real settle and the real artwork
 * resolution. What comes back is a wall the production code would have
 * produced, minus the twenty card payments.
 *
 * `save` reads the database directly and `load` talks to the dev server over
 * HTTP, which is not an inconsistency: saving is a question only the database
 * can answer (`image_source` is not on the wire), and loading has to go through
 * the routes or it would be a second implementation of settling.
 *
 * The artwork comes from one of two places. A claim naming a real site is
 * fetched from it, which is what a buyer's claim does. A claim naming one of the
 * fictional brands in `brands.ts` is *drawn* — the showcase board is companies
 * that do not exist, so there is no site to ask, and a board of coloured labels
 * would not show what this wall actually looks like. Both end up in the bucket
 * through `/wall/artwork`.
 */

import { drawBrand, isFictional } from "./brands";
import { sqliteD1 } from "../worker/wall/sqlite";

const DB = ".wrangler/state/wallid-dev.sqlite";
const FILE = process.argv[3] ?? "scripts/board.json";
const HOST = process.env.WALL_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

/**
 * A claim, as little of it as is worth keeping.
 *
 * No id, no prices, no artwork key. An id is minted at settle time; prices come
 * from what the wall costs when the board is rebuilt, which is the point of
 * rebuilding it through the real quote; and an artwork key names bytes in a
 * local R2 directory that a fresh clone does not have. What is durable is the
 * rectangle, the domain and which picture of itself that domain gave us.
 */
type Claim = {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  url: string;
  /** `og` is the site's preview image, `favicon` its icon. Preferred in that
   * order — see `artworkFor`. Absent on a drawn brand, which fetches nothing. */
  want?: "og" | "favicon";
  /**
   * A brand in `brands.ts`, drawn rather than fetched.
   *
   * The showcase board is fictional companies now, and a fictional company has
   * no site to ask for a picture of itself — see the note at the top of
   * `brands.ts` for why they are drawn instead of left as coloured labels. The
   * key is the brand's name, which is also the claim's `label`, and the drawing
   * is made to this claim's own `w` by `h` so it fills the tile rather than
   * sitting in the middle of it.
   */
  art?: string;
};

const usage = () => {
  console.error("usage: bun run board save|load [file]");
  process.exit(1);
};

/* ── save ──────────────────────────────────────────────────────────────── */

async function save() {
  const db = sqliteD1(DB);
  const { results } = await db
    .prepare(
      `SELECT x, y, w, h, label, url, image_source FROM claims
       WHERE status = 'active'
       ORDER BY at ASC, rowid ASC`,
    )
    .all<{
      x: number;
      y: number;
      w: number;
      h: number;
      label: string;
      url: string;
      image_source: string | null;
    }>();

  // Order is preserved, and it is load-bearing: a claim that took cells from an
  // earlier one only takes them if it is placed after it. Rebuilt in a
  // different order, the same list makes a different wall.
  const claims: Claim[] = results.map(row => ({
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    label: row.label,
    url: row.url,
    want: row.image_source === "favicon" ? "favicon" : "og",
  }));

  await Bun.write(FILE, `${JSON.stringify(claims, null, 2)}\n`);
  console.log(`  saved ${claims.length} claims → ${FILE}`);
  // `image_source` on a drawn brand is `upload`, which is true and useless: the
  // bucket holds the PNG and nothing holds the fact that `brands.ts` drew it.
  // So a save over the curated board is a save of its geometry only.
  if (claims.some(claim => isFictional(claim.label))) {
    console.log("  note: drawn brands come back as uploads — re-add their `art` keys by hand");
  }
}

/* ── load ──────────────────────────────────────────────────────────────── */

/**
 * The artwork, preferring the preview.
 *
 * A site's `og:image` is a picture it chose to be seen by — a screenshot, a
 * wordmark on a field, a product shot — and it fills a rectangle the way a
 * 32px icon never will. The favicon is the fallback rather than the default:
 * it is the right answer for a single cell and the wrong one for a 3x2, and
 * most of a demo board is not single cells.
 *
 * Three ways this comes back without a key, all of them survivable:
 *
 *   - `redraw`: the wall will not store what it fetched as it stands — an SVG,
 *     or a preview too large for the bucket — and hands back bytes for the
 *     *browser* to rasterise. There is no canvas here, so this retries with the
 *     other kind of picture rather than failing.
 *   - a refusal: the site has no such image, or would not serve it.
 *   - nothing at all: the claim is placed without artwork, which draws as its
 *     label on its own ground. A tile with a name on it is a tile.
 */
async function artworkFor(claim: Claim): Promise<string | null> {
  if (claim.art) return uploadArt(claim.art, claim.w, claim.h);

  const order: ("og" | "favicon")[] =
    claim.want === "favicon" ? ["favicon", "og"] : ["og", "favicon"];

  // A board is mostly multi-cell claims and a preview fills them; the icon is
  // what a 1x1 wants. Recorded per claim rather than decided here, so a board
  // that chose an icon for a tile keeps it — see `save`.

  for (const want of order) {
    const form = new FormData();
    // Development pins Cloudflare's always-passes test pair — see `Turnstile.tsx`
    // and `devVars` in `server.ts` — so any token verifies.
    form.set("turnstile", "board-script");
    form.set("url", claim.url);
    form.set("want", want);

    try {
      const response = await fetch(`${HOST}/wall/artwork`, { method: "POST", body: form });
      const result = (await response.json().catch(() => null)) as Record<string, string> | null;
      if (!response.ok || !result) continue;
      if (result.redraw) continue;
      if (result.key) return result.key;
    } catch {
      // The dev server went away mid-run. The next call will say so properly.
    }
  }
  return null;
}

/**
 * A drawn brand, through the upload half of the same route.
 *
 * Not a shortcut past the wall: this is the multipart `file` a buyer posts when
 * their favicon turns out to be a 16px blur, so the PNG is sniffed, size-checked
 * and content-addressed exactly like theirs. The only thing that differs is
 * where the bytes came from — `brands.ts` instead of somebody's laptop.
 */
async function uploadArt(brand: string, w: number, h: number): Promise<string | null> {
  const form = new FormData();
  form.set("turnstile", "board-script");
  form.set("file", new Blob([await drawBrand(brand, w, h)], { type: "image/png" }), `${brand}.png`);

  try {
    const response = await fetch(`${HOST}/wall/artwork`, { method: "POST", body: form });
    const result = (await response.json().catch(() => null)) as Record<string, string> | null;
    if (!response.ok || !result?.key) {
      console.error(`  ${brand.padEnd(22)} artwork refused: ${result?.error ?? response.status}`);
      return null;
    }
    return result.key;
  } catch {
    // The dev server went away mid-run. The settle below will say so properly.
    return null;
  }
}

async function load() {
  const file = Bun.file(FILE);
  if (!(await file.exists())) {
    console.error(`no such board: ${FILE}`);
    process.exit(1);
  }
  const claims = (await file.json()) as Claim[];

  const cleared = await fetch(`${HOST}/wall/dev/free`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ all: true }),
  }).catch(() => null);

  if (!cleared?.ok) {
    console.error(
      [
        `Could not reach god mode at ${HOST}.`,
        "",
        "The dev server has to be running — `bun run dev` — and on this port.",
        "Set PORT or WALL_URL if it is somewhere else. These routes exist only",
        "in server.ts; there is nothing to load against a deployed wall.",
      ].join("\n"),
    );
    process.exit(1);
  }

  for (const claim of claims) {
    const image = await artworkFor(claim);
    const response = await fetch(`${HOST}/wall/dev/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x: claim.x,
        y: claim.y,
        w: claim.w,
        h: claim.h,
        label: claim.label,
        url: claim.url,
        image,
        imageSource: image ? (claim.art ? "upload" : claim.want) : undefined,
      }),
    });

    const mark = image ? (claim.art ? "  (drawn)" : "") : "  (no artwork)";
    if (response.ok) console.log(`  ${claim.label.padEnd(22)} ${claim.w}x${claim.h}${mark}`);
    else console.error(`  ${claim.label.padEnd(22)} failed: ${(await response.text()).slice(0, 80)}`);
  }

  console.log(`\n  ${claims.length} claims placed. Reload the wall.`);
}

const mode = process.argv[2];
if (mode === "save") await save();
else if (mode === "load") await load();
else usage();
