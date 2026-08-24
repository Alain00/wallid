/**
 * The artwork on a claim: an upload, or a favicon fetched from the buyer's own
 * site.
 *
 * The favicon path is the one that matters. A buyer arriving at this wall has a
 * URL and no design intent — asking them for a square PNG is asking them to
 * open an image editor before they can spend a dollar, and most of them will
 * not. Pasting a domain and watching their own mark appear in the cell is the
 * whole of the onboarding, and the upload is what they reach for afterwards
 * when the favicon turns out to be a 16px blur.
 */

/** What a claim's artwork may be, in bytes. Shared with the browser that has to
 * encode under it; see `src/wall/limits.ts`. */
export { MAX_BYTES } from "../../src/wall/limits";

import { MAX_BYTES } from "../../src/wall/limits";

/**
 * What may be *fetched* from a buyer's site, which is not the same number.
 *
 * A favicon is a few KB and a social preview is a 1200x630 photograph, so the
 * storage limit would refuse the og:image path outright — and refusing it for
 * being big is refusing it for being what it is. Anything over `MAX_BYTES`
 * comes back oversized and goes to the browser to be redrawn at tile size, the
 * same round trip an SVG takes; only the result of that is stored. So the
 * bucket's limit is untouched, and this one only bounds what a stranger's
 * server can make this Worker hold for a moment.
 */
export const MAX_FETCH_BYTES = 1024 * 1024;

/**
 * The types accepted, and the two that are missing.
 *
 * No SVG: it is a document, it can carry script and external references, and
 * serving one from our own origin next to a payment flow is a stored-XSS
 * surface for the sake of a file format. Buyers who have only an SVG have to
 * rasterise it themselves and upload the result.
 *
 * A Worker cannot rasterise — no canvas, no DOM, no image decoder — so for a
 * while a site whose only declared icon was an SVG got "could not find an icon
 * on that site" and no way forward. `blobatar.dev` is exactly that site: one
 * `image/svg+xml` icon, no `/favicon.ico`.
 *
 * The buyer's browser has all three. So an SVG is now fetched, handed back to
 * the panel as bytes rather than stored, drawn there into a canvas, and
 * uploaded as the PNG that comes out — see `sniffVector` below and
 * `src/wall/raster.ts`. Nothing in the bucket changes: R2 still holds only what
 * `sniff` accepts, and this list is still the whole of what the wall serves.
 *
 * No GIF, because animation is the thing that turns a wall of logos into a
 * casino, and refusing the container is more honest than accepting it and
 * flattening to frame one.
 */
export const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"];

/** The sniffed type of a buffer, or `null` if it is not one we take. Sniffed
 * rather than trusted, because `Content-Type` on an upload is whatever the
 * client felt like sending and a favicon's is whatever the remote host felt
 * like sending. */
export function sniff(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x01 && at(3) === 0x00) return "image/x-icon";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * SVG, and only SVG — the one format that is not stored but *is* accepted on
 * the way in, because the buyer's browser can turn it into one that is.
 *
 * Deliberately separate from `sniff` rather than another branch inside it.
 * `sniff` answers "may these bytes go in the bucket", and its answer for SVG
 * must stay no; this answers "can the panel make something of these bytes",
 * which is a different question asked in one place.
 *
 * A prefix match on `<svg`, after any XML declaration, comments, or doctype —
 * an SVG in the wild often opens with `<?xml` and rarely with the element
 * itself. Only the first kilobyte is examined: a file that has not reached its
 * root element by then is not one the panel should be trying to draw.
 */
export function sniffVector(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
  // `fatal: false`, so a byte sequence that is not text at all decodes to
  // replacement characters and simply fails to match, rather than throwing.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 1024)).trimStart();
  if (!head.startsWith("<")) return null;
  // `[\s/>]` rather than `[\s>]`: a hand-written `<svg/>` is legal and would
  // otherwise be read as an element merely *starting* with those three letters.
  return /^(<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s)*<svg[\s/>]/i.test(head)
    ? "image/svg+xml"
    : null;
}

