# The wall is bounded, and priced per cell

wallid is a fixed board of 16,384 cells. You drag out a rectangle, put your logo
in it, and pay for it. It is yours until somebody pays more than you did.

The mechanic is borrowed from the pay-to-rank leaderboards of August 2026 —
outbid.lol and the wave behind it — and the borrowing is deliberate about which
half it takes. Those boards are viral because of the **ratchet**, not because of
the ad slot: the price only goes up, being passed is public, and the fix is one
click of paying more. A time-boxed rental with a fixed price has none of that.
It is an ad slot with an auction bolted on.

What this adds is that the ratchet is *spatial*. A leaderboard has one #1 and a
single axis to climb. A wall has location, size, shape and neighbours, so being
outbid is not a row sliding down a list, it is somebody eating a hole in the
middle of your square, visibly, in a shape you can see from across the room.

## Price per cell, never per rectangle

The single decision the whole project rests on.

Compare totals and the mechanic breaks on the first day it succeeds. $500 over
400 cells beats $499 over one, so one large payment locks the wall against every
smaller buyer, nothing ever changes hands again, and the board stops producing
revenue on the day its richest visitor arrives.

Per cell, the same $500 is a choice:

- 400 cells at $1.25 each. Sprawling, and takeable by anyone with $1.50.
- 25 cells at $20 each. Small, and nobody will touch it for a long time.

**Area or armour, bought with the same money.** That tension is the game, and it
is free the moment you divide by cell count. Every cell carries its own floor,
every floor only goes up, and the wall's value ratchets cell by cell instead of
one number climbing on a leaderboard. A cell that has changed hands nine times
is the most interesting thing on the board, which is why `history` is kept
forever and never pruned.

The step is 20%, not a cent. At a cent of increment the cheapest way to hold a
cell forever is a script that reclaims it for a cent more, every time, and the
wall becomes two bots trading a cell at $0.01 steps.

## Bounded, and this is the opposite call from a participatory wall

An open-ended wall where anybody may place one tile is unbounded on purpose:
occupancy is the medium, and the empty regions past the crowd are the canvas.

Here the medium is ownership under contest, and contest needs a fixed board.
Scarcity *is* the product. A cell is worth something because there are 16,384 of
them and there will not be a 16,385th — grow the wall and cheap new ground
appears beside expensive old ground, and the price of the old ground was a
statement about how much wall exists. `SIDE` will invite being changed later,
which is why the reason is written at the constant rather than here.

128 is also 4x4 chunks, so the whole board is sixteen chunk bodies. That is
small enough for a client to hold outright, which is what makes the index a
single shared URL and the zoomed-out overview a plain render rather than a
second tile format. The bound pays for itself twice.

## All or nothing, per claim

A claim's cells are quoted together, paid for together, and settled together. If
any one of them is bought by somebody else in the seconds between the quote and
the webhook, the whole claim is refunded.

Partial settlement is the tempting alternative and it is wrong on the axis that
matters: "you got 9 of your 12 cells" is a support conversation rather than a
product, and it is the shape of failure most likely to end at somebody's bank.
Refunds are the single largest operational risk here — a person whose square was
eaten has a chargeback narrative that sounds sympathetic — so the rules page
leads with eviction rather than burying it, and the one case where money does
come back is automatic.

## Consequences

- The webhook, not the checkout, is where a payment becomes cells. Stripe
  redelivers webhooks, so the event id is the primary key of `payments` and
  idempotency is a constraint rather than a check.
- `beats()` runs twice: once as a quote the buyer reads, once inside the settling
  transaction against rows read in that transaction. Only the second is
  serialised against other buyers.
- Cells are written at the price actually paid, not at the lower price the wall
  might currently be asking, which is what keeps the ratchet climbing.
- Moderation hides a claim and never refunds it. Handing the wall back would make
  moderation a discount for whoever posted the thing that got hidden.

**Revisit when** the wall stops moving. At some point every cell has a price
nobody will beat and the board freezes. The lever is a slow decay on the floors
so land re-liquefies, and it costs the cleanest sentence in the pitch — prices
only go up. Do not add it pre-emptively: a wall too expensive to move in month
three is a good problem, and the decay rate should be set with the data rather
than guessed now. Watch the ratio of first claims to takeovers.
