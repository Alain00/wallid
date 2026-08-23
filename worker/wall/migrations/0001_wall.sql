-- The wall.
--
-- Every uniqueness rule this wall has is a constraint here rather than a check
-- in application code, because a SELECT-then-INSERT does not survive two Worker
-- invocations arriving at once and a failed INSERT does. On a board whose whole
-- appeal is people taking cells from each other, those two invocations are the
-- normal case rather than the edge one. See ADR 0001.
--
-- Nothing is seeded. An empty wall is a state the rules express, and it lasts
-- exactly one purchase.

-- A cell, and what is currently true of it.
--
-- One row per *claimed* cell, not one per cell of the wall. 16,384 rows would
-- be a fine table and a worse read path: a chunk query would return 1024 rows
-- of mostly nothing, and the emptiness of a new wall would cost the same as a
-- full one.
--
-- Keyed by absolute cell, which makes "two claims racing for one cell" a
-- primary key violation rather than a paragraph of logic. `cx`/`cy` are the
-- cell's chunk, stored rather than computed, so the query that runs on every
-- read can use an index.
CREATE TABLE cells (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  cx INTEGER NOT NULL,
  cy INTEGER NOT NULL,
  -- The claim this cell currently belongs to. A claim covers a rectangle, but
  -- ownership is per cell, because a rectangle can be eaten into: somebody
  -- buying four cells out of the middle of a 12x12 leaves the other 140 exactly
  -- where they were. The rectangle is how you buy. It is not what you own.
  claim_id TEXT NOT NULL REFERENCES claims(id),
  -- What was paid for this one cell, in cents. The next holder must beat it by
  -- `STEP` (see `src/wall/pricing.ts`), so this is the cell's floor as well as
  -- its history. Never decreases: a cell taken is a cell that got more
  -- expensive, and that ratchet is the business.
  price_cents INTEGER NOT NULL,
  -- Whole seconds.
  at INTEGER NOT NULL,
  PRIMARY KEY (x, y)
) WITHOUT ROWID;

-- The read path: one chunk, every time anybody looks at the wall.
CREATE INDEX cells_by_chunk ON cells (cx, cy);

-- "What do I own?" and the takeover notification, which is the same query from
-- the other end: given a claim, which of its cells are still its own.
CREATE INDEX cells_by_claim ON cells (claim_id);

-- A purchase: a rectangle, an owner, an artwork, and the payment behind it.
--
-- Claims are never deleted, including when every one of their cells has been
-- taken away. A claim with no cells left is the wall's history, it is the
-- receipt behind a payment that really happened, and it is what the owner's
-- "you were outbid" mail links to. Moderation hides a claim rather than
-- removing it; see `hidden_at`.
CREATE TABLE claims (
  -- Not an autoincrement. The id appears in URLs and in the Stripe metadata
  -- that survives a webhook redelivery, so it is generated before the payment
  -- rather than by the insert that follows it.
  id TEXT NOT NULL PRIMARY KEY,

  -- The rectangle as bought. Kept even as cells are lost from it, because it
  -- is what the buyer paid for and what the receipt has to be able to show.
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,

  -- What the claim points at, and what it is called. `label` renders as text,
  -- never as markup; `url` is the only outbound link on this wall and is
  -- normalised and scheme-checked before it gets here.
  label TEXT NOT NULL,
  url TEXT NOT NULL,

  -- The artwork, in R2, keyed by content hash. Null while a claim is still
  -- pending, and null again if moderation pulls the image but leaves the claim
  -- standing; the renderer falls back to the label on its own ground.
  image_key TEXT,

  -- How the artwork arrived: `upload` if the buyer chose a file, `favicon` if
  -- we fetched it from `url`. Kept because the two need different moderation
  -- postures, and because a favicon that changes upstream is a thing we may
  -- want to re-fetch later while an upload never is.
  image_source TEXT,

  -- Cents, summed across the rectangle at purchase time. Redundant against the
  -- cells' own prices the moment one is taken, which is exactly why it is here:
  -- it is the amount charged, and it must not move when the wall does.
  total_cents INTEGER NOT NULL,

  -- The per-cell prices this claim was quoted at, row-major over its rectangle,
  -- as a JSON array of cents.
  --
  -- The total is not enough to settle with. A claim wins or loses *per cell* —
  -- that is the whole mechanic — so the webhook has to compare what was paid
  -- for each cell against what that cell now costs, and a sum cannot answer
  -- that: a rectangle whose total covers the new prices may still have one cell
  -- that was outbid, and settling it would be selling armour at sprawl prices.
  -- It is also what the cells are written at, which is what keeps the ratchet
  -- climbing by what somebody paid rather than by what they could have paid.
  prices TEXT NOT NULL,

  -- `pending` until Stripe confirms, `active` once the cells are written,
  -- `lost` if the wall moved under it and the money was refunded, `refunded`
  -- for a support refund after the fact.
  status TEXT NOT NULL,

  -- The buyer, hashed. See `identity.ts`: an owner token in a cookie, and an
  -- email address kept only as a hash plus a send-to address for the outbid
  -- notification.
  owner_hash TEXT NOT NULL,
  email TEXT,

  at INTEGER NOT NULL,

  -- Set by moderation. A hidden claim keeps its cells and keeps them priced —
  -- hiding is not a refund, and it must not hand the wall back to whoever put
  -- something there.
  hidden_at INTEGER,
  hidden_reason TEXT
);

