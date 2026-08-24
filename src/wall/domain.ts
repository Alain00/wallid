/**
 * Is what has been typed so far already an address?
 *
 * The buying panel wants to fetch a site's icon while the buyer is still in the
 * field, which means deciding — on every keystroke — whether the half-typed
 * thing in front of it is worth a round trip. `new URL()` cannot answer that:
 * it says yes to `https://a`, and to `acme.c`, and the panel would spend a
 * fetch on every prefix of every domain anybody ever types.
 *
 * So this is deliberately stricter than what the Worker will accept. A false
 * no costs nothing — the field still resolves on blur, exactly as it did before
 * — while a false yes is a wasted fetch and, worse, a "we could not find your
 * icon" under a field somebody has not finished filling in.
 *
 * The check is shape only. Whether the domain exists, resolves, or has an icon
 * is the Worker's business.
 */

/** Letters, so `1.5` and `v1.2` are numbers rather than sites, and at least two
 * of them, so `e.g` and every `name.c` on the way to `name.com` are not. No
 * length ceiling: the long ones are real (`.photography`, `.international`). */
const TLD = /^[a-z]{2,}$/;

/** A hostname label: alphanumerics and inner hyphens. Underscores are legal in
 * DNS and not in hostnames, and a site nobody can visit is not one to fetch. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The hostname the typed text is an address for, or `null` if it is not one
 * yet.
 *
 * Accepts what people actually type into a field labelled "your site":
 * `acme.com`, `www.acme.com`, `https://acme.com/pricing?ref=x`, and the same
 * with a stray space at either end. An IDN comes back punycoded, because that
 * is what `new URL()` makes of it and what a fetch would ask for anyway.
 */
export function domainOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  // Only the two schemes a browser would follow. `mailto:` and `data:` parse
  // perfectly well and are not sites. The lookahead is what keeps a port —
  // `acme.com:8080` — from reading as a scheme called `acme.com`.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return null;

  let host: string;
  try {
    host = new URL(scheme ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }

  // What `new URL()` hands back for an IPv6 literal. Not a domain, and not
  // something anyone types into this field by accident.
  if (host.startsWith("[")) return null;

  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!TLD.test(labels.at(-1)!)) return null;
  if (!labels.every(label => LABEL.test(label))) return null;

  return host;
}

/**
 * What to write in the name field for a domain, when the buyer has not written
 * something better themselves.
 *
 * `www` is a prefix, not a name; the rest of the host is kept, because
 * `blog.acme.com` and `acme.com` are different tenants of this wall.
 */
export function nameOf(host: string, max: number): string {
  return [...host.replace(/^www\./, "")].slice(0, max).join("");
}
