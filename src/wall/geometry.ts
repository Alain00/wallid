/**
 * The wall's coordinate system.
 *
 * Shared by the client that draws the wall and the Worker that validates claims
 * against it, because the two must never disagree about which cells exist or
 * which of them a claim covers. A client that offers a cell the server refuses
 * is a broken affordance; a server that accepts a cell the client cannot draw
 * is a claim nobody ever sees. One module, imported by both.
 *
 * Everything here is integer arithmetic over pure functions. No storage, no
 * rendering, no D1 — ownership arrives as a lookup, so the same code answers
 * for a `Map` held in the browser and for rows read out of a chunk query.
 */

/**
 * Cells per chunk side.
 *
 * A request-count decision, not a storage one. At the current ~80px cell a
 * 32-wide chunk covers ~2560px, so a viewport spans one to two chunks across
 * and one down: two to four requests to paint. 16 doubles that for no payload
 * saving, because a chunk carries only its *claimed* cells.
 */
export const CHUNK = 32;

/** Cells in a chunk. A chunk holding this many is full, but never final. */
export const CAPACITY = CHUNK * CHUNK;

/**
 * The wall is 128 cells on a side, and it will never be any other number.
 *
 * This is the single most important constant in the project and the one that
 * most invites being changed later, so: scarcity *is* the product. A cell here
 * is worth something because there are 16,384 of them and there will not be a
 * 16,385th. Grow the wall and every cell already paid for loses the thing its
 * owner bought, because cheap new ground appears beside expensive old ground
 * and the price of the old ground was a statement about how much wall exists.
 *
 * That is the opposite call from an open-ended participatory wall, where the
 * plane is unbounded because occupancy is the medium and empty regions are the
 * canvas. Here the medium is *ownership under contest*, and contest needs a
 * fixed board.
 *
 * 128 is 4x4 chunks, so the whole wall is sixteen chunk bodies — small enough
 * that a client can hold all of it, which is what makes the zoomed-out overview
 * a plain render rather than a second tile format.
 */
export const SIDE = 128;

/** Cells on the wall, ever. */
export const CELLS = SIDE * SIDE;

/** Chunks on the wall, ever. 4x4 at the current side and chunk size. */
export const CHUNKS = SIDE / CHUNK;

/**
 * The largest rectangle anyone may buy in one go, per side.
 *
 * Not a cap on how much wall one buyer can own — they may buy adjacent claims
 * all day, and a wall where somebody has assembled a quarter of it by paying
 * for it is the mechanic working. It is a cap on the *transaction*, because a
 * single checkout for 16,384 cells is a single refund request for 16,384 cells,
 * and because a claim is drawn as one image: past about this size the artwork
 * is a billboard rather than a tile.
 */
export const MAX_SIDE = 16;

export type Cell = { x: number; y: number };
export type Chunk = { cx: number; cy: number };

/** A claim's footprint. `w` and `h` are counts, so 1x1 is `{x, y, w: 1, h: 1}`. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Who holds a cell and for how much, as a question rather than a container.
 *
 * The client answers it from chunks it has fetched, the Worker from rows it has
 * just read; neither has to adopt the other's data structure to reuse the rules
 * in `pricing.ts`. `null` is an unclaimed cell, which is not the same as a cell
 * held at zero — nobody holds anything at zero here, and the distinction is
 * what keeps "free" from being expressible by accident.
 */
export type Held = (x: number, y: number) => { priceCents: number } | null;

/**
 * A cell, with negative zero collapsed.
 *
 * The wall has no negative coordinates, but `-0` still reaches a cell through
 * `Math.round` of a pointer just left of the origin, and it compares equal to
 * `0`, prints as `"0"`, and is a *different value* to `Object.is`, to `Map`
 * keys and to React's key diffing. Every cell coming out of arithmetic goes
 * through here.
 */
export const cell = (x: number, y: number): Cell => ({ x: x || 0, y: y || 0 });

/** Is this cell on the wall at all? The bound is closed at zero, open at `SIDE`. */
export const inBounds = (x: number, y: number): boolean =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIDE && y < SIDE;

/**
 * `Math.floor`, not truncation.
 *
 * The wall is bounded to non-negative coordinates today, so the two agree — but
 * they agree by accident of the bound rather than by arithmetic, and a viewport
 * that pans past the edge produces negative cell coordinates on its way to
 * being clamped. Flooring keeps every intermediate value correct rather than
 * relying on nothing ever looking left of the origin.
 */
export function chunkOf(x: number, y: number): Chunk {
  return { cx: Math.floor(x / CHUNK), cy: Math.floor(y / CHUNK) };
}

