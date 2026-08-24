import { MAX_BYTES } from "./limits";

/**
 * Turning a vector into a bitmap, in the one place that can: a browser.
 *
 * The wall stores PNG, JPEG, WebP and ICO and nothing else — see `ACCEPTED` in
 * `worker/wall/artwork.ts` for why an SVG is not a file this site wants to hold
 * or serve. But a great many sites now declare an SVG as their only icon, and
 * refusing those buyers is refusing the buyers whose sites were built most
 * recently.
 *
 * So the Worker fetches the SVG and hands it here instead of storing it, and
 * what goes back to the bucket is the PNG this file produces. The policy does
 * not move; the format problem is solved on the one machine in the chain that
 * has a rasteriser in it.
 */

/**
 * How many pixels one cell of artwork deserves.
 *
 * A cell is 80 CSS pixels at 1x, the camera zooms to 2, and a display may be 2x
 * again: 320 is the largest a *single cell* is ever drawn at.
 */
const PER_CELL = 320;

/**
 * The longest edge stored, whatever the arithmetic asks for.
 *
 * A 16x16 claim would want five thousand pixels, which is a file nobody can
 * store under `MAX_BYTES` and nobody needs — a claim that large is read from
 * far enough away to be seen whole. 1536 covers a claim about five cells across
 * at full zoom on a retina display, and everything bigger is being looked at
 * from further back.
 */
const MAX_EDGE = 1536;

/** The smallest we will settle for. Below this the artwork is worse than the
 * label it replaces. */
const MIN_EDGE = 320;

/**
 * The pixels a claim's artwork should be stored at.
 *
 * This is what the first version got wrong, and it is worth naming: the size
 * was a constant 320, chosen as the most a *cell* is ever drawn at — but a
 * claim draws one image across its whole rectangle, so a 6x3 claim was showing
 * a 320px image stretched over 1920 device pixels. Which is exactly where it
 * showed: a social preview, on a wide rectangle, with the banding and softness
 * of a fourfold upscale.
 *
 * So the size follows the rectangle it will be drawn into.
 */
export const tileEdge = (rect: { w: number; h: number }) =>
  Math.max(MIN_EDGE, Math.min(MAX_EDGE, Math.max(rect.w, rect.h) * PER_CELL));

/** Past this the file is not a logo, and a rasteriser is a good way to spend a
 * buyer's battery on somebody's idea of a joke. */
const TIMEOUT_MS = 5000;

/**
 * The sizes tried, largest first, until one encodes under the byte budget.
 *
 * A ladder rather than a calculation, because there is no way to predict an
 * encoder's output from its input — a flat logo at 1536 might be 40 KB and a
 * photograph at 768 might be 300. The only honest answer is to encode and look.
 */
const STEPS = [1, 0.75, 0.5, 0.35];

/**
 * JPEG quality, for artwork with nothing transparent in it.
 *
 * 0.86 is above where a photograph starts showing artefacts on a screen and far
 * below what a lossless encode of the same image costs. It matters here more
 * than it usually would: the alternative to a smaller file is not a bigger file
 * but a *smaller image*, and quality lost to resampling is worse than quality
 * lost to compression.
 */
const QUALITY = 0.86;

/**
 * The aspect ratio an SVG asks to be drawn at.
 *
 * Read from the markup rather than from `img.naturalWidth`, which is the part
 * of this that is easy to get wrong: an SVG carrying only a `viewBox` has no
 * intrinsic size at all, so a browser substitutes the CSS default sizing of
 * 300x150 and a square logo gets fitted as a 2:1 letterbox. The `viewBox` is
 * the honest answer and it is right there in the file.
 *
 * A regex over XML, for the same reason `iconLinks` uses one: the failure mode
 * is falling back to square, which is what a favicon almost always is.
 */
export function aspectOf(svg: string): number {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return 1;

  const box = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i
    .exec(root);
  if (box) {
    const width = Number(box[3]);
    const height = Number(box[4]);
    if (width > 0 && height > 0) return width / height;
  }

  // No viewBox: an explicit width and height, if both are plain numbers. A
  // percentage or a unit means the size depends on a containing block that does
  // not exist here, and square is a better guess than a parse.
  const attr = (name: string) =>
    Number(new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.]+)(px)?["'\\s>]`, "i").exec(root)?.[1]);
  const width = attr("width");
  const height = attr("height");
  return width > 0 && height > 0 ? width / height : 1;
}

/**
 * Any image's bytes, redrawn at the size the wall will paint it, or `null`.
 *
 * Two callers, one job. An SVG comes here because the wall will not store a
 * document; a social preview comes here because it is a 1200x630 photograph and
 * the wall will not store a megabyte. Both want the same thing — this image,
 * redrawn at the size a cell is actually painted at — and neither the Worker
 * nor the bucket can do it.
 *
 * `edge` is the longest side to aim for — `tileEdge(rect)` turns the claim's
 * rectangle into it. The result is encoded under `MAX_BYTES`, stepping down
 * through `STEPS` until it fits, because the wall will refuse anything heavier
 * and refusing it *after* the upload is a spinner ending in a sentence about
 * bytes.
 *
 * `null` on anything at all: a file that will not parse, one that takes too
 * long, a canvas that will not export. The caller's fallback is the upload
 * field it was already showing, so a failure here costs a sentence rather than
 * the sale.
 */
