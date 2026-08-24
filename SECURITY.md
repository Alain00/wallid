# Reporting a vulnerability

Mail **support@wallid.lol** — or open a private advisory through GitHub's
*Security → Report a vulnerability*, which does not make the report public
while it is being fixed. Please do not open a normal issue for anything that
would let somebody take a cell they did not pay for, read what another buyer
sent, or use this Worker to reach a host they cannot reach themselves.

There is no bounty. There is an answer within a few days.

## What is in scope, and where it lives

This is a Worker that takes card payments and fetches URLs strangers type, so
those are the two places worth looking:

- **The settle path.** `worker/wall/stripe.ts` verifies the webhook signature
  itself with WebCrypto rather than the Stripe SDK, and `worker/wall/index.ts`
  applies the claim. A way to make the wall record a claim without a paid
  Stripe session — a forged signature, a replayed event, a race between two
  buyers of the same rectangle — is the highest-severity thing here.
- **Outbound fetches.** The Worker resolves a favicon from a URL a buyer typed,
  which is a request-forgery primitive if the gate leaks. That gate is
  `normaliseUrl` in `worker/wall/artwork.ts`, and
  [ADR 0002](docs/adr/0002-artwork-is-a-favicon-first.md) explains what it is
  meant to stop. A URL that gets past it to a private address, a redirect chain
  that ends somewhere it should not, or a response that is stored as artwork
  without being an image, are all in scope.

Also in scope: owner-token forgery (`worker/wall/identity.ts`), anything that
serves attacker-controlled markup off this origin, and the moderation routes
behind `WALL_ADMIN_TOKEN`.

## What is not

- **God mode.** `src/wall/god.ts` places claims without paying, and it exists
  only in the development server. `wrangler.jsonc` points `main` at
  `worker/index.ts`, which has no such routes, and `AVAILABLE` compiles to a
  literal `false` in a production build. Finding it in the source is not a
  finding; finding it reachable on a deployed Worker very much is.
- **The pricing.** That a cell costs 20% more than the last person paid, and
  that there are exactly 16,384 of them, are decisions rather than bugs — see
  [ADR 0001](docs/adr/0001-the-wall-is-bounded-and-priced-per-cell.md).
- Reports produced by a scanner with no working request behind them, missing
  headers with no exploit attached, and anything requiring an attacker to
  already hold the account's Cloudflare or Stripe credentials.

## If you are running your own

Nothing secret is in this repo, and nothing secret should end up in it. Worker
secrets go through `wrangler secret put`; `.dev.vars` and `.env` are
gitignored, and `.dev.vars.example` / `.env.example` say which of the two each
value belongs in and why. `WALL_SECRET` is the pepper behind every owner token
— rotating it orphans every existing owner, which is the point of rotating it.