/** The cell's slot inside its own chunk, `0`-`1023`. Row-major, floor-modulo. */
export function cellIndex(x: number, y: number): number {
  const lx = x - Math.floor(x / CHUNK) * CHUNK;
  const ly = y - Math.floor(y / CHUNK) * CHUNK;
  return ly * CHUNK + lx;
}

/** The inverse: a chunk plus a stored slot is a cell again. */
export function cellAt(chunk: Chunk, index: number): Cell {
  return {
    x: chunk.cx * CHUNK + (index % CHUNK),
    y: chunk.cy * CHUNK + Math.floor(index / CHUNK),
  };
}

/**
 * Chunk identity as a string, because it is a URL path segment
 * (`/wall/c/3_2/812`) and a JSON object key in the index before it is anything
 * else. `_` rather than `,` so it needs no escaping in either.
 */
export function chunkKey(chunk: Chunk): string {
  return `${chunk.cx}_${chunk.cy}`;
}

/**
 * Parses a key back, and rejects anything that is not exactly the form above.
 * This runs on a path segment a stranger controls, so `parseInt`'s cheerful
 * acceptance of `"3abc"` and `" 3"` is a liability rather than a convenience.
 * Out-of-range chunks are rejected here too: the wall has sixteen of them, and
 * a request for `900_900` should not reach the database to find that out.
 */
export function parseChunkKey(key: string): Chunk | null {
  const match = /^(\d{1,3})_(\d{1,3})$/.exec(key);
  if (!match) return null;
  const cx = Number(match[1]);
  const cy = Number(match[2]);
  return cx < CHUNKS && cy < CHUNKS ? { cx, cy } : null;
}

/** A cell's identity for the `Map` a caller builds its `Held` from. */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Every chunk touching an inclusive cell-space box, row-major. */
export function chunksCovering(x0: number, y0: number, x1: number, y1: number): Chunk[] {
  const from = chunkOf(Math.max(0, Math.min(x0, x1)), Math.max(0, Math.min(y0, y1)));
  const to = chunkOf(
    Math.min(SIDE - 1, Math.max(x0, x1)),
    Math.min(SIDE - 1, Math.max(y0, y1)),
  );
  const chunks: Chunk[] = [];
  for (let cy = from.cy; cy <= to.cy; cy++) {
    for (let cx = from.cx; cx <= to.cx; cx++) chunks.push({ cx, cy });
  }
  return chunks;
}

/** Every chunk on the wall. Sixteen of them, which a client fetches outright. */
export function allChunks(): Chunk[] {
  return chunksCovering(0, 0, SIDE - 1, SIDE - 1);
}

/** Cells of a rectangle, row-major. */
export function cellsIn(rect: Rect): Cell[] {
  const cells: Cell[] = [];
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) cells.push({ x: rect.x + dx, y: rect.y + dy });
  }
  return cells;
}

/** Cells a rectangle covers, without building the list. */
export const areaOf = (rect: Rect): number => rect.w * rect.h;

/** Is this cell inside the rectangle? */
export const contains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;

/**
 * A rectangle that could exist on this wall: whole cells, positive extent,
 * inside the bounds, and not larger than one transaction is allowed to be.
 *
 * Validated as one predicate rather than as four checks at each call site,
 * because the client and the Worker both have to reach the same verdict and
 * the client's version is what decides whether the drag handle can grow.
 */
export function isValidRect(rect: Rect): boolean {
  if (!Number.isInteger(rect.w) || !Number.isInteger(rect.h)) return false;
  if (rect.w < 1 || rect.h < 1) return false;
  if (rect.w > MAX_SIDE || rect.h > MAX_SIDE) return false;
  if (!inBounds(rect.x, rect.y)) return false;
  return inBounds(rect.x + rect.w - 1, rect.y + rect.h - 1);
}

/**
 * A rectangle dragged from one cell to another, normalised and clamped.
 *
 * Drags go in every direction, so `w` and `h` come out of a difference that is
 * routinely negative; and a drag that runs off the edge of the wall should stop
 * at the edge rather than be refused, because refusing it means the rectangle
 * vanishes mid-gesture.
 */
export function rectFromDrag(from: Cell, to: Cell): Rect {
  const x0 = Math.max(0, Math.min(from.x, to.x));
  const y0 = Math.max(0, Math.min(from.y, to.y));
  const w = Math.min(Math.abs(to.x - from.x) + 1, MAX_SIDE, SIDE - x0);
  const h = Math.min(Math.abs(to.y - from.y) + 1, MAX_SIDE, SIDE - y0);
  return { x: x0, y: y0, w, h };
}
