import { chunkKey, type Chunk } from "../../src/wall/geometry";
import type { CellRow } from "../../src/wall/chunk";

/**
 * The wall's storage.
 *
 * Raw prepared statements rather than an ORM, which is a decision about how
 * small this surface is rather than a position on ORMs: `wrangler d1
 * migrations` is first-party and there is no first-party ORM to pair with it,
 * `.bind()` is already parameterised, and everything the wall asks of a
 * database is in this file. If it outgrows that, `migrations_pattern` lets
 * wrangler apply drizzle-kit's output over the same migrations table, so
 * starting raw strands nothing.
 *
 * The types below are structural rather than imported from
 * `@cloudflare/workers-types`. A shape this small is what lets the tests run
 * the real queries against `bun:sqlite` instead of a mock, which matters more
 * here than anywhere: every rule this wall has is a constraint, so a suite that
 * stubs the database out asserts the happy path and nothing else.
 */

export type D1Result<T> = { results: T[] };
export type D1Meta = { changes: number };

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: D1Meta }>;
};

export type D1Database = {
  prepare(sql: string): D1PreparedStatement;
  /**
   * A real transaction: sequential, non-concurrent, and rolled back whole if
   * any statement fails. That is exactly the shape a claim needs — record the
   * payment, take every cell, bump the chunks' versions — and it is why the
   * uniqueness constraints can be the concurrency control rather than something
   * application code has to reason about.
   */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

/** What a claim looks like coming out of the database. */
export type ClaimRow = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  url: string;
  image_key: string | null;
  image_source: string | null;
  total_cents: number;
  prices: string;
  status: string;
  owner_hash: string;
  email: string | null;
  at: number;
  hidden_at: number | null;
};

/** A chunk's write counter. Everything the index serves. */
export type ChunkState = { key: string; version: number };

/**
 * Every claimed cell in a box, with its price.
 *
 * The read behind a write: pricing a rectangle needs to know what each of its
 * cells currently costs, and the box that answers it is the rectangle itself.
 * Asking for the *chunks* covering that box would drag back up to four
 * chunk-fulls of rows to answer a question about sixteen cells.
 */
export async function cellsInBox(
  db: D1Database,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<{ x: number; y: number; price_cents: number; claim_id: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT x, y, price_cents, claim_id FROM cells
       WHERE x BETWEEN ?1 AND ?2 AND y BETWEEN ?3 AND ?4`,
    )
    .bind(x0, x1, y0, y1)
    .all<{ x: number; y: number; price_cents: number; claim_id: string }>();
  return results;
}

/**
 * One chunk's cells, joined to the claims that own them.
 *
 * A join rather than two round trips, because the client needs both halves to
 * draw anything: a cell's price comes off `cells` and its artwork off `claims`,
 * and a chunk body that carried only the first would be a grid of prices.
 *
 * Hidden claims come back with their identity blanked rather than being dropped
 * from the result. Dropping them would make a moderated cell read as unclaimed,
 * which is a cell somebody could then buy at the base price — moderation would
 * be a discount. The cell stays held, stays priced, and draws as a blank.
 */
export async function chunkCells(db: D1Database, chunk: Chunk): Promise<CellRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.x, c.y, c.price_cents, c.claim_id,
              CASE WHEN m.hidden_at IS NULL THEN m.label ELSE '' END AS label,
              CASE WHEN m.hidden_at IS NULL THEN m.url ELSE '' END AS url,
              CASE WHEN m.hidden_at IS NULL THEN m.image_key ELSE NULL END AS image_key,
              m.x AS rx, m.y AS ry, m.w AS rw, m.h AS rh
       FROM cells c JOIN claims m ON m.id = c.claim_id
       WHERE c.cx = ?1 AND c.cy = ?2
       ORDER BY c.y, c.x`,
    )
    .bind(chunk.cx, chunk.cy)
    .all<CellRow>();
  return results;
}

/** Every chunk's current version. Sixteen rows on a 128-cell wall, so the
 * index is served whole rather than per region. */
export async function chunkVersions(db: D1Database): Promise<ChunkState[]> {
  const { results } = await db
    .prepare("SELECT cx, cy, version FROM chunks")
    .all<{ cx: number; cy: number; version: number }>();
  return results.map(row => ({ key: chunkKey(row), version: row.version }));
}

