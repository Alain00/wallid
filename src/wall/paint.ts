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
 */
const GRID = "rgba(255,255,255,0.055)";
const GROUND = "#0a0a0b";

/** The wall's own edge. Bounded is the product, so the boundary is drawn rather
 * than merely enforced: you should be able to see that the board ends. */
const EDGE = "rgba(255,255,255,0.22)";

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
  // Below about six pixels a cell the lines are closer together than they are
  // wide, and the grid stops reading as a grid and starts reading as fog.
  if (size < 6) return;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
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
  for (const cell of cells) {
    const at = cellToScreen(camera, view, cell.x, cell.y);
    ctx.rect(at.x, at.y, size + 1, size + 1);
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

    const scale = Math.min(width / sprite.naturalWidth, height / sprite.naturalHeight);
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
      ctx.fillStyle = "rgba(250,250,248,0.82)";
      ctx.font = `600 ${Math.min(size * 0.28, 18)}px Geist, system-ui, sans-serif`;
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
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `oklch(0.28 0.045 ${Math.abs(hash) % 360})`;
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
  cell: { x: number; y: number },
) {
  const at = cellToScreen(camera, view, cell.x, cell.y);
  ctx.fillStyle = "rgba(250,250,248,0.09)";
  ctx.fillRect(at.x, at.y, size, size);
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
  ctx.fillStyle = "rgba(250,250,248,0.10)";
  ctx.fillRect(at.x, at.y, w, h);
  ctx.strokeStyle = "#fafaf8";
  ctx.lineWidth = 2;
  ctx.strokeRect(at.x + 1, at.y + 1, w - 2, h - 2);
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
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(at.x, at.y, SIDE * size, SIDE * size);
}

/** Is this cell inside the dragged rectangle? Re-exported so the panel and the
 * canvas answer it the same way. */
export { contains };
