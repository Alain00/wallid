import { describe, expect, test } from "bun:test";
import { verifyWebhook } from "./stripe";

const SECRET = "whsec_test";

/** Signs a body the way Stripe does, so the test exercises the real check
 * rather than a stub of it. */
async function sign(body: string, timestamp: number, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

const NOW = 1_770_000_000;
const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1" } } });

describe("verifyWebhook", () => {
  test("accepts a correctly signed event", async () => {
    const event = await verifyWebhook(BODY, await sign(BODY, NOW), SECRET, NOW);
    expect(event?.id).toBe("evt_1");
  });

  test("refuses a body that changed after signing", async () => {
    const header = await sign(BODY, NOW);
    const tampered = BODY.replace("cs_1", "cs_evil");
    expect(await verifyWebhook(tampered, header, SECRET, NOW)).toBeNull();
  });

  test("refuses a signature from a different secret", async () => {
    expect(await verifyWebhook(BODY, await sign(BODY, NOW, "whsec_other"), SECRET, NOW)).toBeNull();
  });

  test("refuses a replay from outside the tolerance", async () => {
    // Correctly signed, captured, and sent again an hour later.
    expect(await verifyWebhook(BODY, await sign(BODY, NOW - 3600), SECRET, NOW)).toBeNull();
  });

  test("accepts more than one v1, so a secret rotation does not drop events", async () => {
    const real = await sign(BODY, NOW);
    const header = `${real.replace("t=", "t=")},v1=${"0".repeat(64)}`;
    expect(await verifyWebhook(header ? BODY : "", header, SECRET, NOW)).not.toBeNull();
  });

  test("refuses when the endpoint has no secret configured", async () => {
    // Fails closed: a deployment that forgot the secret refuses payments rather
    // than accepting unsigned ones.
    expect(await verifyWebhook(BODY, await sign(BODY, NOW), undefined, NOW)).toBeNull();
  });

  test("refuses a request with no signature at all", async () => {
    expect(await verifyWebhook(BODY, null, SECRET, NOW)).toBeNull();
  });
});
