import { describe, expect, test } from "bun:test";
import { cellKey, type Held, type Rect } from "./geometry";
import { BASE_CENTS, beats, money, nextPrice, quote } from "./pricing";

/** A `Held` over a plain map, which is the shape both real callers reduce to. */
const wall = (cells: Record<string, number>): Held =>
  (x, y) => (cellKey(x, y) in cells ? { priceCents: cells[cellKey(x, y)]! } : null);

const empty: Held = () => null;

describe("nextPrice", () => {
  test("an unheld cell costs the base price", () => {
    expect(nextPrice(null)).toBe(BASE_CENTS);
  });

  test("a held cell costs the step above what its holder paid", () => {
    expect(nextPrice(100)).toBe(120);
    expect(nextPrice(1000)).toBe(1200);
  });

  test("rounds up, so the step is never rounded away", () => {
    // 105 * 1.2 is 126 exactly; 101 * 1.2 is 121.2, which must not become 121
    // by rounding to nearest and then reading as a legal 20% step.
    expect(nextPrice(101)).toBe(122);
  });

  test("always beats the holder by at least a cent", () => {
    // The step is a fraction, and a fraction of a small enough number rounds to
    // nothing. Nothing on this wall may be taken by matching.
    for (let c = 1; c < 200; c++) expect(nextPrice(c)).toBeGreaterThan(c);
  });

  test("climbs", () => {
    let price = BASE_CENTS;
    for (let i = 0; i < 10; i++) price = nextPrice(price);
    // Ten challenges take a dollar cell past six dollars. This is the number
    // the pitch quotes, so it is a test rather than a comment.
    expect(price).toBeGreaterThan(600);
  });
});

describe("quote", () => {
  const rect: Rect = { x: 0, y: 0, w: 2, h: 2 };

  test("an empty rectangle is its area at the base price", () => {
    const q = quote(rect, empty);
    expect(q.totalCents).toBe(4 * BASE_CENTS);
    expect(q.perCellCents).toBe(BASE_CENTS);
    expect(q.takeovers).toBe(0);
  });

  test("prices each cell against its own holder, not the rectangle's average", () => {
    const q = quote(rect, wall({ "0,0": 10_000 }));
    expect(q.cells[0]!.priceCents).toBe(12_000);
    expect(q.cells[1]!.priceCents).toBe(BASE_CENTS);
    expect(q.totalCents).toBe(12_000 + 3 * BASE_CENTS);
    expect(q.takeovers).toBe(1);
  });

  test("cells come back row-major, so the interface can lay them out", () => {
    expect(quote(rect, empty).cells.map(c => `${c.x},${c.y}`)).toEqual([
      "0,0",
      "1,0",
      "0,1",
      "1,1",
    ]);
  });
});

describe("beats", () => {
  const rect: Rect = { x: 0, y: 0, w: 2, h: 1 };

  test("a quote taken against an unchanged wall still wins", () => {
    expect(beats(quote(rect, empty), empty)).toBe(true);
  });

  test("loses when a cell was taken between the quote and the claim", () => {
    // The race this exists for: two people quote the same empty cell, both pay,
    // and the second one's money bought a price that is no longer enough.
    const paid = quote(rect, empty);
    expect(beats(paid, wall({ "1,0": BASE_CENTS }))).toBe(false);
  });

  test("area cannot buy a cell that armour holds", () => {
    // The failure the per-cell rule exists to prevent, stated as a test: a
    // large cheap rectangle overlapping one expensive cell must lose, however
    // much it totals to.
    const sprawl: Rect = { x: 0, y: 0, w: 16, h: 16 };
    const paid = quote(sprawl, empty);
    expect(paid.totalCents).toBeGreaterThan(20_000);
    expect(beats(paid, wall({ "8,8": 20_000 }))).toBe(false);
  });

  test("all or nothing: one lost cell loses the claim", () => {
    const paid = quote({ x: 0, y: 0, w: 4, h: 4 }, empty);
    expect(beats(paid, wall({ "3,3": BASE_CENTS }))).toBe(false);
  });
});

describe("money", () => {
  test("keeps the cent, because the step lives in it", () => {
    expect(money(120)).toBe("$1.20");
    expect(money(BASE_CENTS)).toBe("$1.00");
  });
});
