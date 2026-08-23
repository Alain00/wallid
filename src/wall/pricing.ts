/**
 * What a claim costs, and when it beats the claim already there.
 *
 * The one module both sides must agree about down to the cent. The client
 * quotes a price before anyone pays and greys out a rectangle it knows will be
 * refused; the Worker recomputes the same number from its own rows and refuses
 * anything that does not match. A client that quotes low is a buyer who is
 * charged more than they were shown, which is the single worst failure this
 * project has available to it.
 */
import { areaOf, cellsIn, type Held, type Rect } from "./geometry";

/**
 * The floor, in cents, for a cell nobody has ever held.
 *
 * $1. Low enough that buying a single cell is an impulse rather than a
 * decision, which matters because the first thing most people do here is buy
 * one cell to see what happens, and the second is discover that somebody took
 * it. That sequence is the product.
 */
export const BASE_CENTS = 100;

/**
 * How much more than the current holder a challenger must pay, as a fraction.
 *
 * Strictly greater is not enough on its own: at a cent of increment the
 * cheapest way to hold a cell forever is a script that reclaims it for one cent
 * more, every time, and the wall becomes two bots trading a cell at $0.01
 * steps. A 20% step means taking a cell is a real decision at every price, and
 * it is what makes the ratchet climb at a rate anybody can feel.
 *
 * It also sets the pace of the whole board. Ten successful challenges over one
 * cell take it from $1 to about $6; twenty take it to $38. The wall's total
 * value is the sum of those ladders, which is why a contested cell is worth
 * more to this business than an untouched one.
 */
export const STEP = 0.2;

/**
 * The next price a cell can be taken at, in cents.
 *
 * `null` in, meaning nobody holds it, gives the base price. Held gives the
 * holder's price stepped up and rounded to the cent *away from zero*, so the
 * increment can never round back down to no increment at all — at the base
 * price a fractional cent would otherwise let a challenger match rather than
 * beat the holder.
 */
export const nextPrice = (current: number | null): number =>
  current === null ? BASE_CENTS : Math.max(current + 1, Math.ceil(current * (1 + STEP)));

/**
 * A quote for a rectangle: what each of its cells costs, and what that sums to.
 *
 * Priced per cell and never per rectangle, which is the decision the entire
 * mechanic rests on. Compare totals instead and $500 over 400 cells beats $499
 * over one, so a single large payment locks the wall against every smaller
 * buyer, nothing ever changes hands again, and the board stops producing
 * revenue on the day its richest visitor arrives. Per cell, the same $500 is a
 * choice: 400 cells at $1.25 each, sprawling and takeable by anyone with $1.50,
 * or 25 cells at $20 each that nobody will touch for a long time. Area or
 * armour, bought with the same money.
 *
 * `cells` carries the per-cell floors rather than only the total, because the
 * interface has to show *which* cells are expensive. A rectangle drawn over
 * somebody's fortress should look expensive before the total is read.
 */
export type Quote = {
  rect: Rect;
  /** Row-major, one per cell of `rect`. */
  cells: { x: number; y: number; priceCents: number; heldCents: number | null }[];
  totalCents: number;
  /** `totalCents / area`, for display. Not a rule: nothing is decided on it. */
  perCellCents: number;
  /** Cells in this rectangle somebody already holds. Drives the copy. */
  takeovers: number;
};

/** Prices a rectangle against what is currently held. */
export function quote(rect: Rect, held: Held): Quote {
  const cells = cellsIn(rect).map(({ x, y }) => {
    const heldCents = held(x, y)?.priceCents ?? null;
    return { x, y, heldCents, priceCents: nextPrice(heldCents) };
  });
  const totalCents = cells.reduce((sum, c) => sum + c.priceCents, 0);
  return {
    rect,
    cells,
    totalCents,
    perCellCents: Math.round(totalCents / areaOf(rect)),
    takeovers: cells.filter(c => c.heldCents !== null).length,
  };
}

/**
 * Does this payment actually take every cell it claims?
 *
 * The Worker's last word, run inside the same transaction that writes the
 * cells, against rows read in that transaction. Everything before it — the
 * quote the client showed, the amount Stripe captured — was computed against a
 * wall that may have moved since, and on a board whose whole appeal is that
 * people are taking cells from each other, it will have.
 *
 * All or nothing per claim, deliberately. Partial success would mean charging
 * somebody for a rectangle and handing them a subset of it, and "you got 9 of
 * your 12 cells" is a support conversation rather than a product. A claim that
 * loses a race is refunded whole; see `worker/wall/stripe.ts`.
 */
export function beats(paid: Quote, held: Held): boolean {
  return paid.cells.every(c => c.priceCents >= nextPrice(held(c.x, c.y)?.priceCents ?? null));
}

/**
 * Money, as people read it.
 *
 * Whole dollars lose the cent and the cent is load-bearing here: a price of
 * $1.20 that renders as "$1" makes the 20% step invisible, and the step is the
 * thing the interface is trying to teach.
 */
export const money = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
