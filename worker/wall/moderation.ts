/**
 * What a name is allowed to be.
 *
 * Free text on a public wall on our own domain, in a public MIT repo with 38
 * forks, will attract slurs within a week. ADR 0011 treats this as ship-blocking
 * rather than as follow-up, so it runs before anything else the write path does
 * — before Turnstile, before D1, before the cell is even looked at.
 *
 * Three layers, each catching what the last cannot:
 *
 *  - a **length cap**, which is also a layout constraint;
 *  - a **charset**, which is the layer that actually does the work: letters,
 *    marks, digits and four punctuation marks, so there is no markup, no
 *    control character, no bidi override and no zero-width anything to smuggle;
 *  - a **blocklist**, for words that are made of perfectly ordinary letters.
 *
 * And behind all three, the authenticated delete in `index.ts` — because a
 * blocklist is a filter, not a guarantee, and pretending otherwise is how one
 * ends up with no delete endpoint.
 */

/**
 * The cap comes from `src/wall/limits.ts`, which the field also reads.
 *
 * Shared rather than duplicated: a Worker that refused at 24 while the input
 * accepted 32 would take a name, let somebody finish typing it, and then refuse
 * it — the interface promising something the rules were never going to allow.
 *
 * Measured below with the spread operator rather than `.length`, which counts
 * UTF-16 units and would let an emoji-heavy name be half as long as it claims —
 * though the charset already refuses those.
 */
export { MAX_NAME } from "../../src/wall/limits";

import { MAX_NAME } from "../../src/wall/limits";

/**
 * Letters, marks, digits, and `' - . ` plus spaces between them.
 *
 * Unicode-aware on purpose: a wall that refuses "José" or "Bùi" while accepting
 * "xXx" is not restricted, it is parochial. Marks are separate from letters in
 * Unicode and a name in Devanagari or Arabic is mostly marks, so `\p{M}` is
 * load-bearing rather than a leftover.
 *
 * What it excludes is everything with a second meaning somewhere downstream:
 * `<` and `&` (markup), `:` and `/` (URLs — names render as text, never as
 * links), and the whole of `\p{C}`, which is where bidi overrides and
 * zero-width joiners live. A name cannot start or end with punctuation, so
 * "..." is not a name and neither is a run of spaces.
 */
const SHAPE = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} '.\-]*[\p{L}\p{M}\p{N}])?$/u;

/** No double spaces, which is the one thing `SHAPE` permits that reads as an
 * attempt to draw with whitespace. */
const RUNS = /[ '.\-]{3,}| {2,}/u;

/**
 * The base blocklist is deliberately tiny, and the real one is not in this
 * repo.
 *
 * A word list in a public repository is a word list every fork inherits, every
 * search engine indexes, and nobody can update without a deploy. `WALL_BLOCKLIST`
 * — a comma-separated list in the Worker's secrets, beside the Turnstile key —
 * is the one that grows. What is left here is the handful of terms that are
 * unambiguous in any deployment, so a fork that sets no secret is not wide open.
 */
const BASE = ["nigger", "faggot", "retard", "tranny", "kike", "chink", "rapist", "hitler"];

/**
 * A name, reduced to the letters somebody actually meant.
 *
 * `n i g g e r`, `n1gg3r`, `nïggér` and `niiiiigger` are one word wearing four
 * costumes, and a blocklist that matches only the plain spelling catches none
 * of them. So: decompose and drop the marks, fold the digits that stand in for
 * letters, throw away everything that is not a letter, and collapse runs.
 *
 * The reduction is lossy on purpose and the matching below is substring-based,
 * which means false positives exist — the Scunthorpe problem is not solved
 * here and cannot be. That trade is deliberate in this direction: a person
 * refused a name can pick another, and the delete endpoint is what catches the
 * misses in the other direction.
 */
export function fold(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0@]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[^\p{L}]/gu, "")
    .replace(/(.)\1+/gu, "$1");
}

/** The blocklist, folded once per request rather than per term comparison. */
const termsOf = (extra?: string) =>
  [...BASE, ...(extra ?? "").split(",")]
    .map(term => fold(term))
    .filter(term => term.length > 2);

export type Refusal = "empty" | "long" | "charset" | "blocked";

/**
 * A label, accepted or refused with a sentence.
 *
 * A sentence rather than a code, because every refusal on this path happens
 * while somebody is trying to give us money and "invalid input" is the worst
 * thing to show them at that moment.
 *
 * Returns the *trimmed* label rather than mutating in place. What gets stored
 * and what was typed must be the same string in every other respect: this is
 * the name that will be drawn on a cell somebody paid for, and a server that
 * silently rewrites it is a server that sold them something else.
 */
export function checkLabel(
  raw: unknown,
  blocklist?: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "a name is needed" };
  const value = raw.trim();
  if (!value) return { ok: false, reason: "a name is needed" };
  if ([...value].length > MAX_NAME)
    return { ok: false, reason: `${MAX_NAME} characters at most` };
  if (!SHAPE.test(value) || RUNS.test(value))
    return { ok: false, reason: "letters, numbers and ordinary punctuation only" };

  const folded = fold(value);
  if (termsOf(blocklist).some(term => folded.includes(term)))
    return { ok: false, reason: "that name cannot go on the wall" };
  return { ok: true, value };
}