/** The two counters the index carries: cells claimed, and cents taken. */
export async function counters(db: D1Database): Promise<{ claimed: number; cents: number }> {
  const { results } = await db.prepare("SELECT k, v FROM meta").all<{ k: string; v: number }>();
  const read = (k: string) => results.find(row => row.k === k)?.v ?? 0;
  return { claimed: read("claimed"), cents: read("cents") };
}

/**
 * The wall's visits since launch: distinct visitors on each day, added up.
 *
 * A `SUM` over one row per day, which is 365 rows a year and will not need an
 * index this decade. Zero when the table is empty, which is a new deployment
 * rather than an error — `COALESCE`, because `SUM` over no rows is `NULL`.
 */
export async function visits(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(visitors), 0) AS total FROM visit_days")
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * Write the daily figures the rollup read out of Analytics Engine.
 *
 * An upsert rather than an insert, and that is what makes the rollup safe to
 * run as often as it likes: the current day's row is a partial count that gets
 * overwritten by a larger one every hour until the day ends, and re-reading a
 * finished day writes the same number it already held. A missed run repairs
 * itself on the next one, because the query behind this looks back further than
 * the interval between runs.
 */
export function recordVisitDays(
  db: D1Database,
  days: { day: number; visitors: number }[],
): Promise<unknown> {
  if (!days.length) return Promise.resolve();
  return db.batch(
    days.map(entry =>
      db
        .prepare(
          `INSERT INTO visit_days (day, visitors) VALUES (?1, ?2)
           ON CONFLICT (day) DO UPDATE SET visitors = ?2`,
        )
        .bind(entry.day, entry.visitors),
    ),
  );
}

export async function claimById(db: D1Database, id: string): Promise<ClaimRow | null> {
  return db.prepare("SELECT * FROM claims WHERE id = ?1").bind(id).first<ClaimRow>();
}

/** What this owner has bought, newest first, with how much of it survives. */
export async function claimsByOwner(db: D1Database, ownerHash: string) {
  const { results } = await db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM cells WHERE claim_id = m.id) AS held
       FROM claims m WHERE m.owner_hash = ?1 AND m.status = 'active'
       ORDER BY m.at DESC LIMIT 100`,
    )
    .bind(ownerHash)
    .all<ClaimRow & { held: number }>();
  return results;
}

/** A cell's whole life: who has held it, at what, in order. */
export async function cellHistory(db: D1Database, x: number, y: number) {
  const { results } = await db
    .prepare(
      `SELECT h.price_cents, h.at, h.claim_id,
              CASE WHEN m.hidden_at IS NULL THEN m.label ELSE '' END AS label
       FROM history h JOIN claims m ON m.id = h.claim_id
       WHERE h.x = ?1 AND h.y = ?2 ORDER BY h.at ASC`,
    )
    .bind(x, y)
    .all<{ price_cents: number; at: number; claim_id: string; label: string }>();
  return results;
}

/** A claim, written before anyone pays for it. */
export function insertPendingClaim(
  db: D1Database,
  claim: {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    label: string;
    url: string;
    imageKey: string | null;
    imageSource: string | null;
    totalCents: number;
    /** Row-major cents, one per cell of the rectangle. */
    prices: number[];
    ownerHash: string;
    email: string | null;
    at: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO claims
         (id, x, y, w, h, label, url, image_key, image_source, total_cents, prices, status, owner_hash, email, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?14)`,
    )
    .bind(
      claim.id,
      claim.x,
      claim.y,
      claim.w,
      claim.h,
      claim.label,
      claim.url,
      claim.imageKey,
      claim.imageSource,
      claim.totalCents,
      JSON.stringify(claim.prices),
      claim.ownerHash,
      claim.email,
      claim.at,
    );
}

