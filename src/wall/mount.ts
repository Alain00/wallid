/**
 * What colour sits behind a claim's artwork.
 *
 * The wall used to derive this from the claim id — a hash to a hue, so nobody
 * picked their own colour and the board could not turn into a row of shouting
 * rectangles. That held the wall together and knew nothing at all about the
 * image it was framing, which is how a black-square favicon ended up in an
 * olive frame: the two colours had never met.
 *
 * So the artwork picks it instead. Nobody chooses their colour still — the
 * property that keeps a wall of strangers coherent — but the thing doing the
 * choosing can now see what it is choosing for.
 *
 * Three cases, in order:
 *
 *   1. The artwork's own edge is opaque and one colour: a favicon that is a
 *      solid tile with a mark on it. Extend that colour and the mount vanishes
 *      — the tile becomes the artwork, edge to edge, which is what its designer
 *      drew.
 *   2. Otherwise the mount takes the artwork's *hue* at the wall's own
 *      lightness, so a blue logo sits on blue rather than on a stranger's
 *      brown, and the board keeps its mosaic.
 *   3. Except when the artwork is dark, where a dark mount would swallow it.
 *      Then the same hue, light — the one case where a tile is allowed to be
 *      brighter than the wall, because the alternative is a cell somebody paid
 *      for that reads as empty.
 */

/** A decoded image, small. Only colours are wanted, so the caller downsamples
 * first and this never sees more than a few hundred pixels. */
export type Sample = { data: Uint8ClampedArray; width: number; height: number };

/** Below this alpha a pixel is the tile showing through, not the artwork. */
const OPAQUE = 250;
/** Above this a pixel is ink rather than an antialiased fringe. */
const INK = 32;

/**
 * How much variation the edge may carry and still count as "one colour".
 *
 * Out of 255, per channel. Generous enough to survive JPEG ringing and a
 * gradient that is nearly flat, mean enough to refuse a photograph — where
 * extending an edge colour would pick one arbitrary pixel's worth of a scene
 * and paint the tile with it.
 */
const FLAT = 24;

/** Lighter than the wall (#0a0a0b) so a tile is visibly a tile, and dark enough
 * to stay a mount rather than a colour. Matches the lightness the id-derived
 * grounds were drawn at, so nothing on the board changes register. */
const MOUNT_L = 0.29;
const MOUNT_C = 0.045;

/** The mount for a dark mark. Bright enough that black artwork reads, tinted
 * enough that it is still that brand's tile and not a white hole. */
const LIGHT_L = 0.93;
const LIGHT_C = 0.03;

/** Below this the artwork cannot hold its own against a dark mount. */
const DARK_ARTWORK = 0.45;

/** Nothing sampled — a broken image, or one that is entirely transparent. The
 * id-derived colour is still the right answer there, so this is only the
 * fallback for artwork that exists and says nothing. */
export const NEUTRAL = "oklch(0.29 0 0)";

/**
 * sRGB to OKLab.
 *
 * Proper conversion rather than HSL's hue, because the whole point is that the
 * mount is *that logo's* colour: HSL's blue sits about twenty degrees from
 * OKLCH's, which is the difference between a mount that matches and one that is
 * nearly right in a way the eye reads as wrong. The matrices are the published
 * ones; `linear` undoes the sRGB transfer function first, which is the step
 * everybody skips and which is why averaged colours usually come out muddy.
 */
const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function oklab(r: number, g: number, b: number) {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);

  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    L,
    chroma: Math.hypot(A, Bb),
    // Degrees, positive, which is what `oklch()` takes.
    hue: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360,
  };
}

/** The mean of a list of pixels, as a colour and its spread. */
function meanOf(pixels: number[][]) {
  const sum = [0, 0, 0];
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const pixel of pixels) {
    for (let c = 0; c < 3; c++) {
      sum[c] = sum[c]! + pixel[c]!;
      min[c] = Math.min(min[c]!, pixel[c]!);
      max[c] = Math.max(max[c]!, pixel[c]!);
    }
  }
  const mean = sum.map(total => Math.round(total / pixels.length)) as [number, number, number];
  const spread = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  return { mean, spread };
}

/** The pixels around the outside of the sample — the edge that would meet the
 * mount if the artwork were drawn to the tile's border. */
function ring(sample: Sample): number[][] {
  const { data, width, height } = sample;
  const pixels: number[][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
      const i = (y * width + x) * 4;
      pixels.push([data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]);
    }
  }
  return pixels;
}

/** The colour to draw behind this artwork. */
export function mountFor(sample: Sample): string {
  if (sample.width < 3 || sample.height < 3) return NEUTRAL;

  // 1. A solid, opaque edge is a tile the designer already drew. Extend it.
  const edge = ring(sample);
  const opaque = edge.filter(pixel => pixel[3]! >= OPAQUE);
  if (opaque.length >= edge.length * 0.9) {
    const { mean, spread } = meanOf(opaque);
    if (spread <= FLAT) return `rgb(${mean[0]} ${mean[1]} ${mean[2]})`;
  }

  // 2. Otherwise, the artwork's own hue at the wall's lightness.
  const { data, width, height } = sample;
  const ink: number[][] = [];
  for (let i = 0; i < width * height * 4; i += 4) {
    if (data[i + 3]! >= INK) ink.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  if (ink.length === 0) return NEUTRAL;

  const { mean } = meanOf(ink);
  const { L, chroma, hue } = oklab(mean[0], mean[1], mean[2]);

  // A grey mark has no hue worth borrowing, and forcing chroma onto it invents
  // a colour its owner never used.
  const tint = Math.min(chroma, L < DARK_ARTWORK ? LIGHT_C : MOUNT_C);

  // 3. A dark mark gets a light mount, or it disappears into its own tile.
  return L < DARK_ARTWORK
    ? `oklch(${LIGHT_L} ${tint.toFixed(3)} ${hue.toFixed(1)})`
    : `oklch(${MOUNT_L} ${tint.toFixed(3)} ${hue.toFixed(1)})`;
}
