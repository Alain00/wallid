#!/usr/bin/env bun
/**
 * How busy the wall is. `bun run pulse`.
 *
 * The reading half of `worker/wall/pulse.ts`. Analytics Engine is written from
 * the edge and read over an HTTP SQL endpoint, so this is a script rather than
 * a route: putting it behind `/wall/*` would mean an account-scoped API token
 * in the Worker's secrets and a read quota anybody could spend by refreshing.
 *
 * Two windows:
 *
 *   here now      distinct pseudonyms in the last ninety seconds. The page
 *                 beats every thirty, so ninety is three misses before somebody
 *                 is called gone — enough to survive a laptop lid, short enough
 *                 that the number means "now".
 *   last hour     distinct pseudonyms in the last sixty minutes. A visitor is
 *                 counted once however long they stayed.
 *
 * Both are *the wall*, not the site: static pages never wake a Worker, so a
 * visitor who only read the rules is not in here. See `pulse.ts`.
 */

import { ORIGIN } from "../origin";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DATASET = process.env.PULSE_DATASET ?? "wallid_pulse";

if (!ACCOUNT || !TOKEN) {
  console.error(
    [
      "Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env.",
      "",
      "The token is an account one with Account Analytics: Read — not the",
      "deploy token. Create it at",
      "https://dash.cloudflare.com/profile/api-tokens, and note that it reads",
      "every dataset on the account, which is why it lives in .env rather than",
      "in the Worker.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * One query against the SQL API.
 *
 * Errors come back as a 200 with an error body about as often as they come back
 * as a status, so both are checked. The body is `application/json` only when
 * `FORMAT JSON` is asked for.
 */
async function sql<Row>(query: string): Promise<Row[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: query,
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Analytics Engine said ${response.status}: ${text.trim()}`);
  }

  try {
    return (JSON.parse(text) as { data: Row[] }).data;
  } catch {
    throw new Error(`Analytics Engine returned something that is not JSON: ${text.trim()}`);
  }
}

/**
 * `count(DISTINCT blob1)` is the visitor count and `sum(_sample_interval)` the
 * heartbeat count.
 *
 * The second is not `count(*)`: once a dataset is busy enough to be sampled,
 * every stored row stands for `_sample_interval` real ones, and summing that
 * column is how the true total comes back. The distinct count cannot be
 * corrected the same way and will read low under sampling — which at this
 * wall's volume is hypothetical, and worth knowing before it is not.
 */
const recent = (seconds: number) => `
  SELECT
    count(DISTINCT blob1) AS visitors,
    sum(_sample_interval) AS beats
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '${seconds}' SECOND
  FORMAT JSON
`;

const countries = `
  SELECT blob2 AS country, count(DISTINCT blob1) AS visitors
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '3600' SECOND AND blob2 != ''
  GROUP BY country
  ORDER BY visitors DESC
  LIMIT 8
  FORMAT JSON
`;

type Window = { visitors: number; beats: number };
type Country = { country: string; visitors: number };

const [now, hour, places] = await Promise.all([
  sql<Window>(recent(90)),
  sql<Window>(recent(3600)),
  sql<Country>(countries),
]);

const number = (value: number | undefined) => Math.round(Number(value ?? 0)).toLocaleString();

/**
 * The total, from the wall rather than from here.
 *
 * Deliberately not recomputed out of Analytics Engine: it only holds three
 * months, so a sum taken here would quietly mean "since May" and disagree with
 * the number on the page. The authoritative figure is the `visit_days` table
 * the hourly rollup fills, and `/wall/pulse` is how anything reads it.
 *
 * A failure prints nothing rather than a zero — the site being unreachable is
 * not the wall having no visitors.
 */
const sinceLaunch = async (): Promise<number | null> => {
  try {
    const response = await fetch(`${ORIGIN}/wall/pulse`);
    if (!response.ok) return null;
    const body = (await response.json()) as { visits?: number | null };
    return typeof body.visits === "number" ? body.visits : null;
  } catch {
    return null;
  }
};

const total = await sinceLaunch();

console.log(`  here now    ${number(now[0]?.visitors)}`);
console.log(`  last hour   ${number(hour[0]?.visitors)}`);
console.log(`  heartbeats  ${number(hour[0]?.beats)}  (last hour)`);
if (total !== null) console.log(`  all time    ${number(total)}  visits since launch`);

if (places.length) {
  console.log("");
  for (const place of places) {
    console.log(`  ${place.country.padEnd(11)} ${number(place.visitors)}`);
  }
}
