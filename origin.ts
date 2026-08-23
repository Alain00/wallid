/**
 * Where this site is served from.
 *
 * Four things in the head need an absolute URL and cannot be given one by the
 * bundler: `og:url`, `og:image`, `rel="canonical"` and every `url` inside the
 * JSON-LD. Crawlers refuse to resolve a relative `og:image` against the page
 * they found it on, and a relative canonical is worth nothing to the entity
 * resolution it exists for.
 *
 * Stated once, here, and interpolated wherever a URL is written. A hardcoded
 * default rather than an environment read that can silently go missing in
 * production and leave every card unresolvable.
 *
 * `SITE_URL` still overrides, for a staging host or a preview that wants its
 * own cards. The dev server picks it up too, so a page served from localhost
 * says so in its canonical rather than pointing a crawler at production.
 *
 * The apex rather than `www`, matching the canonical the redirect rule sends
 * traffic to. Both hostnames are custom domains in `wrangler.jsonc`.
 */
/*
 * Guarded on `typeof process` because this module is imported by pages as well
 * as by the build, and in the browser an unguarded read is a ReferenceError on
 * load rather than a build error. The bundler folds the branch away, so the
 * browser gets the literal.
 */
export const ORIGIN =
  (typeof process === "undefined" ? undefined : process.env.SITE_URL) ??
  "https://wallid.lol";

/** A root-relative path, as the absolute URL a crawler can use. */
export const absolute = (path: string) => `${ORIGIN}${path}`;

/** The maintainer, elsewhere. No email on a crawled page. */
export const X_HANDLE = "@alain_0012";
export const X_PROFILE = "https://x.com/alain_0012";
export const GITHUB_PROFILE = "https://github.com/Alain00";

/**
 * Where a buyer goes when something has gone wrong with money.
 *
 * The one place this site does publish an address. A wall that takes payments
 * and offers no route to a human is a chargeback waiting to happen, and the
 * harvester cost of one mailbox is the cheaper side of that trade.
 */
export const SUPPORT_EMAIL = "support@wallid.lol";
