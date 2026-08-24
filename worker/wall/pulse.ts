/**
 * How busy the wall is, without following anybody around it.
 *
 * Two numbers are wanted: how many people arrived in the last hour, and how
 * many are at the wall right now. Both are usually bought with a third-party
 * beacon, and this file exists because that purchase is worse than it looks
 * here — a script tag contradicts `Privacy.tsx`, ad blockers eat a share of the
 * traffic on a domain like this one, and none of it is needed, because the wall
 * *already* has a heartbeat: `Wall.tsx` re-reads `/wall/i` every thirty seconds
 * for as long as the tab is visible, and that request is already billed. So the
 * measurement rides along on a request that was happening anyway.
 *
 * That has one consequence worth stating plainly, because it is a real limit
 * rather than a rounding error: this counts *the wall*, not the site. `/rules`
 * and `/about` are served by Cloudflare's asset pipeline without ever waking a
 * Worker — which is the arrangement `wrangler.jsonc` is built around — so a
 * visitor who reads the rules and leaves is invisible here. Counting them would
 * mean either a client script or making static pages billable, and neither is
 * worth what it costs.
 *
 * What is written is one row per heartbeat, carrying a pseudonym and nothing
 * else about the person. Analytics Engine keeps rows for three months and the
 * write is free at this volume; the reading is `scripts/pulse.ts`.
 */

import { addressOf } from "./identity";

/**
 * Structural, like the D1 and R2 shims elsewhere in this directory, and for the
 * same reason: this is the whole of Analytics Engine the wall touches. Note
 * that `writeDataPoint` returns nothing and does not throw — the platform
 * queues it outside the request's lifetime, which is why nothing below needs
 * `waitUntil` for the write itself.
 */
export type AnalyticsEngineDataset = {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
};

const encoder = new TextEncoder();

/**
 * A local SHA-256, rather than the one in `identity.ts`.
 *
 * The duplication is deliberate and is about six lines. `identity.ts` hashes
 * owner tokens — the credential that proves a claim is yours — and this file
 * hashes IP addresses for a counter. Keeping them apart means no future edit to
 * a metrics pseudonym can reach into the code path that authenticates money,
 * and no import here can be mistaken for this file being allowed near tokens.
 */
const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

/** The UTC day a timestamp falls in. The rotation below turns on this. */
const dayOf = (nowMs: number) => Math.floor(nowMs / 86_400_000);

/**
 * Who this is, for counting purposes only.
 *
 * A keyed hash of the address and user agent, and — the part that matters — of
 * the UTC day, so the pseudonym a visitor is counted under changes at midnight
 * and cannot be joined across days into a history of somebody. It is peppered
 * with `WALL_SECRET`, so the stored value is not a rainbow table away from the
 * IP that produced it, and truncated to sixteen hex characters: 64 bits, which
 * is far past collision on a wall this size and keeps the row small.
 *
 * The user agent is folded in because two people behind one office NAT are two
 * visitors, and an address alone would call them one. It is not stored.
 */
export const pseudonym = async (
  secret: string,
  address: string,
  agent: string,
  nowMs: number,
): Promise<string> =>
  (await sha256(`${secret}:pulse:${dayOf(nowMs)}:${address}:${agent}`)).slice(0, 16);

/** The dataset binding, if this deployment has one. Optional throughout: the
 * dev server has no Analytics Engine and must still serve the wall. */
export type PulseEnv = { PULSE?: AnalyticsEngineDataset; WALL_SECRET: string };

/**
 * Record one heartbeat.
 *
 * Returns a promise because the pseudonym is a hash, and the caller hands it to
 * `waitUntil` rather than awaiting it — a metric must never be in front of a
 * response the wall is trying to paint. A request with no address (which is
 * every request in local development) is not counted rather than counted as an
 * anonymous everybody: one bucket that every uncounted visitor falls into would
 * read as a single very busy person.
 *
 * The pseudonym is written twice, as `index1` and as `blob1`. Analytics Engine
 * samples by index once volume is high, so indexing on the visitor is what
 * keeps "how many distinct people" from collapsing under sampling; the blob is
 * what `count(DISTINCT ...)` reads, because the index column is not meant to be
 * aggregated over.
 */
export function beat(request: Request, env: PulseEnv, nowMs: number): Promise<void> {
  const dataset = env.PULSE;
  if (!dataset) return Promise.resolve();

  const address = addressOf(request);
  if (!address) return Promise.resolve();

  const agent = request.headers.get("User-Agent") ?? "";
  // Cloudflare puts the country on the request itself, so a coarse "where from"
  // costs nothing extra and never touches a geo-IP service.
  const country = (request as { cf?: { country?: string } }).cf?.country ?? "";

  return pseudonym(env.WALL_SECRET, address, agent, nowMs).then(visitor => {
    dataset.writeDataPoint({
      indexes: [visitor],
      blobs: [visitor, country],
      // A count, so `sum(_sample_interval)` reconstructs the true number of
      // heartbeats after sampling. Sampling is why this is not `count(*)`.
      doubles: [1],
    });
  });
}

/**
 * The reading half, for the site rather than for the terminal.
 *
 * `scripts/pulse.ts` asks the same question from a laptop with an account-wide
 * token in `.env`; this asks it from the Worker so the wall can show the answer
 * to the people making it. The two are deliberately not one file — the script
 * reads every dataset on the account and prints four numbers, this reads one
 * number and hands it to strangers — but they are the same SQL, and if the
 * shape of a row ever changes they both break in the same way.
 */