CREATE INDEX claims_by_owner ON claims (owner_hash);

-- The payment side, on its own table and keyed by Stripe's id.
--
-- Separate from `claims` for one reason: a webhook is delivered more than once.
-- Stripe says so explicitly, and the failure mode of ignoring it is charging
-- somebody's rectangle onto the wall twice, or worse, twice at two different
-- prices. The primary key here is the idempotency: the second delivery of the
-- same event loses an INSERT and does nothing, in the same transaction that
-- would otherwise have written the cells.
CREATE TABLE payments (
  -- Stripe's `checkout.session.completed` event id, not the session id. The
  -- event is the thing that can be redelivered.
  event_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  amount_cents INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX payments_by_claim ON payments (claim_id);

-- Every time a cell changed hands, kept forever.
--
-- Not an audit log bolted on out of habit. A cell that has been taken nine
-- times is the most interesting thing on this wall and there is no way to know
-- that from `cells`, which holds only the current truth. It is what the cell's
-- page shows, it is where "most contested cell" comes from, and it is the only
-- record that survives a claim being hidden.
CREATE TABLE history (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  price_cents INTEGER NOT NULL,
  -- The claim this one took the cell from, or null for a first claim.
  took_from TEXT REFERENCES claims(id),
  at INTEGER NOT NULL
);

CREATE INDEX history_by_cell ON history (x, y, at);

-- A chunk's write counter, which is what makes its body cacheable forever.
--
-- `version` climbs on every write to the chunk, purchases and moderation alike,
-- and never decrements. The URL carries it (`/wall/c/3_2/812`), so a body is
-- fetched at most once by a client, ever, and learning which version is current
-- costs one small index request rather than one per chunk.
--
-- No `count` column and no full-chunk freeze, unlike a wall where placement is
-- permanent. Here a full chunk is the *most* likely to change: it is where the
-- contested cells are.
CREATE TABLE chunks (
  cx INTEGER NOT NULL,
  cy INTEGER NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (cx, cy)
);

-- Counters the client cannot derive: how many cells are claimed at all, and
-- what the wall has taken in total. Both are read on the index request that
-- every visitor makes, and both would otherwise be a scan of the two tables
-- that grow forever.
CREATE TABLE meta (
  k TEXT NOT NULL PRIMARY KEY,
  v INTEGER NOT NULL
);
