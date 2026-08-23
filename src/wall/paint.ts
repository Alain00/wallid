import { claimedCells, type ChunkBody, type ClaimEntry } from "./chunk";
import { CELL, cellToScreen, visibleBox, type Camera, type Viewport } from "./camera";
import { SIDE, contains, type Rect } from "./geometry";

/**
 * Drawing the wall.
 *
 * To a canvas, not to the DOM. A wall of sixteen thousand cells holds hundreds
 * of images on screen at once and moves every one of them every frame, and a
 * DOM node per cell is a layout pass per frame. One canvas, one draw call per
 * claim, and the DOM left for the one cell the pointer is over.
 *
 * A claim is drawn as *one image across its rectangle*, not as the same image
 * repeated in each of its cells. That is the difference between a 4x4 claim
 * reading as a logo and reading as sixteen stamps of a logo, and it is why
 * cells carry their claim's rectangle rather than only their own coordinates.
 * It also survives the thing that makes this wall interesting: when somebody
 * buys four cells out of the middle of a 12x12, the rest of that image keeps
 * drawing in place, with a hole in it.
 */

/**
 * The grid the wall is drawn on, under everything.
 *
 * A wall whose empty cells are invisible is a dark rectangle with some logos
 * floating in it, and there is no way to see that a cell is *available*. The
 * lattice is what makes emptiness read as space for sale.
 *
 * Dashed, not solid, and that is the whole difference in how this board feels.
 * A solid lattice at this density reads as a spreadsheet: an authored, rigid
 * thing you fill in. A dashed one reads as ruled paper — the cells are still
 * exactly there, but the wall looks drawn rather than generated, which is the
 * register the rest of this site is in. It also costs the grid about half its
 * ink, so the logos people pay for are unambiguously the loudest thing on
 * screen.
 */
const GRID = "rgba(255,255,255,0.09)";
const GROUND = "#0a0a0b";

/**
 * The dash, in screen pixels, and re-derived per frame rather than fixed.
 *
 * A dash measured in *cells* stretches as you zoom and the texture changes with
 * the camera, which makes the wall feel like it is breathing. Measured in
 * screen pixels it stays the same stroke at every zoom, so zooming moves the
 * wall rather than redrawing it in a different hand.
 */
const DASH = [3, 5];

/** The wall's own edge. Bounded is the product, so the boundary is drawn rather
 * than merely enforced: you should be able to see that the board ends. */
const EDGE = "rgba(255,255,255,0.28)";

/** How round a claim's tile is, as a fraction of the cell. Small: this is a
 * softened square, not a pill, and the artwork inside it is usually already a
 * rounded mark. */
const RADIUS = 0.14;

/**
 * Loaded artwork, keyed by its R2 key.
 *
 * Keys are content hashes, so two claims using the same logo share one entry,
 * and an entry can never be stale — the bytes under a key are the key.
 *
 * `null` marks an image that failed to load, which is not the same as one that
 * has not been asked for yet. Without that distinction a broken image is
 * requested again on every single frame.
 */
type Sprites = Map<string, HTMLImageElement | null>;

export const createSprites = (): Sprites => new Map();

function spriteFor(sprites: Sprites, key: string, onLoad: () => void): HTMLImageElement | null {
  const held = sprites.get(key);
  if (held !== undefined) return held;

  const image = new Image();
  // Set before `src`, or the request is already in flight under the wrong mode
  // and the canvas is tainted by the time it lands.
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.onload = onLoad;
  image.onerror = () => sprites.set(key, null);
  image.src = `/img/${key}`;
  sprites.set(key, image);
  return image;
}

export type PaintArgs = {
  ctx: CanvasRenderingContext2D;
  camera: Camera;
  view: Viewport;
  chunks: Map<string, ChunkBody>;
  sprites: Sprites;
  /** The rectangle being dragged out right now, drawn over everything. */
  selection?: Rect | null;
  /** The cell under the pointer, lit so the grid answers the cursor. */
  hover?: { x: number; y: number } | null;
  /** Redraw, because an image finished loading. */
  onLoad: () => void;
};