/**
 * A URL a buyer typed, as a URL this wall will link to, or `null`.
 *
 * Every outbound link on this wall goes through here. `https` only — a wall
 * that takes money and then sends its visitors somewhere over plaintext has
 * chosen the wrong side of that trade — and no credentials in the authority,
 * because `https://paypal.com@evil.example` is a phishing link that reads as a
 * real one at a glance, which is exactly the glance a wall of logos gets.
 *
 * A bare `example.com` is upgraded rather than refused: that is what people
 * type, and refusing it teaches them to prefix rather than teaching them
 * anything worth knowing.
 */
export function normaliseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 500) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  // Anything that resolves inside the network the Worker runs in. The favicon
  // fetch below follows this URL from *our* side, so an unfiltered hostname is
  // a request forgery primitive rather than a broken link.
  if (isPrivateHost(url.hostname)) return null;

  url.hash = "";
  return url.toString();
}

/**
 * Hostnames the favicon fetch must never resolve.
 *
 * Textual rather than a resolved-address check, which is the honest limitation:
 * a hostname whose DNS points at 127.0.0.1 passes this. Cloudflare Workers do
 * not expose the resolved address before the fetch, so the remaining defence is
 * that a Worker's `fetch` has no privileged network to reach into — there is no
 * metadata endpoint and no internal service on the other side of it. This
 * catches the literal cases, which are the ones anybody actually tries.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return host.startsWith("[") || host.includes(":");
}

/**
 * The best icon a site offers, fetched from our side.
 *
 * Order matters and is not alphabetical: `apple-touch-icon` first because it is
 * specified at 180px and is the only one a site is likely to have drawn rather
 * than shrunk, then any declared `icon` link, then the well-known path. A cell
 * on this wall is drawn at up to 80px and upscaled when somebody zooms, so the
 * difference between the 180px asset and the 16px one is the difference between
 * a logo and a smudge.
 *
 * Everything about this is best-effort: it runs against a stranger's server, on
 * a budget, and a failure is not an error the buyer needs to see. It returns
 * `null` and the interface offers the upload it was going to offer anyway.
 *
 * `type` may be `image/svg+xml`, which the caller must not put in the bucket.
 * Candidate order is unchanged and still does the right thing: an
 * `apple-touch-icon` outscores a vector, and a vector outscores the 16px
 * `/favicon.ico` that gets appended last — which is the trade worth making,
 * since a vector rasterises to any size cleanly and a 16px ico never will.
 */
