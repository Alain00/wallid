/**
 * Who bought this, without knowing who bought this.
 *
 * Two identities, and the split is the point. The cookie token is the durable
 * one: it is how "what do I own" survives a cleared browser or a second device,
 * and it is what a takeover notification is addressed to. The email address is
 * optional, given only to be told when somebody takes your cells, and it is the
 * one piece of real identity this wall stores at all.
 *
 * Note what is *not* here: no address hash, no daily quota. On a wall where
 * every claim is paid for, money is the rate limit, and an IP cooldown on top
 * of it would only punish an office that shares one.
 */

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

/**
 * A fresh token. 32 bytes of CSPRNG — this is the only thing a buyer holds that
 * proves a claim is theirs.
 */
export const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);

/**
 * Tokens are stored hashed, so a leaked database is not a pile of working
 * credentials. Unsalted SHA-256 would be wrong for a password and is right
 * here: the input is 256 bits of randomness, so there is no dictionary to run.
 * The pepper is still folded in, because it costs nothing and it means a
 * database on its own is not enough.
 */
export const hashToken = (token: string, secret: string) => sha256(`${secret}:owner:${token}`);

/**
 * A token is only ever a hex string of the length `newToken` produces. Checked
 * before it reaches a query, so a cookie a stranger wrote cannot become a
 * pattern match against the owner index.
 */
export const looksLikeToken = (value: string) => /^[0-9a-f]{64}$/.test(value);

export const COOKIE = "wallid";

/**
 * A year, `HttpOnly`, `Secure`, `SameSite=Lax`.
 *
 * `HttpOnly` because nothing on the page needs to read it. `Lax` rather than
 * `Strict` so that arriving from a shared link, or back from Stripe's hosted
 * checkout, still carries the cookie on the first navigation — which for a
 * payment flow is not a nicety: `Strict` here would mean a buyer returning from
 * Stripe looks like a stranger.
 */
export const setCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;

/** The token this request carries, if it carries a well-formed one. */
export function tokenFrom(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE) continue;
    const value = rest.join("=");
    return looksLikeToken(value) ? value : null;
  }
  return null;
}

/**
 * The address, as Cloudflare reports it.
 *
 * `CF-Connecting-IP` and nothing else: `X-Forwarded-For` is client-supplied and
 * anything keyed on it has an opt-out header. Used for Turnstile's replay check
 * rather than for a quota.
 */
export const addressOf = (request: Request) => request.headers.get("CF-Connecting-IP");

/**
 * A claim id: sortable by time, random in the tail.
 *
 * Generated before the payment rather than by the insert after it, because it
 * has to travel through Stripe's metadata and come back on a webhook that may
 * arrive twice. The timestamp prefix is not for uniqueness — the 12 random
 * bytes are — it is so that a support conversation about "the claim from
 * Tuesday" can be answered by sorting ids.
 */
export const newClaimId = (nowSeconds: number) =>
  `${nowSeconds.toString(36).padStart(7, "0")}${hex(
    crypto.getRandomValues(new Uint8Array(12)).buffer,
  )}`;

export const looksLikeClaimId = (value: string) => /^[0-9a-z]{7}[0-9a-f]{24}$/.test(value);

/**
 * Constant-time string comparison, for the moderation token.
 *
 * `a === b` on a secret leaks its prefix through timing. The length is compared
 * first and does leak — unavoidable without hashing both sides, and the length
 * of an admin token is not the secret.
 */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A short-lived pass, issued once a Turnstile token has been redeemed.
 *
 * Turnstile tokens are single-use: Cloudflare's siteverify redeems one and
 * refuses it ever after with `timeout-or-duplicate`. The buy flow makes more
 * than one guarded call — resolve the artwork, maybe resolve it again after an
 * upload, then check out — and every one of those was sending the *same* token.
 * The first succeeded and the rest were 403s. Invisible in development, because
 * `.dev.vars` carries Cloudflare's always-passes test secret and it accepts
 * anything however many times.
 *
 * So: solve once, carry a pass. It is an HMAC over an expiry and the address it
 * was issued to, which means it is verifiable with no storage — there is no
 * table of live passes to keep, and a Worker in another colo can check one it
 * never issued.
 *
 * Bound to the address for the same reason Turnstile is given `remoteip`: a
 * pass lifted off one response is otherwise a solved challenge anybody can
 * spend. Ten minutes, which is a buyer finding their card rather than a session
 * worth stealing.
 */
export const PASS_SECONDS = 600;

const signPass = async (secret: string, expiry: number, address: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${secret}:pass`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${expiry}:${address}`)));
};

export async function issuePass(secret: string, address: string, nowSeconds: number) {
  const expiry = nowSeconds + PASS_SECONDS;
  return `${expiry}.${await signPass(secret, expiry, address)}`;
}

/** Whether this pass was issued by us, to this address, and has not expired. */
export async function verifyPass(
  value: unknown,
  secret: string,
  address: string,
  nowSeconds: number,
): Promise<boolean> {
  if (typeof value !== "string" || value.length > 200) return false;
  const [head, signature] = value.split(".");
  if (!head || !signature) return false;

  const expiry = Number(head);
  // Checked before the HMAC, so an expired pass costs a parse rather than a
  // signature. The comparison is still constant-time below: the expiry is not
  // the secret, the signature is.
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) return false;
  if (expiry > nowSeconds + PASS_SECONDS) return false;

  return sameSecret(signature, await signPass(secret, expiry, address));
}
