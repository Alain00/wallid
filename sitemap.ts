/**
 * `/sitemap.xml`, from the manifest.
 *
 * `robots.txt` used to carry a comment arguing against having one: a sitemap
 * helps a crawler find URLs it would not reach by following links, and there
 * were two pages here that linked to each other. That reasoning was sound and
 * stopped being true — there are six indexable pages now, and the ones a
 * machine most needs (`/docs`, `/privacy`) are the furthest from the entry
 * point.
 *
 * Generated from `PAGES` for the same reason every other file here is: a
 * hand-written list of URLs is a list that goes stale on the next page added,
 * silently, in the one artifact whose entire job is to be complete.
 *
 * `lastmod` is the repository's own last commit, the same value for every URL,
 * rather than a per-page timestamp. Per-page would be a lie in both directions:
 * the stylesheet and the bundle are inlined into every document, so a change to
 * either genuinely changes every page, while the file a page's markup lives in
 * can sit untouched through a rewrite of the component it renders. One honest
 * "this deployment is from" beats six confident wrong dates. Omitted entirely
 * if git is not there — a missing `lastmod` is valid, a fabricated one is not.
 */
import { $ } from "bun";
import { PAGES } from "./manifest";
import { absolute } from "./origin";

export const SITEMAP_PATH = new URL("./public/sitemap.xml", import.meta.url).pathname;

async function lastCommit(): Promise<string | null> {
  try {
    const iso = (await $`git log -1 --format=%cI`.quiet().text()).trim();
    // `%cI` is already ISO 8601 with an offset, which is what the sitemap
    // protocol takes. Checked rather than trusted: an empty repository prints
    // nothing and would otherwise produce `<lastmod></lastmod>`.
    return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso : null;
  } catch {
    return null;
  }
}

export async function sitemap(): Promise<string> {
  const lastmod = await lastCommit();
  const urls = PAGES.filter(page => page.indexable !== false).map(page =>
    [
      "  <url>",
      `    <loc>${absolute(page.route)}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      "  </url>",
    ].join("\n"),
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export async function writeSitemap() {
  await Bun.write(SITEMAP_PATH, await sitemap());
}
