import { CAPACITY, cellAt, cellKey, chunkKey, type Cell, type Chunk } from "./geometry";

/**
 * What a chunk looks like on the wire, and how a client turns a pile of them
 * into the ownership the rules in `pricing.ts` ask for.
 *
 * The format is the contract between three things that are otherwise unaware of
 * each other: the D1 rows, the Worker that serialises them, and the canvas that
 * draws them. It is deliberately small — this is the payload a visitor
 * downloads before the wall appears.
 */

/** A cell joined to its claim, as the columns come back from D1. */
export type CellRow = {
  x: number;
  y: number;
  price_cents: number;
  claim_id: string;
  label: string;
  url: string;
  image_key: string | null;
  /** The claim's rectangle, so the renderer knows which tile of an image this
   * cell is. See `Held.slot` below. */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
};

/**
 * One claimed cell, as served.
 *
 * `index` rather than a coordinate pair: the chunk already knows where it is,
 * so repeating it a thousand times over is a thousand redundant integers.
 *
 * `claim` is an id shared by every cell of the same purchase, and it is what
 * makes one image span a rectangle instead of repeating in each of its cells.
 * The claim's own details are carried once, in `claims` below, rather than
 * copied onto all 256 cells of a 16x16.
 */
export type CellEntry = {
  index: number;
  claim: string;
  priceCents: number;
};

/** A claim, carried once per chunk body however many cells reference it. */
export type ClaimEntry = {
  id: string;
  label: string;
  url: string;
  image: string | null;
  /** The rectangle as bought, in absolute cells. A cell's tile within the
   * artwork is its offset from this corner, which is what lets a claim keep
   * drawing correctly after cells have been taken out of the middle of it. */
  rect: { x: number; y: number; w: number; h: number };
};

/** A chunk as served. `version` is the write counter that makes the URL
 * immutable and the body cacheable forever; see ADR 0001. */
export type ChunkBody = {
  key: string;
  version: number;
  cells: CellEntry[];
  claims: ClaimEntry[];
};

/**
 * The wire form: tuples, not objects.
 *
 * A full chunk is a thousand cells, and `{"index":512,"claim":...}` spends more
 * bytes naming its fields than carrying them. Claims stay objects — there are
 * few of them and they carry strings that dwarf their keys.
 *
 * Claims are indexed rather than named per cell: a 16x16 claim would otherwise
 * repeat a 26-character id 256 times.
 */
type WireCell = [index: number, claim: number, priceCents: number];

export function encodeChunk(body: ChunkBody): string {
  const order = new Map(body.claims.map((claim, i) => [claim.id, i]));
  return JSON.stringify({
    k: body.key,
    v: body.version,
    m: body.claims.map(claim => ({
      i: claim.id,
      l: claim.label,
      u: claim.url,
      g: claim.image,
      r: [claim.rect.x, claim.rect.y, claim.rect.w, claim.rect.h],
    })),
    c: body.cells.map((cell): WireCell => [cell.index, order.get(cell.claim) ?? 0, cell.priceCents]),
  });
}

/**
 * Parses a chunk body, or returns `null`.
 *
 * Defensive about its own format on purpose. These bodies are cached for a year
 * under an immutable URL, in a browser cache this code cannot reach and cannot
 * invalidate — a shape that changes has to survive meeting last year's payload,
 * and the only safe way to fail is to discard it and refetch rather than to
 * draw half a chunk of undefined.
 */
export function decodeChunk(text: string): ChunkBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const { k, v, m, c } = raw as { k?: unknown; v?: unknown; m?: unknown; c?: unknown };
  if (typeof k !== "string" || !Number.isInteger(v)) return null;
  if (!Array.isArray(m) || !Array.isArray(c)) return null;

  const claims: ClaimEntry[] = [];
  for (const entry of m) {
    if (!entry || typeof entry !== "object") return null;
    const { i, l, u, g, r } = entry as Record<string, unknown>;
    if (typeof i !== "string" || typeof l !== "string" || typeof u !== "string") return null;
    if (g !== null && typeof g !== "string") return null;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(n => Number.isInteger(n))) return null;
    const [x, y, w, h] = r as number[];
    claims.push({ id: i, label: l, url: u, image: g, rect: { x: x!, y: y!, w: w!, h: h! } });
  }

  const cells: CellEntry[] = [];
  for (const entry of c) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [index, claim, priceCents] = entry as WireCell;
    if (!Number.isInteger(index) || index < 0 || index >= CAPACITY) return null;
    if (!Number.isInteger(claim) || claim < 0 || claim >= claims.length) return null;
    if (!Number.isInteger(priceCents) || priceCents < 0) return null;
    cells.push({ index, claim: claims[claim]!.id, priceCents });
  }

  return { key: k, version: v as number, cells, claims };
}

