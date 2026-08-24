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

  /**
   * One attempt, with or without the address cross-check.
   *
   * `remoteip` is optional in Cloudflare's API and was not optional here: it is
   * what stops a token solved once from being replayed from anywhere else. The
   * catch is that it compares the address that *solved* the challenge with the
   * address that presents it, and those are not always the same machine's — a
   * browser that solves over IPv6 and reaches the Worker over IPv4, a VPN that
   * rotates, a corporate proxy — and when they differ Cloudflare reports the
   * same `invalid-input-response` it uses for a token that is simply wrong.
   *
   * So the check is made twice when it fails, and the difference between the
   * two answers is the diagnosis: still refused without the address means the
   * token really does not belong to this secret; accepted without it means the
   * addresses disagreed and the visitor is a real person on a normal network.
   */
  const attempt = async (withAddress: boolean) => {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (withAddress) body.append("remoteip", ip);

    const response = await fetch(VERIFY, { method: "POST", body });
    if (!response.ok) return { ok: false, codes: [`http-${response.status}`] };
    const result = (await response.json()) as { success?: unknown; "error-codes"?: string[] };
    return { ok: result.success === true, codes: result["error-codes"] ?? [] };
  };

  try {
    const strict = await attempt(true);
    if (strict.ok) return true;

    const loose = await attempt(false);

    /*
     * Why it failed, in the log.
     *
     * The visitor gets one sentence — "could not verify you are human" — and
     * that is right: the difference between a bad secret and a replayed token
     * is not their problem and telling them would be telling an attacker too.
     * But it is *entirely* the operator's problem, and without this the two are
     * indistinguishable from outside, which turns a mis-pasted key into an
     * afternoon. `observability` is on in `wrangler.jsonc`, so this is one
     * `wrangler tail` away.
     *
     * The codes worth knowing: `invalid-input-secret` is a secret that does not
     * belong to the site key the page is using; `invalid-input-response` is a
     * token that is malformed, or issued for a different site key;
     * `timeout-or-duplicate` is a token already redeemed — which, on the second
     * attempt, means the first one redeemed it and the address check was the
     * only thing standing between this visitor and their cells.
     */
    console.warn(
      "turnstile refused",
      JSON.stringify({ withAddress: strict.codes, withoutAddress: loose.codes, accepted: loose.ok }),
    );

    /*
     * Strict, still.
     *
     * The second attempt is a diagnosis, not a second chance: accepting a token
     * that only verifies without the address check would give up replay
     * protection for every visitor in order to rescue the ones whose network
     * presents two addresses. It was briefly the other way round while this was
     * being chased, and the log is what settled it — the token was failing both
     * ways, so the address was never the problem and the trade was buying
     * nothing.
     */
    return strict.ok;
  } catch {
    // The verifier being unreachable is the one case where failing closed costs
    // a real visitor their placement, and it is still the right answer: a
    // network blip refuses a write that can be retried, where the alternative
    // is an open door for exactly as long as the blip lasts.
    return false;
  }
}