/**
 * The whole of a settled purchase, as one batch.
 *
 * Every statement here is part of one transaction and the order is not
 * incidental:
 *
 * 1. The payment row goes first, and its primary key is Stripe's *event* id.
 *    Stripe redelivers webhooks — it says so — so the second delivery of the
 *    same event loses this INSERT, the batch rolls back, and nothing else in
 *    the list runs. Idempotency is a constraint rather than a check, for the
 *    same reason everything else here is.
 *
 * 2. Each cell is written with `ON CONFLICT DO UPDATE ... WHERE excluded.price
 *    > cells.price`, so a cell can only be taken by a price that actually beats
 *    it. `changes` on the result is how the caller learns whether it did: a
 *    conflicting write that fails the WHERE reports zero, and the caller
 *    refunds rather than half-selling a rectangle. The check is *also* in
 *    `pricing.ts` and run before this, and that duplication is deliberate —
 *    that one is the quote, this one is the truth, and only this one is
 *    serialised against every other buyer.
 *
 * 3. History, per cell, keyed to nothing and deleted by nothing. It runs
 *    *before* the upsert, because `took_from` is read out of the row the upsert
 *    is about to overwrite, and it carries the same price condition so that a
 *    losing claim does not record a takeover that never happened.
 *
 * 4. The chunk versions, so cached bodies for the affected chunks stop being
 *    served, and the counters the index reports.
 */
export function settleClaim(
  db: D1Database,
  args: {
    eventId: string;
    sessionId: string;
    claim: { id: string; cells: { x: number; y: number; priceCents: number }[] };
    amountCents: number;
    at: number;
  },
): D1PreparedStatement[] {
  const { eventId, sessionId, claim, amountCents, at } = args;
  const chunks = new Map<string, Chunk>();

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO payments (event_id, session_id, claim_id, amount_cents, at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(eventId, sessionId, claim.id, amountCents, at),
  ];

  for (const cell of claim.cells) {
    const cx = Math.floor(cell.x / 32);
    const cy = Math.floor(cell.y / 32);
    chunks.set(`${cx}_${cy}`, { cx, cy });

    statements.push(
      /*
       * History first, and the order is not cosmetic.
       *
       * `took_from` is read out of `cells`, so it has to run while that row
       * still holds the *previous* claim. Written after the upsert it reads the
       * row that just replaced it, and every cell on the wall records itself as
       * having taken the cell from its own new owner. That is a wrong answer
       * that looks plausible in every individual row, which is why it survived
       * until a test compared two of them.
       *
       * The WHERE is the same condition as the upsert below, restated rather
       * than shared because SQL has nowhere to put it once. Without it a losing
       * claim writes a takeover that never happened.
       */
      db
        .prepare(
          `INSERT INTO history (x, y, claim_id, price_cents, took_from, at)
           SELECT ?1, ?2, ?3, ?4, (SELECT claim_id FROM cells WHERE x = ?1 AND y = ?2), ?5
           WHERE ?4 > COALESCE((SELECT price_cents FROM cells WHERE x = ?1 AND y = ?2), 0)`,
        )
        .bind(cell.x, cell.y, claim.id, cell.priceCents, at),
      db
        .prepare(
          `INSERT INTO cells (x, y, cx, cy, claim_id, price_cents, at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (x, y) DO UPDATE SET
             claim_id = excluded.claim_id,
             price_cents = excluded.price_cents,
             at = excluded.at
           WHERE excluded.price_cents > cells.price_cents`,
        )
        .bind(cell.x, cell.y, cx, cy, claim.id, cell.priceCents, at),
    );
  }

  for (const chunk of chunks.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO chunks (cx, cy, version) VALUES (?1, ?2, 1)
           ON CONFLICT (cx, cy) DO UPDATE SET version = chunks.version + 1`,
        )
        .bind(chunk.cx, chunk.cy),
    );
  }

  statements.push(
    db.prepare("UPDATE claims SET status = 'active' WHERE id = ?1").bind(claim.id),
    bumpMeta(db, "cents", amountCents),
  );

  return statements;
}

/** A counter, created on first use rather than seeded by the migration. */
export function bumpMeta(db: D1Database, key: string, by: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO meta (k, v) VALUES (?1, ?2)
       ON CONFLICT (k) DO UPDATE SET v = meta.v + ?2`,
    )
    .bind(key, by);
}

/** Recount the claimed cells. Run after a settle rather than incremented in
 * it, because a takeover moves a cell without changing how many are claimed
 * and the increment would have to know which of its writes were takeovers. */
export function recountClaimed(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO meta (k, v) VALUES ('claimed', (SELECT COUNT(*) FROM cells))
     ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
  );
}

/** Mark a claim lost. Its cells were taken between quote and settle; the money
 * goes back and the row stays, because the payment happened. */
export function markLost(db: D1Database, claimId: string): D1PreparedStatement {
  return db.prepare("UPDATE claims SET status = 'lost' WHERE id = ?1").bind(claimId);
}