export async function fetchFavicon(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; type: string; from: string } | null> {
  const site = normaliseUrl(siteUrl);
  if (!site) return null;
  const base = new URL(site);

  const candidates: string[] = [];
  try {
    const page = await fetchImpl(base.toString(), {
      headers: { accept: "text/html", "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (page.ok) {
      // The first 64 KB of the document. Icon links live in `<head>`, and
      // reading a whole page to find them is a stranger deciding how much
      // memory this Worker spends.
      const html = (await page.text()).slice(0, 64 * 1024);
      candidates.push(...iconLinks(html, base));
    }
  } catch {
    // A site that will not answer still has a well-known path worth trying.
  }

  candidates.push(new URL("/favicon.ico", base).toString());

  for (const candidate of candidates.slice(0, 5)) {
    const found = await tryFetchImage(candidate, fetchImpl);
    if (found) return { ...found, from: candidate };
  }
  return null;
}

const USER_AGENT = "wallid.lol favicon fetcher (+https://wallid.lol/about)";

/**
 * `<link rel="...icon...">` hrefs, best first.
 *
 * A regex over HTML, which is the wrong tool in general and the right one here:
 * the Worker has no parser, the input is untrusted and never rendered, and the
 * failure mode of missing a link is falling through to `/favicon.ico`. Sorted
 * by `sizes` so a declared 180px icon beats a declared 16px one.
 */
export function iconLinks(html: string, base: URL): string[] {
  const links: { href: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.includes("icon")) continue;
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (!href) continue;

    const sizes = /\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    const score = (rel.includes("apple-touch") ? 1000 : 0) + (sizes ? Number(sizes) : 32);
    try {
      links.push({ href: new URL(href, base).toString(), score });
    } catch {
      // A malformed href in a stranger's markup is not our problem to report.
    }
  }
  return links.sort((a, b) => b.score - a.score).map(link => link.href);
}

async function tryFetchImage(
  url: string,
  fetchImpl: typeof fetch,
  ceiling = MAX_BYTES,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const safe = normaliseUrl(url);
  if (!safe) return null;
  try {
    const response = await fetchImpl(safe, {
      headers: { accept: "image/*", "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;

    // Checked before reading rather than after: a stranger's server offering a
    // 40MB "favicon" should cost us a header, not a body.
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > ceiling) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > ceiling) return null;

    // A raster is preferred and returned as-is. A vector comes back tagged, for
    // the caller to hand to a browser that can draw it; it is never stored.
    const type = sniff(bytes) ?? sniffVector(bytes);
    return type ? { bytes, type } : null;
  } catch {
    return null;
  }
}

/**
 * An artwork's key in R2: the hash of its bytes.
 *
 * Content-addressed, so the same logo uploaded by the same buyer for their
 * third claim is stored once, and so a key can be served `immutable` — the
 * bytes under a given key cannot change, because the key *is* the bytes. It
 * also means moderation removes an image from every claim using it at once,
 * which for a logo that turned out to be someone else's trademark is the
 * behaviour wanted.
 */
export async function keyFor(bytes: Uint8Array, type: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hash = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : type === "image/png" ? "png" : "ico";
  return `${hash}.${ext}`;
}

/** A key is only ever what `keyFor` produces. Checked before it reaches R2, so
 * a claim row a stranger influenced cannot become a path traversal. */
export const looksLikeKey = (value: string) => /^[0-9a-f]{32}\.(png|jpg|webp|ico)$/.test(value);

/**
 * The social preview a site declares, fetched from our side.
 *
 * The other half of "what should this cell look like". A favicon is a mark and
 * a preview is a picture, and which one belongs on the wall is a judgement only
 * the buyer can make: a 6x3 rectangle of a product screenshot says more than a
 * 16px glyph stretched across it, and a 1x1 cell is the other way round. So
 * both are offered and neither is chosen here.
 *
 * `og:image` first, then `twitter:image`, which is the order of how deliberate
 * they are — a site with both has usually set the first on purpose and let a
 * framework fill in the second.
 *
 * Same best-effort contract as `fetchFavicon`: `null` and the panel falls back
 * to what it was already showing.
 */
export async function fetchOgImage(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; type: string; from: string } | null> {
  const site = normaliseUrl(siteUrl);
  if (!site) return null;
  const base = new URL(site);

  let candidates: string[] = [];
  try {
    const page = await fetchImpl(base.toString(), {
      headers: { accept: "text/html", "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (!page.ok) return null;
    candidates = previewImages((await page.text()).slice(0, 64 * 1024), base);
  } catch {
    // Unlike a favicon, there is no well-known path to fall back on: a preview
    // image exists only because the page says so.
    return null;
  }

  for (const candidate of candidates.slice(0, 3)) {
    const found = await tryFetchImage(candidate, fetchImpl, MAX_FETCH_BYTES);
    if (found) return { ...found, from: candidate };
  }
  return null;
}

/**
 * `<meta>` image URLs, best first.
 *
 * A regex again, and the same reasoning as `iconLinks` — but note what this one
 * has to survive that the other did not: `property` and `content` appear in
 * either order, both `property=` and `name=` are used in the wild for og tags,
 * and the quoting is inconsistent. So the attribute is found within the tag
 * rather than by position.
 */
export function previewImages(html: string, base: URL): string[] {
  const found: { href: string; score: number }[] = [];

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (key !== "og:image" && key !== "og:image:url" && key !== "twitter:image") continue;

    const href = /\bcontent\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (!href) continue;

    try {
      found.push({ href: new URL(href, base).toString(), score: key === "twitter:image" ? 0 : 1 });
    } catch {
      // A malformed URL in a stranger's markup is not our problem to report.
    }
  }

  return found.sort((a, b) => b.score - a.score).map(entry => entry.href);
}
