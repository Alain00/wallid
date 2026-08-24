import type { Rect } from "./geometry";

/**
 * God mode: place and remove claims without paying for them.
 *
 * A wall is only worth looking at with things on it, and until now the only way
 * to put a thing on it was a Stripe redirect and a card. That made every
 * question about how the *board* looks — a crowded chunk, a takeover, sixteen
 * logos at four zoom levels — cost a payment flow to ask.
 *
 * Two halves, and the split is the safety:
 *
 *   - The routes live in `server.ts`, which is the development server. It is
 *     not bundled and it is not deployed; `wrangler.jsonc` points `main` at
 *     `worker/index.ts`, which has never heard of them. There is no flag that
 *     turns free cells on in production, because there is no code there to
 *     turn on.
 *   - This file is compiled into the client, so it is gated on the build:
 *     `process.env.NODE_ENV` is replaced with the literal `"production"` by
 *     `build.ts`, so `AVAILABLE` is a constant `false` in a shipped bundle and
 *     every branch behind it is dead code the bundler removes.
 *
 * The toggle on top of that is a convenience, not a control: it keeps the
 * development wall behaving like the real one until you ask it not to, so the
 * ordinary buying flow is still what you see by default.
 */

/** Whether god mode can exist at all in this build. A literal `false` in
 * production — see above. */
export const AVAILABLE = process.env.NODE_ENV !== "production";

const KEY = "wallid:god";

/** `localStorage`, so it survives the reload that follows most of what god mode
 * is used for, and so two tabs can disagree about it. */
export function enabled(): boolean {
  if (!AVAILABLE) return false;
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    // Private mode, or storage turned off. Not being able to remember the
    // toggle is not a reason to fail.
    return false;
  }
}

export function enable(on: boolean) {
  if (!AVAILABLE) return;
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // As above: the toggle still works for this page, it just will not be
    // there after a reload.
  }
}

export type Placed = { claimId: string; totalCents: number; prices: number[] };

/**
 * Place a claim, priced as the wall prices it.
 *
 * The same body the checkout route takes, minus everything about money and
 * humanity: no Turnstile token, no email, no Stripe session. The server still
 * runs the real quote, the real insert and the real settle, so what lands on
 * the wall is what a paid claim would have been.
 */
export async function place(
  body: { rect: Rect; label: string; url: string; image: string | null; imageSource?: string },
  base = "",
): Promise<Placed | { error: string }> {
  try {
    const response = await fetch(`${base}/wall/dev/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body.rect, ...body, rect: undefined }),
    });
    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !result) return { error: String(result?.error ?? "god mode is not running") };
    return {
      claimId: String(result.claimId),
      totalCents: Number(result.totalCents),
      prices: (result.prices as number[]) ?? [],
    };
  } catch {
    return { error: "could not reach the wall" };
  }
}

/** Free a rectangle, or — with `"all"` — the whole wall. */
export async function free(what: Rect | "all", base = ""): Promise<number | "all" | null> {
  try {
    const response = await fetch(`${base}/wall/dev/free`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(what === "all" ? { all: true } : what),
    });
    if (!response.ok) return null;
    const result = (await response.json()) as { freed?: number | "all" };
    return result.freed ?? null;
  } catch {
    return null;
  }
}
