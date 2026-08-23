/**
 * Stripe, over `fetch`.
 *
 * Not the SDK, and that is a deliberate cost: the official library pulls Node
 * built-ins that this Worker deliberately does not enable (`nodejs_compat` is
 * off, see `wrangler.jsonc`), and what it buys here is two API calls and a
 * signature check. Written directly, the Worker stays dependency-free and every
 * byte of what it sends Stripe is visible in this file.
 *
 * The trade to know about: no typed resources, and no automatic retries. The
 * first is a handful of `as` casts below; the second does not apply, because
 * the only call that must not be lost is the webhook, and Stripe retries that
 * from its side.
 */

const API = "https://api.stripe.com/v1";

/** Stripe takes `application/x-www-form-urlencoded` with bracketed nesting, so
 * a flat map of already-shaped keys is the honest representation rather than a
 * serialiser that pretends it takes JSON. */
async function call<T>(secret: string, path: string, form: Record<string, string>): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
      // Stripe pins behaviour to the version the account was created against
      // unless told otherwise. Pinned here so an account-level version bump in
      // the dashboard cannot silently change what this code receives.
      "stripe-version": "2026-06-30.clover",
    },
    body: new URLSearchParams(form),
  });

  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `stripe ${response.status}`);
  return body as T;
}

/**
 * A hosted checkout for one claim.
 *
 * One line item for the whole rectangle rather than one per cell. A 16x16 claim
 * is 256 cells and Stripe caps a session's line items well below that, but the
 * real reason is the receipt: "12 cells on wallid.lol" is what somebody wants
 * to see on a card statement, and 256 identical dollar lines is what makes them
 * call their bank.
 *
 * `client_reference_id` and the metadata both carry the claim id. The metadata
 * is what the webhook reads; `client_reference_id` is what a human reads in the
 * dashboard when a support email arrives with nothing but a card's last four.
 */
export async function createCheckout(
  secret: string,
  args: {
    claimId: string;
    label: string;
    cells: number;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    email?: string | null;
  },
): Promise<{ id: string; url: string }> {
  const form: Record<string, string> = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(args.amountCents),
    "line_items[0][price_data][product_data][name]": `${args.cells} cell${
      args.cells === 1 ? "" : "s"
    } on wallid.lol`,
    "line_items[0][price_data][product_data][description]": args.label.slice(0, 200),
    client_reference_id: args.claimId,
    "metadata[claim_id]": args.claimId,
    // Read back on the webhook and compared against what the claim says it
    // costs. Stripe is the authority on what was *captured*; this is how the
    // Worker notices a session whose amount is not the one it asked for.
    "metadata[amount_cents]": String(args.amountCents),
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    // Cells are taken at the price they were quoted at, and a quote goes stale
    // as soon as somebody else buys. Half an hour is long enough to find a card
    // and short enough that an abandoned tab is not holding a price overnight.
    expires_at: String(Math.floor(Date.now() / 1000) + 30 * 60),
  };
  if (args.email) form.customer_email = args.email;

  return call<{ id: string; url: string }>(secret, "/checkout/sessions", form);
}

/**
 * The refund a lost race owes.
 *
 * `beats()` runs again inside the settling transaction, against rows read in
 * that transaction, and it can say no: two buyers quoted the same cell, both
 * paid, and the slower one's money bought a price that is no longer enough. The
 * cells are not half-sold and the money does not stay. This is the other half
 * of that promise, and it is why `payment_intent` is read off the session.
 */
export async function refund(
  secret: string,
  paymentIntent: string,
  reason = "requested_by_customer",
): Promise<void> {
  await call(secret, "/refunds", { payment_intent: paymentIntent, reason });
}

/**
 * The event a webhook carries, once its signature has been checked.
 *
 * Verified rather than parsed-and-trusted, because the webhook endpoint is a
 * public URL that writes cells and takes money at somebody's word. An unsigned
 * POST to it, if this check were missing, is a free wall.
 */
export type StripeEvent = {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount_total?: number;
      payment_status?: string;
      payment_intent?: string;
      customer_email?: string | null;
      metadata?: Record<string, string>;
    };
  };
};

/**
 * Stripe's `Stripe-Signature`, checked.
 *
 * The header is `t=<unix>,v1=<hex>,v1=<hex>` — more than one `v1` during a
 * secret rotation, which is why this scans them all rather than reading the
 * first. The signed payload is `${t}.${rawBody}`, and it must be the *raw*
 * body: re-serialising the parsed JSON changes the bytes and the signature
 * stops matching, which is the classic way this check ends up silently
 * disabled.
 *
 * The timestamp tolerance is what makes a captured-and-replayed webhook stop
 * working. Five minutes is Stripe's own recommendation.
 */
export async function verifyWebhook(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<StripeEvent | null> {
  if (!secret || !header) return null;

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=");
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;

  const age = nowSeconds - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > toleranceSeconds) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = [...new Uint8Array(mac)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  if (!signatures.some(signature => timingSafeEqual(signature, expected))) return null;

  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    return null;
  }
}

/** `a === b` on a MAC leaks its prefix through timing, and a leaked prefix is
 * a forgeable signature one byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