/** Rows from D1, as a body to serve. Claims are deduplicated here rather than
 * by the query, because the join has to repeat them and the wire must not. */
export function bodyFromRows(chunk: Chunk, version: number, rows: CellRow[]): ChunkBody {
  const claims = new Map<string, ClaimEntry>();
  const cells: CellEntry[] = [];

  for (const row of rows) {
    if (!claims.has(row.claim_id)) {
      claims.set(row.claim_id, {
        id: row.claim_id,
        label: row.label,
        url: row.url,
        image: row.image_key,
        rect: { x: row.rx, y: row.ry, w: row.rw, h: row.rh },
      });
    }
    cells.push({
      index: (row.y - chunk.cy * 32) * 32 + (row.x - chunk.cx * 32),
      claim: row.claim_id,
      priceCents: row.price_cents,
    });
  }

  return { key: chunkKey(chunk), version, cells, claims: [...claims.values()] };
}

/** A cell's absolute position, which is the chunk's own plus the stored slot. */
export function cellOf(chunk: Chunk, entry: CellEntry): Cell {
  return cellAt(chunk, entry.index);
}

/**
 * The loaded wall, as the lookup `pricing.ts` asks for.
 *
 * Note what this deliberately cannot tell you: a cell in a chunk that has not
 * been fetched answers "unclaimed", the same as a cell that genuinely is. The
 * caller — not this map — is responsible for knowing which chunks it holds,
 * which is why the client fetches all sixteen before it quotes anything.
 */
export function heldBy(chunks: Map<string, ChunkBody>) {
  const held = new Map<string, number>();
  for (const [key, body] of chunks) {
    const [cx, cy] = key.split("_").map(Number) as [number, number];
    for (const entry of body.cells) {
      const cell = cellAt({ cx, cy }, entry.index);
      held.set(cellKey(cell.x, cell.y), entry.priceCents);
    }
  }
  return (x: number, y: number) => {
    const priceCents = held.get(cellKey(x, y));
    return priceCents === undefined ? null : { priceCents };
  };
}

/** Everything drawable across the loaded chunks, with absolute cells — the
 * draw list, in whatever order the chunks arrived. */
export function* claimedCells(
  chunks: Map<string, ChunkBody>,
): Generator<Cell & { entry: CellEntry; claim: ClaimEntry }> {
  for (const [key, body] of chunks) {
    const [cx, cy] = key.split("_").map(Number) as [number, number];
    const byId = new Map(body.claims.map(claim => [claim.id, claim]));
    for (const entry of body.cells) {
      const claim = byId.get(entry.claim);
      if (!claim) continue;
      const cell = cellAt({ cx, cy }, entry.index);
      yield { x: cell.x, y: cell.y, entry, claim };
    }
  }
}

/** What sits in a cell, or `null`. Linear over the chunk's own cells: a chunk
 * holds at most a thousand, this runs once per pointer move, and an index
 * would be a second structure to keep in step for no measurable gain. */
export function cellInfo(
  chunks: Map<string, ChunkBody>,
  chunk: Chunk,
  index: number,
): { entry: CellEntry; claim: ClaimEntry } | null {
  const body = chunks.get(chunkKey(chunk));
  const entry = body?.cells.find(c => c.index === index);
  if (!entry || !body) return null;
  const claim = body.claims.find(m => m.id === entry.claim);
  return claim ? { entry, claim } : null;
}

/** Convenience for building the map the functions above read. */
export const chunkMap = (bodies: ChunkBody[]) => new Map(bodies.map(body => [body.key, body]));

export { chunkKey };