export async function rasterise(
  bytes: Uint8Array,
  type = "image/svg+xml",
  edge = MIN_EDGE,
  name = "icon",
): Promise<File | null> {
  /*
   * Where the aspect ratio comes from, and why it depends on the type.
   *
   * A raster knows its own size and `naturalWidth` is the truth. An SVG very
   * often does not — carrying a `viewBox` and nothing else — and there the same
   * property reports the browser's 300x150 default sizing, which would fit a
   * square logo as a 2:1 letterbox. So the vector is measured from its markup
   * and everything else is measured from itself.
   */
  const vector = type === "image/svg+xml";
  const declared = vector ? aspectOf(new TextDecoder().decode(bytes)) : 0;

  /*
   * A blob URL, and an `<img>`.
   *
   * Which is the whole reason this is safe to do with a stranger's markup: an
   * SVG loaded as an image runs in secure static mode — no script executes, no
   * external reference is fetched — where the same bytes at a URL of their own
   * would be a document. The blob is revoked before this function returns, so
   * there is no lingering handle to navigate to either.
   */
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));

  try {
    const image = await load(url);
    if (!image) return null;

    const natural =
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? image.naturalWidth / image.naturalHeight
        : 1;
    const aspect = vector ? declared : natural;

    /*
     * Never enlarged past the source.
     *
     * A 64px favicon asked to fill a 6-cell claim would be drawn at 1536 and
     * stored as a large blurry file — the same pixels as the small sharp one,
     * with the upscale baked in and the wall's own smoothing no longer able to
     * do anything about it. Upscaling is the renderer's job, at the size it is
     * actually drawing, not a decision to freeze into the bucket.
     */
    const longest = vector
      ? edge
      : Math.min(edge, Math.max(image.naturalWidth, image.naturalHeight));

    let opaque: boolean | null = null;

    for (const step of STEPS) {
      // Fitted inside the box, so a wide image keeps its shape instead of being
      // stretched to fill — the same contain-not-cover rule the canvas draws by.
      // A 1200x630 preview therefore lands as 1536x806 rather than as a square
      // with a squashed photograph in it.
      const box = Math.max(1, Math.round(longest * step));
      const width = aspect >= 1 ? box : Math.max(1, Math.round(box * aspect));
      const height = aspect >= 1 ? Math.max(1, Math.round(box / aspect)) : box;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Destination size, not the image's own: the vector is rasterised, and
      // the photograph resampled, straight to the size it will be stored at.
      ctx.drawImage(image, 0, 0, width, height);

      // Read once, off the first and largest draw. A logo with transparency has
      // to stay a PNG or the mount behind it turns into a black rectangle;
      // anything fully opaque is a photograph as far as this is concerned, and
      // JPEG stores it several times smaller at a quality nobody can see.
      if (opaque === null) opaque = isOpaque(ctx, width, height);

      const blob = await encode(canvas, opaque);
      if (!blob) return null;
      if (blob.size <= MAX_BYTES || step === STEPS[STEPS.length - 1]) {
        return new File([blob], `${name}.${opaque ? "jpg" : "png"}`, { type: blob.type });
      }
    }
    return null;
  } catch {
    // A tainted canvas, a decoder that gave up, a browser without `toBlob`.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const encode = (canvas: HTMLCanvasElement, opaque: boolean): Promise<Blob | null> =>
  new Promise(resolve =>
    canvas.toBlob(resolve, opaque ? "image/jpeg" : "image/png", opaque ? QUALITY : undefined),
  );

/**
 * Whether anything in the image is see-through.
 *
 * Sampled on a stride rather than read pixel by pixel: at 1536 square that is
 * two million pixels and nine megabytes, and one transparent pixel in a
 * hundred is enough to know this has to stay a PNG. The corners are checked
 * exactly, because a logo on transparency is transparent there if it is
 * transparent anywhere.
 */
function isOpaque(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4 * 17) {
      if (data[i]! < 250) return false;
    }
    for (const [x, y] of [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ]) {
      if (ctx.getImageData(x!, y!, 1, 1).data[3]! < 250) return false;
    }
    return true;
  } catch {
    // Unreadable pixels: PNG keeps whatever transparency is there, which is the
    // answer that cannot be wrong.
    return false;
  }
}

/** The image, decoded, or `null` — never a promise that does not settle. */
function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.src = "";
      resolve(null);
    }, TIMEOUT_MS);
    const settle = (value: HTMLImageElement | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    image.onload = () => settle(image);
    image.onerror = () => settle(null);
    image.src = url;
  });
}
