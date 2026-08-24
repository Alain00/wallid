#!/usr/bin/env bun
/**
 * Run the visit rollup by hand, into the development database. `bun run rollup`.
 *
 * Production does this hourly on a cron — see `scheduled` in `worker/index.ts`
 * — and development has no cron, so the local wall's visit total is zero
 * forever and the chip that shows it never appears. This is the same query and
 * the same upsert, pointed at `.wrangler/state`.
 *
 * The numbers it writes are real: there is no local Analytics Engine, so the
 * read goes to the production dataset with the credentials in `.dev.vars`. The
 * total on a development wall is therefore the production total, which is the
 * honest option — the alternative is inventing traffic, and a made-up number is
 * worse than an absent one for judging whether the chip reads well.
 */

import { recordVisitDays, visits } from "../worker/wall/db";
import { visitorsByDay } from "../worker/wall/pulse";
import { sqliteD1 } from "../worker/wall/sqlite";

const file = Bun.file(".dev.vars");
const text = (await file.exists()) ? await file.text() : "";
const read = (name: string) =>
  text.match(new RegExp(`^${name}\\s*=\\s*"?([^"\n]*)"?`, "m"))?.[1] || undefined;

const env = {
  PULSE_ACCOUNT_ID: read("PULSE_ACCOUNT_ID"),
  PULSE_READ_TOKEN: read("PULSE_READ_TOKEN"),
  PULSE_DATASET: read("PULSE_DATASET"),
};

if (!env.PULSE_ACCOUNT_ID || !env.PULSE_READ_TOKEN) {
  console.error(
    [
      "Needs PULSE_ACCOUNT_ID and PULSE_READ_TOKEN in .dev.vars.",
      "",
      "The token is an account one with Account Analytics: Read. The same pair",
      "production uses — see `.dev.vars.example`.",
    ].join("\n"),
  );
  process.exit(1);
}

const days = await visitorsByDay(env);
if (!days) {
  console.error("Analytics Engine refused the read. Check the token's permissions.");
  process.exit(1);
}

const db = sqliteD1(".wrangler/state/wallid-dev.sqlite");
await recordVisitDays(db, days);

for (const day of days) {
  console.log(`  ${new Date(day.day * 86_400_000).toISOString().slice(0, 10)}  ${day.visitors}`);
}
console.log(`\n  ${await visits(db)} visits since launch`);
