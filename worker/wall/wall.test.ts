import { describe, expect, test } from "bun:test";
import { cellsIn, type Rect } from "../../src/wall/geometry";
import { BASE_CENTS, nextPrice } from "../../src/wall/pricing";
import {
  cellsInBox,
  chunkCells,
  chunkVersions,
  counters,
  insertPendingClaim,
  recountClaimed,
  recordVisitDays,
  settleClaim,
  visits,
  type D1Database,
} from "./db";
import { sqliteD1 } from "./sqlite";

/**
 * The settle path, against the real SQL over the real migrations.
 *
 * Every rule that matters here is a constraint rather than a check in
 * application code, so a suite that mocked the database would assert the happy
 * path and nothing else — which on a wall where two buyers race for one cell is
 * the only path that never needed testing.
 */

const AT = 1_770_000_000;

const claim = (db: D1Database, id: string, rect: Rect, prices: number[]) =>
  insertPendingClaim(db, {
    id,
    ...rect,
    label: id,
    url: `https://${id}.example/`,
    imageKey: null,
    imageSource: null,
    totalCents: prices.reduce((a, b) => a + b, 0),
    prices,
    ownerHash: `owner-${id}`,
    email: null,
    at: AT,
  }).run();

const settle = (db: D1Database, eventId: string, id: string, rect: Rect, prices: number[]) =>
  db.batch([
    ...settleClaim(db, {
      eventId,
      sessionId: `cs_${eventId}`,
      claim: {
        id,
        cells: cellsIn(rect).map((cell, i) => ({ ...cell, priceCents: prices[i]! })),
      },
      amountCents: prices.reduce((a, b) => a + b, 0),
      at: AT,
    }),
    recountClaimed(db),
  ]);

const fresh = () => sqliteD1(":memory:");

describe("settling a claim", () => {
  const rect: Rect = { x: 4, y: 4, w: 2, h: 2 };
  const base = [BASE_CENTS, BASE_CENTS, BASE_CENTS, BASE_CENTS];

  test("writes the cells, the chunk version and the counters", async () => {
    const db = fresh();
    await claim(db, "a", rect, base);
    await settle(db, "evt_1", "a", rect, base);

    expect((await cellsInBox(db, 4, 4, 5, 5)).length).toBe(4);
    expect(await chunkVersions(db)).toEqual([{ key: "0_0", version: 1 }]);
    expect(await counters(db)).toEqual({ claimed: 4, cents: 4 * BASE_CENTS });
  });

  test("the claim goes active and its cells join to it", async () => {
    const db = fresh();
    await claim(db, "a", rect, base);
    await settle(db, "evt_1", "a", rect, base);

    const rows = await chunkCells(db, { cx: 0, cy: 0 });
    expect(rows).toHaveLength(4);
    expect(rows[0]!.label).toBe("a");
    // The claim's own rectangle travels with every cell, which is what lets one
    // image span it after cells have been taken out of the middle.
    expect(rows[0]!.rw).toBe(2);
  });

  test("a redelivered webhook changes nothing", async () => {
    const db = fresh();
    await claim(db, "a", rect, base);
    await settle(db, "evt_1", "a", rect, base);

    // Stripe redelivers. The payment row's primary key is the event id, so the
    // second delivery loses an INSERT and the whole batch unwinds.
    expect(settle(db, "evt_1", "a", rect, base)).rejects.toThrow();
    expect(await counters(db)).toEqual({ claimed: 4, cents: 4 * BASE_CENTS });
  });
});

