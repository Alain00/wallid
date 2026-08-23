/**
 * Turnstile, and the decision to fail closed.
 *
 * An IP limit alone does not stop anything determined — a day's cooldown across
 * a few hundred addresses is a few hundred cells, and the wall is permanent. So
 * the write path is guarded, and the guard is Cloudflare's own because the site
 * is already on Cloudflare and a second vendor for one checkbox is not a trade
 * worth making.
 *
 * There is no bypass. A deployment with no secret configured refuses writes
 * rather than accepting them, which is the only safe direction for a switch
 * whose off state is "anyone may write to the permanent wall": the failure mode
 * of failing closed is a broken feature somebody notices in a minute, and the
 * failure mode of failing open is a wall full of slurs. Local development uses
 * Cloudflare's documented always-passes test pair in `.dev.vars`, so the code
 * path under test is the real one.
 */

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's documented test secret, which accepts any token. It is in this
 * file only so that `.dev.vars` can be a copy-paste and never a "just skip the
 * check while I work". */
export const TEST_SECRET = "1x0000000000000000000000000000000AA";

export async function verifyTurnstile(
  token: unknown,
  secret: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!secret) return false;
  if (typeof token !== "string" || !token || token.length > 2048) return false;

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  // Cloudflare cross-checks the address the token was issued to. It is optional
  // in the API and not optional here: without it a token solved once can be
  // replayed from anywhere.
  body.append("remoteip", ip);

  try {
    const response = await fetch(VERIFY, { method: "POST", body });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    // The verifier being unreachable is the one case where failing closed costs
    // a real visitor their placement, and it is still the right answer: a
    // network blip refuses a write that can be retried, where the alternative
    // is an open door for exactly as long as the blip lasts.
    return false;
  }
}
