import { useEffect, useState } from "react";

/**
 * How many people are at the wall, said out loud.
 *
 * The wall has always known this — every tab beats against `/wall/i` every
 * thirty seconds and `worker/wall/pulse.ts` writes a row from it — and until
 * now the only way to see it was `bun run pulse` in a terminal. Which is the
 * wrong audience: a number about how busy a place is belongs to the people in
 * it. A wall with four strangers on it is a different proposition from an empty
 * one, and the difference is the whole argument for buying a cell.
 *
 * What it is not: a live-visitor widget with a socket behind it. The count is
 * up to ninety seconds old by construction and edge-cached for thirty on top of
 * that, and that is fine — "roughly this many, right now" is the claim, and it
 * is the honest one.
 */

/**
 * How often to ask.
 *
 * Twice the index's poll, because this is decoration and the wall is not. The
 * server's answer is cached for thirty seconds anyway, so a faster timer would
 * mostly re-read a number that cannot have changed, and a slower one would let
 * an arrival sit unannounced for minutes.
 */
const EVERY_MS = 60_000;

/** `null` is "the wall does not know" — no token, a refused read, a slow
 * analytics API — and renders as nothing at all. Zero is a real answer and
 * renders as one; see `here` in `worker/wall/pulse.ts`. */
type Count = number | null;

/**
 * The two numbers, kept in one piece of state.
 *
 * They arrive in one response and they fail independently — the total is a sum
 * of rows in D1 and survives an analytics API that is refusing to answer — so
 * either can be `null` while the other is a number.
 */
type Reading = { here: Count; visits: Count };

export function Pulse() {
  const [reading, setReading] = useState<Reading>({ here: null, visits: null });

  useEffect(() => {
    let live = true;

    const read = async () => {
      // A hidden tab is a visitor who is not looking. Skipping the read is
      // partly courtesy to the edge and mostly honesty: a laptop asleep with
      // forty tabs open should not be forty people at the wall.
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/wall/pulse");
        if (!response.ok) return;
        const body = (await response.json()) as { here?: number | null; visits?: number | null };
        const number = (value: unknown): Count => (typeof value === "number" ? value : null);
        if (live) setReading({ here: number(body.here), visits: number(body.visits) });
      } catch {
        // Offline, or an analytics API having a bad minute. Keep whatever was
        // last true rather than blanking the chip: a number a minute old is
        // better company than a gap that appears and disappears.
      }
    };

    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    // Coming back to the tab is the moment the old number is most obviously
    // stale, and the moment somebody is most likely to look at it.
    const onVisible = () => void read();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  /*
   * Nothing to show below one, and that is not the same rule as the `null`
   * above.
   *
   * `null` is the wall not knowing. Zero is the wall saying nobody is here — to
   * somebody who is manifestly here, reading it. The count can honestly be zero
   * for up to ninety seconds after a visitor lands, and it is permanently zero
   * for anyone whose request arrives without an address, so "0 people here" is a
   * sentence the reader can always disprove by existing. It stays out of the
   * API, where zero is a real answer worth telling the truth about, and out of
   * the corner of the page, where it only ever reads as broken.
   *
   * The total has no such problem — a wall with no visits yet is a wall that
   * genuinely has none — but it is held to the same floor for the same reason:
   * the person reading it is one, and it will say so within the hour.
   */
  const live = reading.here !== null && reading.here >= 1 ? reading.here : null;
  const total = reading.visits !== null && reading.visits >= 1 ? reading.visits : null;
  if (live === null && total === null) return null;

  return (
    <span
      /* Live, because the number changes underneath a reader who is not looking
         at it. Polite rather than assertive: it is worth noticing on the next
         glance, not worth interrupting anything for. */
      aria-live="polite"
      /* Matching `Chip` in `App.tsx`, including the part that matters on a
         phone: `nowrap`, or "4 visits" becomes two lines in a squeezed row. */
      className="border-line/70 bg-ground/70 text-ink/80 flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap lowercase backdrop-blur sm:px-4 sm:py-2"
    >
      {/* The dot does the work the word "now" would otherwise have to do, and
          does it without a word. It breathes rather than blinks — see
          `.pulse-dot` in `styles.css`. Only beside the live number: on a total
          it would be claiming something is happening that is not. */}
      {live !== null && (
        <span aria-hidden="true" className="pulse-dot bg-ink/70 size-1.5 rounded-full" />
      )}
      {live !== null && <span>{live.toLocaleString()} here now</span>}
      {/* The separator belongs to the second number, so it cannot be left
          hanging when the first one is absent. Dimmer than either, because it
          is punctuation and the numbers are the point. */}
      {total !== null && (
        <span className="text-muted">
          {live !== null && <span className="mr-2 opacity-60">·</span>}
          {total.toLocaleString()} visits
        </span>
      )}
    </span>
  );
}