describe("taking cells from someone", () => {
  const one: Rect = { x: 0, y: 0, w: 1, h: 1 };

  test("a higher price takes the cell and raises its floor", async () => {
    const db = fresh();
    await claim(db, "a", one, [BASE_CENTS]);
    await settle(db, "evt_1", "a", one, [BASE_CENTS]);

    const taken = nextPrice(BASE_CENTS);
    await claim(db, "b", one, [taken]);
    await settle(db, "evt_2", "b", one, [taken]);

    const [cell] = await cellsInBox(db, 0, 0, 0, 0);
    expect(cell!.claim_id).toBe("b");
    expect(cell!.price_cents).toBe(taken);
    // Taken, not added: the wall did not gain a cell, it changed hands.
    expect((await counters(db)).claimed).toBe(1);
  });

  test("a lower price does not take it, however the batch is shaped", async () => {
    const db = fresh();
    await claim(db, "a", one, [10_000]);
    await settle(db, "evt_1", "a", one, [10_000]);

    // The conditional upsert is the last line of defence, under the quote and
    // under `beats()`: a claim that somehow reaches the batch with a losing
    // price must still not take the cell.
    await claim(db, "b", one, [BASE_CENTS]);
    await settle(db, "evt_2", "b", one, [BASE_CENTS]);

    const [cell] = await cellsInBox(db, 0, 0, 0, 0);
    expect(cell!.claim_id).toBe("a");
    expect(cell!.price_cents).toBe(10_000);

    // And no history either: nothing changed hands, so nothing is recorded as
    // having done so.
    const { results } = await db
      .prepare("SELECT claim_id FROM history WHERE x = 0 AND y = 0")
      .all<{ claim_id: string }>();
    expect(results).toEqual([{ claim_id: "a" }]);
  });

  test("a partial takeover leaves the rest of the claim in place", async () => {
    const db = fresh();
    const big: Rect = { x: 8, y: 8, w: 3, h: 3 };
    const prices = Array(9).fill(BASE_CENTS);
    await claim(db, "a", big, prices);
    await settle(db, "evt_1", "a", big, prices);

    // One cell out of the middle of a nine-cell claim.
    const bite: Rect = { x: 9, y: 9, w: 1, h: 1 };
    const taken = nextPrice(BASE_CENTS);
    await claim(db, "b", bite, [taken]);
    await settle(db, "evt_2", "b", bite, [taken]);

    const rows = await cellsInBox(db, 8, 8, 10, 10);
    expect(rows.filter(r => r.claim_id === "a")).toHaveLength(8);
    expect(rows.filter(r => r.claim_id === "b")).toHaveLength(1);
    // Nine cells are still claimed. One of them belongs to somebody else now.
    expect((await counters(db)).claimed).toBe(9);
  });

  test("history records every hand a cell has passed through", async () => {
    const db = fresh();
    await claim(db, "a", one, [BASE_CENTS]);
    await settle(db, "evt_1", "a", one, [BASE_CENTS]);
    const taken = nextPrice(BASE_CENTS);
    await claim(db, "b", one, [taken]);
    await settle(db, "evt_2", "b", one, [taken]);

    const { results } = await db
      .prepare("SELECT claim_id, took_from, price_cents FROM history WHERE x = 0 AND y = 0 ORDER BY rowid")
      .all<{ claim_id: string; took_from: string | null; price_cents: number }>();

    expect(results).toEqual([
      { claim_id: "a", took_from: null, price_cents: BASE_CENTS },
      { claim_id: "b", took_from: "a", price_cents: taken },
    ]);
  });

  test("a takeover bumps the chunk version, so cached bodies stop being served", async () => {
    const db = fresh();
    await claim(db, "a", one, [BASE_CENTS]);
    await settle(db, "evt_1", "a", one, [BASE_CENTS]);
    const taken = nextPrice(BASE_CENTS);
    await claim(db, "b", one, [taken]);
    await settle(db, "evt_2", "b", one, [taken]);

    expect(await chunkVersions(db)).toEqual([{ key: "0_0", version: 2 }]);
  });
});

describe("moderation", () => {
  test("a hidden claim keeps its cells and keeps them priced", async () => {
    const db = fresh();
    const one: Rect = { x: 0, y: 0, w: 1, h: 1 };
    await claim(db, "a", one, [5_000]);
    await settle(db, "evt_1", "a", one, [5_000]);

    await db.prepare("UPDATE claims SET hidden_at = ?1 WHERE id = 'a'").bind(AT).run();

    // Blanked, not dropped. A moderated cell that read as unclaimed is a cell
    // somebody could buy back at the base price, which would make moderation a
    // discount for whoever posted the thing that got hidden.
    const rows = await chunkCells(db, { cx: 0, cy: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("");
    expect(rows[0]!.image_key).toBeNull();
    expect((await cellsInBox(db, 0, 0, 0, 0))[0]!.price_cents).toBe(5_000);
  });
});

/**
 * The visit ledger, against the real table.
 *
 * It exists because Analytics Engine forgets after three months and "since
 * launch" must not. Everything below is about the rollup being safe to run
 * again — which it is, hourly, forever.
 */
describe("visits since launch", () => {
  test("an empty wall has none, rather than null", async () => {
    expect(await visits(fresh())).toBe(0);
  });

  test("adds the days up", async () => {
    const db = fresh();
    await recordVisitDays(db, [
      { day: 20687, visitors: 41 },
      { day: 20688, visitors: 128 },
    ]);
    expect(await visits(db)).toBe(169);
  });

  /* The rollup re-reads days it has already written, every hour, by design:
   * today's row is a partial count until the day ends. Re-running must replace
   * the figure rather than add to it, or the total inflates by an hour's worth
   * of double-counting every hour. */
  test("re-running the rollup replaces a day rather than adding to it", async () => {
    const db = fresh();
    await recordVisitDays(db, [{ day: 20689, visitors: 7 }]);
    await recordVisitDays(db, [{ day: 20689, visitors: 12 }]);
    expect(await visits(db)).toBe(12);
  });

  test("a run with nothing to write is not an error", async () => {
    const db = fresh();
    await recordVisitDays(db, []);
    expect(await visits(db)).toBe(0);
  });
});
