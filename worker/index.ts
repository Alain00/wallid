import { PREFIX as WALL, artworkRoute, wall, type WallidEnv } from "./wall/index";
import { recordVisitDays } from "./wall/db";
import { visitorsByDay } from "./wall/pulse";

/**
 * wallid.lol, whole.
 *
 * `run_worker_first` in `wrangler.jsonc` limits what reaches this function to
 * `/wall/*` and `/img/*`, so the rest of the site is served by Cloudflare's
 * asset pipeline without a Worker invocation — free and unmetered, where every
 * request through here is billed. The prefix checks below are therefore
 * belt-and-braces rather than the routing itself: if that config were ever
 * widened, the site must still be served by assets rather than 404 out of one
 * of the two handlers.
 */
export default {
  async fetch(
    request: Request,
    env: WallidEnv & { ASSETS: { fetch(request: Request): Promise<Response> } },
    // Handed down so the wall's cache writes need not be awaited on the way
    // out. Optional, because the dev server has no such thing.
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const { pathname } = new URL(request.url);

    const artwork = await artworkRoute(request, env);
    if (artwork) return artwork;

    // `null` is the wall declining a path under its own prefix, which falls
    // through to the site like anything else.
    if (pathname.startsWith(WALL)) {
      const response = await wall(request, env, ctx);
      if (response) return response;
    }

    return env.ASSETS.fetch(request);
  },

  /*
   * The visit rollup, hourly.
   *
   * Analytics Engine keeps rows for three months; the wall wants a number that
   * means "since launch". So the daily figure is copied into D1 while it still
   * exists, and `/wall/pulse` sums the copies. See `0002_visits.sql`.
   *
   * Hourly rather than daily, which is the smallest decision here and the one
   * most likely to be questioned: a cumulative counter that only moves at
   * midnight looks broken on the day somebody is watching it, and the run is a
   * single analytics query and one upsert — 720 of each a month, against a
   * million included reads. Daily would be cheaper by nothing worth having.
   *
   * A deployment with no read token has nothing to roll up and does nothing
   * here, quietly. Failures are not retried: the next run looks three days back
   * and repairs whatever this one missed.
   */
  async scheduled(_event: unknown, env: WallidEnv, ctx?: { waitUntil(p: Promise<unknown>): void }) {
    const work = (async () => {
      const days = await visitorsByDay(env);
      if (days?.length) await recordVisitDays(env.WALLID, days);
    })();
    if (ctx) ctx.waitUntil(work);
    else await work;
  },
};
