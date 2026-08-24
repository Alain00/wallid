import { describe, expect, test } from "bun:test";
import { mountFor, oklab, NEUTRAL, type Sample } from "./mount";

/** A sample built from a function of x and y, so a fixture reads as a picture
 * rather than as a list of bytes. */
function image(
  size: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Sample {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: size, height: size };
}

const inside = (x: number, y: number, size = 24) =>
  x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7;

describe("mountFor", () => {
  test("extends a solid opaque edge, so the tile becomes the artwork", () => {
    // Vercel exactly: an opaque black square with a white mark in the middle.
    // The mount has to disappear — a black tile with a triangle on it, not a
    // black square sitting in a coloured frame.
    const vercel = image(24, (x, y) =>
      inside(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255],
    );
    expect(mountFor(vercel)).toBe("rgb(0 0 0)");
  });

  test("takes the hue of a mark drawn on transparency", () => {
    // Blobatar: a light blue blob on nothing. There is no edge to extend, so
    // the mount is that blue, dark — not a stranger's brown.
    const blob = image(24, (x, y) =>
      inside(x, y) ? [165, 221, 255, 255] : [0, 0, 0, 0],
    );
    const mount = mountFor(blob);
    expect(mount).toStartWith("oklch(0.29");
    // Blue in OKLCH is around 230-270 degrees; the point of converting properly
    // rather than through HSL is that this lands on the artwork's own blue.
    const hue = Number(mount.split(" ")[2]!.replace(")", ""));
    expect(hue).toBeGreaterThan(200);
    expect(hue).toBeLessThan(280);
  });

  test("gives a dark mark a light mount, or it vanishes into its own tile", () => {
    const wordmark = image(24, (x, y) => (inside(x, y) ? [17, 17, 17, 255] : [0, 0, 0, 0]));
    expect(mountFor(wordmark)).toStartWith("oklch(0.93");
  });

  test("refuses to extend a busy edge", () => {
    // A photograph reaching the border. Extending one pixel's worth of a scene
    // paints the tile with an arbitrary colour, so this falls through to the
    // hue rule instead.
    const photo = image(24, x => [(x * 37) % 256, (x * 91) % 256, (x * 13) % 256, 255]);
    expect(mountFor(photo)).toStartWith("oklch(");
  });

  test("does not invent a colour for a grey mark", () => {
    const grey = image(24, (x, y) => (inside(x, y) ? [128, 128, 128, 255] : [0, 0, 0, 0]));
    // Chroma at or near zero: a logo with no hue must not be given one.
    const chroma = Number(mountFor(grey).split(" ")[1]!);
    expect(chroma).toBeLessThan(0.01);
  });

  test("falls back when there is nothing to read", () => {
    expect(mountFor(image(24, () => [0, 0, 0, 0]))).toBe(NEUTRAL);
    expect(mountFor({ data: new Uint8ClampedArray(4), width: 1, height: 1 })).toBe(NEUTRAL);
  });
});

describe("oklab", () => {
  test("puts the primaries where OKLCH says they are", () => {
    // The published anchors. If the transfer function were skipped these come
    // out visibly wrong, which is the mistake this exists to prevent.
    expect(oklab(255, 0, 0).hue).toBeCloseTo(29.2, 0);
    expect(oklab(0, 255, 0).hue).toBeCloseTo(142.5, 0);
    expect(oklab(0, 0, 255).hue).toBeCloseTo(264.1, 0);
  });

  test("reads lightness on a perceptual scale", () => {
    expect(oklab(255, 255, 255).L).toBeCloseTo(1, 2);
    expect(oklab(0, 0, 0).L).toBeCloseTo(0, 2);
    // Mid grey is perceptually above the midpoint, which is the whole reason
    // for using OKLab rather than averaging bytes.
    expect(oklab(128, 128, 128).L).toBeGreaterThan(0.5);
  });

  test("gives grey no chroma", () => {
    expect(oklab(128, 128, 128).chroma).toBeCloseTo(0, 3);
  });
});