export function paint({
  ctx,
  camera,
  view,
  chunks,
  sprites,
  selection,
  hover,
  onLoad,
}: PaintArgs): void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, view.width, view.height);

  const size = CELL * camera.zoom;
  const box = visibleBox(camera, view, 1);

  drawGrid(ctx, camera, view, box, size);

  /*
   * Claims, drawn once each rather than once per cell.
   *
   * Collected first because a claim's cells arrive spread across the chunk
   * bodies in whatever order those were fetched, and drawing an image per cell
   * would both repeat the artwork and cost a draw call per cell of every claim
   * on screen. What is kept per claim is which of its cells it still holds,
   * which is what the clip below uses to leave holes where it has been eaten.
   */
  const visible = new Map<string, { claim: ClaimEntry; cells: { x: number; y: number }[] }>();
  for (const { x, y, claim } of claimedCells(chunks)) {
    if (x < box.x0 - 1 || x > box.x1 + 1 || y < box.y0 - 1 || y > box.y1 + 1) continue;
    const held = visible.get(claim.id) ?? { claim, cells: [] };
    held.cells.push({ x, y });
    visible.set(claim.id, held);
  }

  for (const { claim, cells } of visible.values()) {
    drawClaim(ctx, camera, view, size, claim, cells, sprites, onLoad);
  }

  if (hover) drawHover(ctx, camera, view, size, hover);
  if (selection) drawSelection(ctx, camera, view, size, selection);
  drawEdge(ctx, camera, view, size);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  box: { x0: number; y0: number; x1: number; y1: number },
  size: number,
) {
  // Below about ten pixels a cell the dashes are closer together than the gaps
  // between them, and the grid stops reading as a lattice and starts reading as
  // fog. Higher than the solid version's threshold, because a dashed line
  // degrades sooner than a solid one does.
  if (size < 10) return;

  ctx.save();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.setLineDash(DASH);
  ctx.beginPath();
  const x0 = Math.max(0, box.x0);
  const y0 = Math.max(0, box.y0);
  const x1 = Math.min(SIDE, box.x1 + 1);
  const y1 = Math.min(SIDE, box.y1 + 1);

  for (let x = x0; x <= x1; x++) {
    const at = cellToScreen(camera, view, x, y0);
    // The half-pixel is what keeps a 1px line one pixel wide instead of two
    // half-lit ones. On a grid this dense the difference is the whole texture.
    ctx.moveTo(Math.round(at.x) + 0.5, Math.round(at.y) + 0.5);
    ctx.lineTo(Math.round(at.x) + 0.5, Math.round(cellToScreen(camera, view, x, y1).y) + 0.5);
  }
  for (let y = y0; y <= y1; y++) {
    const at = cellToScreen(camera, view, x0, y);
    ctx.moveTo(Math.round(at.x) + 0.5, Math.round(at.y) + 0.5);
    ctx.lineTo(Math.round(cellToScreen(camera, view, x1, y).x) + 0.5, Math.round(at.y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** A rounded rectangle path, in the one place that needs to agree about the
 * corner radius. `roundRect` is on every browser this ships to. */
function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  // A radius larger than half the shorter side inverts the corner, which
  // happens at the small end of the zoom range on a 1x1 claim.
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function drawClaim(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
  claim: ClaimEntry,
  cells: { x: number; y: number }[],
  sprites: Sprites,
  onLoad: () => void,
) {
  const corner = cellToScreen(camera, view, claim.rect.x, claim.rect.y);
  const width = claim.rect.w * size;
  const height = claim.rect.h * size;

  ctx.save();

  /*
   * The clip is the whole trick.
   *
   * The artwork is drawn once, across the claim's original rectangle, and then
   * masked to the cells the claim still holds. So a claim that has had four
   * cells taken out of its middle draws with a four-cell hole in it, in the
   * right place, without the renderer knowing anything about takeovers — it
   * just has fewer cells to clip to.
   *
   * Per cell rather than one rounded rect, because the surviving cells are not
   * necessarily a rectangle at all. That is the point.
   */
  ctx.beginPath();
  const radius = size * RADIUS;
  for (const cell of cells) {
    const at = cellToScreen(camera, view, cell.x, cell.y);
    /*
     * Each surviving cell is its own rounded square, with a hairline of inset
     * so neighbours do not fuse into one slab.
     *
     * Which means a 4x4 claim reads as sixteen soft tiles sharing one image
     * rather than as a single hard rectangle — and when four of them are taken
     * out of the middle, the hole has the same soft edge as the outside did.
     * There is no separate code path for a partially-eaten claim; there is just
     * a shorter list of cells to clip to.
     */
    ctx.roundRect(at.x + 0.5, at.y + 0.5, size - 1, size - 1, Math.min(radius, (size - 1) / 2));
  }
  ctx.clip();

  const sprite = claim.image ? spriteFor(sprites, claim.image, onLoad) : null;

  if (sprite && sprite.complete && sprite.naturalWidth > 0) {
    /*
     * Contained, not stretched.
     *
     * A favicon is square and a logo is usually not, and a wall that stretches
     * whatever it is handed to fill a rectangle makes every wide logo look
     * wrong in a way its owner will email about. Fitted inside, centred, with
     * the claim's own ground behind it so the letterboxing reads as a tile
     * rather than as a gap.
     */
    ctx.fillStyle = groundFor(claim.id);
    ctx.fillRect(corner.x, corner.y, width, height);

    /*
     * Inset, so the artwork does not run to the edge of its own tile.
     *
     * A logo touching the rounded corner reads as cropped. An eighth of a cell
     * of breathing room on every side is what makes it read as *placed on* the
     * tile, which is the same reason the hero blobatar on the other site sits
     * inside its box rather than filling it.
     */
    const pad = size * 0.12;
    const inner = { w: Math.max(1, width - pad * 2), h: Math.max(1, height - pad * 2) };
    const scale = Math.min(inner.w / sprite.naturalWidth, inner.h / sprite.naturalHeight);
    const w = sprite.naturalWidth * scale;
    const h = sprite.naturalHeight * scale;
    // A favicon is 32px being drawn at up to 160, so the browser's smoothing is
    // doing real work here rather than being a default nobody chose.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sprite, corner.x + (width - w) / 2, corner.y + (height - h) / 2, w, h);
  } else {
    /*
     * No artwork, or it has not loaded yet: the label on its own ground.
     *
     * Not a spinner and not a blank. A claim with a broken image is still a
     * claim somebody paid for, and it has to be legible as one — this is also
     * what a moderated claim draws as, since hiding blanks the image and the
     * label together and leaves the ground.
     */
    ctx.fillStyle = groundFor(claim.id);
    ctx.fillRect(corner.x, corner.y, width, height);

    if (claim.label && size > 24) {
      /*
       * The label is clipped to the cells *without* their gutters.
       *
       * The tile clip insets every cell by half a pixel so neighbours read as
       * separate tiles, and a word drawn through that clip is sliced by every
       * gutter it crosses — legible as "se d1" rather than as "seed1", which is
       * how this was found. Re-clipping to the same cells at full bleed closes
       * the gaps for the text alone, and still refuses to draw it over a hole
       * where cells have been taken away.
       */
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      for (const cell of cells) {
        const at = cellToScreen(camera, view, cell.x, cell.y);
        ctx.rect(at.x, at.y, size + 1, size + 1);
      }
      ctx.clip();

      ctx.fillStyle = "rgba(250,250,248,0.82)";
      ctx.font = `500 ${Math.min(size * 0.26, 17)}px Geist, ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(claim.label.slice(0, 14), corner.x + width / 2, corner.y + height / 2, width - 8);
    }
  }

  ctx.restore();
}

/**
 * A claim's ground colour, derived from its id.
 *
 * Derived rather than chosen, which is the one thing this wall keeps from a
 * generative avatar: nobody picks their colour, so the board stays coherent
 * however many strangers buy into it. A wall where each buyer picks a
 * background is a wall that is beige, red, and flashing, and the zoomed-out
 * view — the thing that makes this a wall rather than a list — stops being
 * worth looking at.
 *
 * Kept dark and low-chroma on purpose. It is a mount for somebody's logo, not a
 * colour competing with it.
 */
function groundFor(id: string): string {
  /*
   * FNV-1a with a final avalanche, not `hash * 31 + c`.
   *
   * The textbook string hash has almost no avalanche in its low bits, and the
   * hue is taken from exactly those. Claim ids share a timestamp prefix and
   * differ in their tail, so with `* 31` every claim minted in the same second
   * landed within a few degrees of every other one and the wall came out
   * monochrome — which was visible the first time more than one claim was on
   * screen together.
   */
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;

  const hue = (hash >>> 0) % 360;
  /*
   * Chroma varies a little with the hue, because a fixed chroma is not a fixed
   * *apparent* saturation: at oklch's yellows a given chroma reads far more
   * vivid than at its blues. A small counter-tilt keeps every tile looking
   * equally recessive, which is the point of deriving the colour at all.
   */
  const chroma = 0.04 + 0.014 * Math.cos(((hue - 250) * Math.PI) / 180);
  return `oklch(0.29 ${chroma.toFixed(3)} ${hue})`;
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
  cell: { x: number; y: number },
) {
  const at = cellToScreen(camera, view, cell.x, cell.y);
  ctx.fillStyle = "rgba(250,250,248,0.07)";
  rounded(ctx, at.x + 0.5, at.y + 0.5, size - 1, size - 1, size * RADIUS);
  ctx.fill();
}

/**
 * The rectangle being dragged.
 *
 * Drawn over everything including the claims it overlaps, because what it is
 * *about* to cost depends on what is under it, and a selection that disappears
 * behind an expensive logo hides exactly the information the buyer needs.
 */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
  rect: Rect,
) {
  const at = cellToScreen(camera, view, rect.x, rect.y);
  const w = rect.w * size;
  const h = rect.h * size;

  ctx.save();
  ctx.fillStyle = "rgba(250,250,248,0.08)";
  rounded(ctx, at.x, at.y, w, h, size * RADIUS);
  ctx.fill();

  /*
   * Dashed, in the same hand as the grid but at full strength.
   *
   * A solid marquee over a dashed lattice looks like a different tool arrived;
   * a longer dash at the same angle reads as the same pencil pressing harder.
   * The dash is longer than the grid's so the two are still distinguishable
   * where the selection sits directly on a gridline.
   */
  ctx.strokeStyle = "rgba(250,250,248,0.92)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  rounded(ctx, at.x + 1, at.y + 1, w - 2, h - 2, size * RADIUS);
  ctx.stroke();
  ctx.restore();
}

/** The wall's boundary. There is no more wall past this, ever, and that is the
 * product rather than a limitation to hide. */
function drawEdge(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
) {
  const at = cellToScreen(camera, view, 0, 0);
  ctx.save();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1.5;
  // The longest dash on the wall. The boundary is the one line that should read
  // as deliberate rather than as texture, and length is how a dashed stroke
  // says that without going solid.
  ctx.setLineDash([10, 6]);
  rounded(ctx, at.x, at.y, SIDE * size, SIDE * size, Math.min(size * RADIUS * 2, 14));
  ctx.stroke();
  ctx.restore();
}

/** Is this cell inside the dragged rectangle? Re-exported so the panel and the
 * canvas answer it the same way. */
export { contains };
