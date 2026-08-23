import { describe, expect, test } from "bun:test";
import { fetchFavicon, iconLinks, keyFor, looksLikeKey, normaliseUrl, sniff } from "./artwork";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("normaliseUrl", () => {
  test("upgrades a bare domain, because that is what people type", () => {
    expect(normaliseUrl("example.com")).toBe("https://example.com/");
  });

  test("refuses plaintext", () => {
    expect(normaliseUrl("http://example.com")).toBeNull();
  });

  test("refuses credentials in the authority", () => {
    // Reads as paypal.com at the glance a wall of logos gets.
    expect(normaliseUrl("https://paypal.com@evil.example/")).toBeNull();
  });

  test("refuses hosts that resolve inside our own network", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254"]) {
      expect(normaliseUrl(`https://${host}/`)).toBeNull();
    }
  });

  test("drops the fragment and keeps the path", () => {
    expect(normaliseUrl("acme.com/pricing#plans")).toBe("https://acme.com/pricing");
  });
});

describe("sniff", () => {
  test("recognises what it accepts", () => {
    expect(sniff(png)).toBe("image/png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  test("refuses an SVG however it is labelled", () => {
    // The point of sniffing: the upload said image/png and it is a document.
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
});

describe("iconLinks", () => {
  const base = new URL("https://acme.com/");

  test("prefers the apple touch icon, which is the one drawn rather than shrunk", () => {
    const html = `
      <link rel="icon" sizes="16x16" href="/small.png">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" sizes="32x32" href="/medium.png">`;
    expect(iconLinks(html, base)[0]).toBe("https://acme.com/touch.png");
  });

  test("orders the rest by declared size", () => {
    const html = `
      <link rel="icon" sizes="16x16" href="/a.png">
      <link rel="icon" sizes="192x192" href="/b.png">`;
    expect(iconLinks(html, base)).toEqual(["https://acme.com/b.png", "https://acme.com/a.png"]);
  });

  test("ignores links that are not icons", () => {
    expect(iconLinks('<link rel="stylesheet" href="/a.css">', base)).toEqual([]);
  });
});

describe("fetchFavicon", () => {
  test("reads the page, then fetches the icon it declares", async () => {
    const seen: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://acme.com/")
        return new Response('<link rel="apple-touch-icon" href="/logo.png">', {
          headers: { "content-type": "text/html" },
        });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    const found = await fetchFavicon("acme.com", fake);
    expect(found?.type).toBe("image/png");
    expect(found?.from).toBe("https://acme.com/logo.png");
    expect(seen[0]).toBe("https://acme.com/");
  });

  test("falls back to /favicon.ico when the page declares nothing", async () => {
    const fake = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/favicon.ico")
        ? new Response(png)
        : new Response("<html><head></head></html>", {
            headers: { "content-type": "text/html" },
          })) as typeof fetch;

    expect((await fetchFavicon("acme.com", fake))?.from).toBe("https://acme.com/favicon.ico");
  });

  test("gives up quietly when the site is unreachable", async () => {
    const fake = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    // Not an error the buyer needs to see: the upload was on offer anyway.
    expect(await fetchFavicon("acme.com", fake)).toBeNull();
  });

  test("refuses an oversized body before reading it", async () => {
    const fake = (async () =>
      new Response(png, {
        headers: { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) },
      })) as unknown as typeof fetch;
    expect(await fetchFavicon("acme.com", fake)).toBeNull();
  });
});

describe("keyFor", () => {
  test("is the content, so the same logo stores once", async () => {
    expect(await keyFor(png, "image/png")).toBe(await keyFor(png, "image/png"));
  });

  test("produces a key that passes its own guard", async () => {
    expect(looksLikeKey(await keyFor(png, "image/png"))).toBe(true);
  });

  test("rejects a traversal dressed as a key", () => {
    expect(looksLikeKey("../../secrets.png")).toBe(false);
  });
});
