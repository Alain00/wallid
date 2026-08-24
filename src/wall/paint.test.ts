import { describe, expect, test } from "bun:test";
import { claimPath, drawAddress, plateRoom } from "./paint";
import { CELL, cellToScreen, type Camera, type Viewport } from "./camera";

/**
 * The silhouette, asserted through the calls it makes.
 *
 * There is no canvas here to look at, and the thing that went wrong was not
 * something a type would have caught: every cell of a claim was inset and
 * rounded on all four sides, so the wall's ground showed through the middle of
 * somebody's logo in a lattice. These are the two rules that stop that, written
 * down where a future edit has to keep them.
 */

const view: Viewport = { width: 800, height: 600 };
const camera: Camera = { x: 0, y: 0, zoom: 1 };
const size = CELL * camera.zoom;

type Call = { x: number; y: number; w: number; h: number; radii: number[] };

/** Just enough of a 2D context to record what the path would have been. */
function record(cells: { x: number; y: number }[]): Call[] {
  const calls: Call[] = [];
  const ctx = {
    beginPath: () => {},
    roundRect: (x: number, y: number, w: number, h: number, radii: number[]) =>
      calls.push({ x, y, w, h, radii }),
  } as unknown as CanvasRenderingContext2D;
  claimPath(ctx, camera, view, size, cells);
  return calls;
}

const block = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

describe("claimPath", () => {
  test("a single cell is rounded on every corner", () => {
    const [only] = record([{ x: 0, y: 0 }]);
    expect(only!.radii.every(r => r > 0)).toBe(true);
  });

  test("cells of one claim overlap rather than leaving a gutter", () => {
    // The bug: neighbouring cells each pulled back half a pixel, so a seam of
    // bare wall ran through the artwork. Siblings must cross, not meet.
    const [topLeft, topRight] = record(block);
    const leftEdgeEnds = topLeft!.x + topLeft!.w;
    expect(leftEdgeEnds).toBeGreaterThan(topRight!.x);
  });

  test("only the silhouette's own corners are rounded", () => {
    const calls = record(block);
    // The top-left cell of a 2x2 rounds its top-left and nothing else: its
    // other three corners are interior to the claim.
    const [tl] = calls;
    expect(tl!.radii[0]).toBeGreaterThan(0);
    expect(tl!.radii.slice(1)).toEqual([0, 0, 0]);
    // Across the whole block, exactly four rounded corners — one per corner of
    // the square, not four per cell.
    expect(calls.flatMap(c => c.radii).filter(r => r > 0)).toHaveLength(4);
  });

  test("a hole in a claim pulls back from it, and leaves its corners square", () => {
    // A 3x3 with the middle bought out from under it. The ring pulls back from
    // the hole — that edge is exposed and gets the seam — but the corners
    // around it stay square: `roundRect` cannot cut an arc *into* a shape, and
    // the hole is covered by the buyer's own tile anyway.
    const ring = [0, 1, 2]
      .flatMap(y => [0, 1, 2].map(x => ({ x, y })))
      .filter(cell => !(cell.x === 1 && cell.y === 1));
    const calls = record(ring);

    // Still exactly the four corners of the outer square.
    expect(calls.flatMap(c => c.radii).filter(r => r > 0)).toHaveLength(4);

    // The cell above the hole ends short of the hole rather than crossing into
    // it, which is what leaves the gap the missing cell shows through.
    const above = calls[1]!;
    expect(above.y + above.h).toBeLessThan(above.y + size);
  });

  test("pulls back from a stranger's cell and crosses into its own", () => {
    // The gap that means "two different buyers" survives; the one that meant
    // nothing is gone.
    const [only] = record([{ x: 0, y: 0 }]);
    expect(only!.w).toBeLessThan(size);

    const [tl] = record(block);
    // Inset on the left where the wall is, extended on the right where the
    // sibling is — so the tile crosses its own cell boundary.
    const boundary = cellToScreen(camera, view, 0, 0).x + size;
    expect(tl!.x + tl!.w).toBeGreaterThan(boundary);
    expect(tl!.x).toBeGreaterThan(cellToScreen(camera, view, 0, 0).x);
  });
});

/**
 * The address plate. A fake context with a proportional `measureText` is enough
 * to test everything that can go wrong here, all of which is arithmetic: what
 * fits, what is trimmed, and what is too small to draw at all.
 */
