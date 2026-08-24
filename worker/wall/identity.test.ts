import { describe, expect, test } from "bun:test";
import { issuePass, verifyPass, PASS_SECONDS } from "./identity";

/**
 * The pass exists because a Turnstile token is redeemed exactly once, and the
 * buy flow makes more than one guarded call. Everything worth asserting about
 * it is a refusal.
 */
describe("the pass", () => {
  const secret = "pepper";
  const address = "203.0.113.7";
  const AT = 1_770_000_000;

  test("verifies for the address it was issued to", async () => {
    const pass = await issuePass(secret, address, AT);
    expect(await verifyPass(pass, secret, address, AT + 1)).toBe(true);
  });

  test("refuses another address, so a lifted pass is not a solved challenge", async () => {
    const pass = await issuePass(secret, address, AT);
    expect(await verifyPass(pass, secret, "198.51.100.9", AT + 1)).toBe(false);
  });

  test("expires", async () => {
    const pass = await issuePass(secret, address, AT);
    expect(await verifyPass(pass, secret, address, AT + PASS_SECONDS - 1)).toBe(true);
    expect(await verifyPass(pass, secret, address, AT + PASS_SECONDS + 1)).toBe(false);
  });

  test("refuses an expiry pushed into the future by hand", async () => {
    // The expiry travels in the clear, so the signature has to cover it — and
    // the window is bounded on both sides, or a forged far-future expiry that
    // happened to verify would be a permanent pass.
    const pass = await issuePass(secret, address, AT);
    const forged = `${AT + PASS_SECONDS * 100}.${pass.split(".")[1]}`;
    expect(await verifyPass(forged, secret, address, AT)).toBe(false);
  });

  test("refuses a different pepper", async () => {
    const pass = await issuePass(secret, address, AT);
    expect(await verifyPass(pass, "other", address, AT + 1)).toBe(false);
  });

  test("refuses malformed input rather than throwing on it", async () => {
    for (const value of ["", ".", "abc", "1.", `${AT + 60}.zz`, null, 7, "x".repeat(300)]) {
      expect(await verifyPass(value, secret, address, AT)).toBe(false);
    }
  });
});