/**
 * The credentials for a read, all optional.
 *
 * Optional because every deployment before this one had none, and because the
 * dev server has neither an Analytics Engine nor an account token: a wall that
 * cannot count is a wall that shows no counter, not a wall that 500s.
 *
 * The token is an account token with `Account Analytics: Read` and it is a
 * Worker *secret* — `wrangler secret put PULSE_READ_TOKEN` — never a var in
 * `wrangler.jsonc`, because it can read every Analytics Engine dataset on the
 * account and that file is in the repo.
 */
export type PulseReadEnv = {
  PULSE_ACCOUNT_ID?: string;
  PULSE_READ_TOKEN?: string;
  PULSE_DATASET?: string;
};

/**
 * How long ago a heartbeat can be and still count as "now".
 *
 * Three misses at the page's thirty-second beat. Enough to survive a closed lid
 * or a tunnel, short enough that the number still means the present tense — and
 * the same window `scripts/pulse.ts` prints, so the chip on the wall and the
 * line in the terminal never disagree about who is here.
 */
export const HERE_SECONDS = 90;

/** Dataset names go into SQL by concatenation, so this is the whole defence:
 * an identifier or nothing. It comes from our own config rather than from a
 * request, which makes this cheap insurance rather than the thing standing
 * between the wall and an injected query. */
const NAME = /^[A-Za-z0-9_]+$/;

/**
 * How many people are at the wall right now, or `null` if the deployment
 * cannot say.
 *
 * `null` rather than 0 throughout, and the distinction is the whole contract:
 * zero is a wall nobody is looking at, which is a true and useful thing to
 * render, and `null` is a wall that does not know — no token, a refused read, a
 * slow API — which must render as nothing at all. Collapsing the two would put
 * "0 here now" on the page every time Cloudflare's analytics API had a bad
 * minute, which is a lie told to the one visitor who is definitely there.
 *
 * Nothing here throws. This is decoration on a request that matters, and the
 * failure mode of a decoration is to be absent.
 */
export async function here(
  env: PulseReadEnv,
  fetcher: typeof fetch = fetch,
  seconds = HERE_SECONDS,
): Promise<number | null> {
  const account = env.PULSE_ACCOUNT_ID;
  const token = env.PULSE_READ_TOKEN;
  const dataset = env.PULSE_DATASET ?? "wallid_pulse";
  if (!account || !token || !NAME.test(dataset)) return null;

  const query = `
    SELECT count(DISTINCT blob1) AS here
    FROM ${dataset}
    WHERE timestamp > NOW() - INTERVAL '${Math.floor(seconds)}' SECOND
    FORMAT JSON
  `;

  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: query,
        // A budget, not a guess. This read sits in front of a response, and an
        // analytics API having a slow afternoon must not become the wall having
        // one.
        signal: AbortSignal.timeout(2_500),
      },
    );
    if (!response.ok) return null;

    // Errors arrive as a 200 with an error body about as often as they arrive
    // as a status, so the parse is where most failures are actually caught.
    const body = (await response.json()) as { data?: { here?: number | string }[] };
    const value = Number(body.data?.[0]?.here);
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  } catch {
    return null;
  }
}

/**
 * Distinct visitors per day, for the last `days` days.
 *
 * The other half of "visits since launch": Analytics Engine holds three months
 * and the wall wants the whole history, so this is read on a schedule and the
 * answer kept in D1. See `visit_days` in `0002_visits.sql`.
 *
 * The window looks back further than the interval between rollups, deliberately
 * — three days against an hourly cron. A run that fails, a deploy that lands
 * mid-hour, a cron Cloudflare skips: all of them heal on the next run rather
 * than leaving a hole in a cumulative number that nobody would ever notice was
 * short. The cost of the overlap is rewriting two days' rows with the same
 * values they already had.
 *
 * `toStartOfDay` truncates in UTC, which is the same midnight the pseudonym
 * rotates at — so a day here is exactly a day's worth of distinct people, with
 * no visitor split across two rows by a timezone.
 */
export async function visitorsByDay(
  env: PulseReadEnv,
  fetcher: typeof fetch = fetch,
  days = 3,
): Promise<{ day: number; visitors: number }[] | null> {
  const account = env.PULSE_ACCOUNT_ID;
  const token = env.PULSE_READ_TOKEN;
  const dataset = env.PULSE_DATASET ?? "wallid_pulse";
  if (!account || !token || !NAME.test(dataset)) return null;

  const query = `
    SELECT toStartOfDay(timestamp) AS day, count(DISTINCT blob1) AS visitors
    FROM ${dataset}
    WHERE timestamp > NOW() - INTERVAL '${Math.floor(days)}' DAY
    GROUP BY day
    ORDER BY day
    FORMAT JSON
  `;

  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: query,
        // Longer than the live count's budget: nothing is waiting on this. It
        // runs on a cron with a response nobody is holding open.
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;

    const body = (await response.json()) as { data?: { day?: string; visitors?: number | string }[] };
    if (!Array.isArray(body.data)) return null;

    return body.data
      .map(row => {
        // Analytics Engine returns a datetime without a zone; it is UTC, and
        // saying so is the difference between the right day and one off by the
        // reader's own offset.
        const at = Date.parse(`${row.day ?? ""}Z`.replace(" ", "T"));
        const visitors = Number(row.visitors);
        if (!Number.isFinite(at) || !Number.isFinite(visitors)) return null;
        return { day: dayOf(at), visitors: Math.max(0, Math.round(visitors)) };
      })
      .filter((row): row is { day: number; visitors: number } => row !== null);
  } catch {
    return null;
  }
}