function drawn(url: string, width = 300, height = 120) {
  const text: string[] = [];
  let font = "";
  const ctx = {
    set font(value: string) {
      font = value;
    },
    get font() {
      return font;
    },
    textAlign: "",
    textBaseline: "",
    fillStyle: "",
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
    // 7 pixels a character at 13px, which is about right for Geist and, more
    // to the point, monotonic in length — which is all the trimming loop needs.
    measureText: (value: string) => ({ width: value.length * 7 }),
    fillText: (value: string) => text.push(value),
  } as unknown as CanvasRenderingContext2D;

  drawAddress(ctx, { x: 0, y: 0 }, width, height, url);
  return text;
}

describe("drawAddress", () => {
  test("writes the host, without the www nobody reads", () => {
    expect(drawn("https://www.acme.com/pricing#plans")).toEqual(["acme.com"]);
  });

  test("says nothing on a tile too small to read it", () => {
    // Below this the plate is wider than the artwork it is captioning, which is
    // worse than saying nothing — the hover plate covers that case at any zoom.
    expect(drawn("https://acme.com/", 96, 120)).toEqual([]);
    expect(drawn("https://acme.com/", 300, 40)).toEqual([]);
  });

  test("trims a long host to what fits, with an ellipsis", () => {
    const [written] = drawn("https://an-extremely-long-hostname.example.com/", 140);
    expect(written).toEndWith("…");
    expect(written!.length).toBeLessThan("an-extremely-long-hostname.example.com".length);
  });

  test("draws nothing for a url that will not parse", () => {
    // Claims predate `normaliseUrl` being this strict, and a row that cannot be
    // parsed must not take the whole frame down with it.
    expect(drawn("not a url")).toEqual([]);
  });
});

/**
 * Where the address plate goes on a claim that has been eaten into.
 *
 * The bug this pins down was visible on the demo board and looked like a
 * z-order problem: one tile's domain label appeared sliced off by the tile next
 * to it. Nothing was overpainting anything. The plate was drawn at the claim's
 * original top-left corner while the canvas was clipped to the cells the claim
 * still held — and those cells no longer included that corner, so the mask ate
 * the half of the plate that was hanging outside the shape.
 */
describe("plateRoom", () => {
  const at = (...pairs: [number, number][]) => pairs.map(([x, y]) => ({ x, y }));

  test("a whole rectangle captions itself at its own corner", () => {
    expect(plateRoom(at([3, 2], [4, 2], [3, 3], [4, 3]))).toEqual({ x: 3, y: 2, w: 2, h: 2 });
  });

  /* The demo board's case: somebody bought the corner cell out of a 2x2. */
  test("a claim missing its corner moves to the corner it has left", () => {
    const room = plateRoom(at([4, 2], [3, 3], [4, 3]));
    expect(room).toEqual({ x: 4, y: 2, w: 1, h: 2 });
  });

  test("stops at a gap in the top row rather than spanning it", () => {
    // x=5 belongs to somebody else now, so the run is one cell wide.
    const room = plateRoom(at([4, 1], [6, 1], [4, 2], [5, 2], [6, 2]));
    expect(room).toEqual({ x: 4, y: 1, w: 1, h: 2 });
  });

  test("measures the depth of the anchored column, not of the widest one", () => {
    // Two cells across the top, but the left column is one deep — the plate's
    // height has to follow the column it is drawn in.
    const room = plateRoom(at([0, 0], [1, 0], [1, 1]));
    expect(room).toEqual({ x: 0, y: 0, w: 2, h: 1 });
  });

  test("an empty claim asks for no room at all", () => {
    expect(plateRoom([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  /* The room is what `drawAddress` measures against, so a claim reduced to a
   * single cell says nothing rather than covering its own logo with a plate
   * wider than the tile. */
  test("a one-cell remnant leaves no room for a plate", () => {
    const room = plateRoom(at([9, 9]));
    const drawn = drawAddress(
      { measureText: () => ({ width: 40 }) } as unknown as CanvasRenderingContext2D,
      { x: 0, y: 0 },
      room.w * size,
      room.h * size,
      "https://example.com/",
    );
    expect(drawn).toBe(false);
  });
});
