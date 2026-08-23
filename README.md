# wallid

A fixed wall of 16,384 cells. Buy a rectangle of it, put your logo in it, hold it
until somebody pays more than you did.

Prices only go up, and they go up **per cell**: a cell nobody holds costs $1, a
cell somebody holds costs 20% more than they paid. Read
[ADR 0001](docs/adr/0001-the-wall-is-bounded-and-priced-per-cell.md) before
changing anything about pricing or the size of the board — both are decisions
that cannot be revisited once people have paid.

## Running it

```sh
bun install
bun run dev        # http://localhost:3000
```

The dev server is a `Bun.serve`, not a Worker, but it runs the *same* router
over the *same* SQL and the same migrations against `bun:sqlite`, and R2 is a
directory under `.wrangler/state`. What it does not run is Cloudflare: no edge
cache, no real D1, no Turnstile latency. Reach for `bunx wrangler dev` when the
question is about the platform rather than about the wall.

With no `.dev.vars` you still get a working wall up to the point where money is
involved — Turnstile falls back to Cloudflare's published always-passes test
secret, so the challenge is verified for real, and `/wall/checkout` refuses with
"payments are not configured" rather than pretending.

```sh
bun test           # 46 tests, including the settle path against real SQL
bun run typecheck
bun run build
```

## First deploy

Four steps, and three of them cannot be done from the repo.

```sh
# 1. The database. Paste the printed id into wrangler.jsonc.
bunx wrangler d1 create wallid
bun run migrate

# 2. The artwork bucket.
bunx wrangler r2 bucket create wallid-artwork

# 3. Secrets. See .dev.vars.example for what each one is.
bunx wrangler secret put WALL_SECRET
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put STRIPE_SECRET_KEY
bunx wrangler secret put STRIPE_WEBHOOK_SECRET
bunx wrangler secret put WALL_ADMIN_TOKEN
bunx wrangler secret put WALL_BLOCKLIST

# 4. Ship.
bun run deploy
```

Then, in Stripe: add `https://wallid.lol/wall/webhook` as an endpoint listening
for `checkout.session.completed`, and put its signing secret in
`STRIPE_WEBHOOK_SECRET`. Locally, `stripe listen --forward-to
localhost:3000/wall/webhook` prints one to use instead.

DNS: `wrangler.jsonc` claims the apex and `www` as custom domains, so any A
record already on them has to be deleted first or the deploy fails on the
conflict. `origin.ts` names the apex as canonical, so add a Redirect Rule
sending `www` to it — Cloudflare will not do that on its own, and two hostnames
serving identical content splits every cache in the path.

## How it fits together

```
src/wall/geometry.ts   the board: bounds, chunks, rectangles
src/wall/pricing.ts    the rules: what a rectangle costs and when it wins
src/wall/chunk.ts      the wire format between D1, the Worker and the canvas
src/wall/source.ts     the client's fetching and caching
src/wall/paint.ts      the canvas renderer
worker/wall/db.ts      every query, as raw prepared statements
worker/wall/index.ts   the router, and the cache headers that pay for it
worker/wall/stripe.ts  checkout, refunds, webhook signatures — over fetch
worker/wall/artwork.ts favicon fetching, upload sniffing, URL normalisation
```

`geometry.ts` and `pricing.ts` are imported by **both** sides. That is deliberate
and load-bearing: a client that quotes a price the server would refuse is a buyer
about to be surprised by their own receipt.

## Things that will look like bugs and are not

- **A stranger's claim takes up to 30 seconds to appear.** The index has a
  thirty-second TTL. Your own claim appears instantly, drawn optimistically.
- **A chunk body is cached for a year.** Its URL contains its version, so any
  write produces a new URL. The dev server strips those headers, because a dev
  database happily reuses version 1 with different contents.
- **A moderated claim keeps its cells and its prices.** Hiding is not a refund.
- **The Worker does not use the Stripe SDK.** `nodejs_compat` is off on purpose;
  see the comment at the top of `worker/wall/stripe.ts`.
