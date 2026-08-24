import { describe, expect, test } from "bun:test";
import {
  fetchFavicon,
  fetchOgImage,
  iconLinks,
  keyFor,
  looksLikeKey,
  normaliseUrl,
  previewImages,
  sniff,
  sniffVector,
} from "./artwork";

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

describe("sniffVector", () => {
  const svg = (body: string) => new TextEncoder().encode(body);

  test("recognises an SVG however it opens", () => {
    expect(sniffVector(svg('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    // What a file written by a design tool actually looks like.
    expect(sniffVector(svg('<?xml version="1.0"?>\n<svg viewBox="0 0 24 24"/>'))).toBe("image/svg+xml");
    expect(sniffVector(svg('<!-- Generator: hand -->\n<svg />'))).toBe("image/svg+xml");
  });

  test("is not a second opinion on what may be stored", () => {
    // The two questions are separate on purpose: this one says the panel can
    // draw it, `sniff` says the bucket may hold it, and SVG is yes then no.
    const bytes = svg("<svg/>");
    expect(sniffVector(bytes)).toBe("image/svg+xml");
    expect(sniff(bytes)).toBeNull();
  });

  test("refuses the 404 page a missing /favicon.ico actually returns", () => {
    // The real blobatar.dev failure: 59 KB of HTML under a 404, which is not an
    // icon and must not be mistaken for a vector either.
    expect(sniffVector(svg("<!doctype html><html><body>not here</body></html>"))).toBeNull();
  });

  test("refuses a raster, and refuses nothing at all", () => {
    expect(sniffVector(png)).toBeNull();
    expect(sniffVector(new Uint8Array(0))).toBeNull();
  });
});

describe("fetchFavicon, on a site whose only icon is a vector", () => {
  // blobatar.dev exactly: one declared SVG icon, no /favicon.ico.
  const site = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://blobatar.dev/")
      return new Response('<link rel="icon" href="/favicon-dkqn2j36.svg" type="image/svg+xml">', {
        headers: { "content-type": "text/html" },
      });
    if (url.endsWith(".svg"))
      return new Response('<svg viewBox="0 0 64 64"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    return new Response("<!doctype html>not here", { status: 404 });
  }) as unknown as typeof fetch;

  test("returns the vector, tagged, instead of nothing", async () => {
    const found = await fetchFavicon("https://blobatar.dev/", site);
    expect(found?.type).toBe("image/svg+xml");
    expect(found?.from).toBe("https://blobatar.dev/favicon-dkqn2j36.svg");
  });

  test("still prefers a raster when the site offers one", async () => {
    const both = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://acme.com/")
        return new Response(
          '<link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/touch.png">',
          { headers: { "content-type": "text/html" } },
        );
      if (url.endsWith(".svg")) return new Response("<svg/>");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    const found = await fetchFavicon("https://acme.com/", both);
    expect(found?.type).toBe("image/png");
  });
});

describe("previewImages", () => {
  const base = new URL("https://acme.com/");

  test("reads og:image however the attributes are ordered or quoted", () => {
    // All three spellings appear in the wild, which is why the attribute is
    // found within the tag rather than by position.
    const html = `
      <meta content="/a.png" property="og:image">
      <meta property='og:image:url' content='/b.png'>
      <meta name="og:image" content="https://cdn.acme.com/c.png">`;
    expect(previewImages(html, base)).toEqual([
      "https://acme.com/a.png",
      "https://acme.com/b.png",
      "https://cdn.acme.com/c.png",
    ]);
  });

  test("prefers og:image over twitter:image", () => {
    // A site with both usually set the first deliberately and let a framework
    // fill in the second.
    const html = `
      <meta name="twitter:image" content="/t.png">
      <meta property="og:image" content="/og.png">`;
    expect(previewImages(html, base)[0]).toBe("https://acme.com/og.png");
  });

  test("ignores meta tags that are not images", () => {
    const html = '<meta property="og:title" content="Acme"><meta charset="utf-8">';
    expect(previewImages(html, base)).toEqual([]);
  });
});

describe("fetchOgImage", () => {
  test("fetches the declared preview", async () => {
    const site = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://acme.com/")
        return new Response('<meta property="og:image" content="/preview.png">', {
          headers: { "content-type": "text/html" },
        });
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    const found = await fetchOgImage("https://acme.com/", site);
    expect(found?.from).toBe("https://acme.com/preview.png");
    expect(found?.type).toBe("image/png");
  });

  test("gives up rather than guessing when a site declares none", async () => {
    // Unlike a favicon there is no well-known path to fall back on: a preview
    // exists only because the page says so.
    const bare = (async () =>
      new Response("<html><head><title>Acme</title></head></html>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    expect(await fetchOgImage("https://acme.com/", bare)).toBeNull();
  });

  test("refuses a preview hosted somewhere we must not reach", async () => {
    // The og:image URL is a stranger's string and this Worker follows it, so it
    // goes through the same guard every other outbound URL does.
    const evil = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://acme.com/")
        return new Response('<meta property="og:image" content="http://169.254.169.254/latest">', {
          headers: { "content-type": "text/html" },
        });
      throw new Error("must not be fetched");
    }) as unknown as typeof fetch;
    expect(await fetchOgImage("https://acme.com/", evil)).toBeNull();
  });
});
