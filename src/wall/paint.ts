import { claimedCells, type ChunkBody, type ClaimEntry } from "./chunk";
import { CELL, cellToScreen, visibleBox, type Camera, type Viewport } from "./camera";
import { SIDE, cellsIn, contains, type Rect } from "./geometry";
import { NEUTRAL, mountFor } from "./mount";

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
 * Loaded artwork and the mount sampled from it, keyed by its R2 key.
 *
 * Keys are content hashes, so two claims using the same logo share one entry,
 * and an entry can never be stale — the bytes under a key are the key. Which is
 * also what makes the mount worth caching here rather than recomputing: the
 * colour is a property of the bytes, so it is right for every claim that ever
 * uses them and it can never need invalidating.
 *
 * `null` marks an image that failed to load, which is not the same as one that
 * has not been asked for yet. Without that distinction a broken image is
 * requested again on every single frame.
 */
type Sprite = { image: HTMLImageElement; mount: string | null };
type Sprites = Map<string, Sprite | null>;

export const createSprites = (): Sprites => new Map();

/**
 * The size the artwork is sampled at.
 *
 * Small on purpose. The question is "what colour is this", and the browser's
 * own downscale answers it better than reading a 320px image would — it is a
 * box filter in C, it runs once per image ever, and 24 across still leaves an
 * edge ring of 92 pixels to judge flatness from.
 */
const SAMPLE = 24;

/**
 * The mount for an image, sampled once, or `null` if it cannot be read.
 *
 * `null` rather than a thrown error: a tainted canvas is the one failure that
 * can happen here and it is not worth a broken tile. It should not happen —
 * `/img/` is same-origin and `crossOrigin` is set below — but a browser that
 * disagrees gets the id-derived colour instead of a blank cell.
 */
function sample(image: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    return mountFor({ data, width: SAMPLE, height: SAMPLE });
  } catch {
    return null;
  }
}

function spriteFor(sprites: Sprites, key: string, onLoad: () => void): Sprite | null {
  const held = sprites.get(key);
  if (held !== undefined) return held;

  const image = new Image();
  // Set before `src`, or the request is already in flight under the wrong mode
  // and the canvas is tainted by the time it lands — which would cost the
  // mount, since sampling reads the pixels back out.
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.onload = () => {
    // Sampled here rather than at draw time: once per image, off the frame
    // path, and the redraw this triggers is the one that will use it.
    sprites.set(key, { image, mount: sample(image) });
    onLoad();
  };
  image.onerror = () => sprites.set(key, null);
  image.src = `/img/${key}`;
  const entry = { image, mount: null };
  sprites.set(key, entry);
  return entry;
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
  /**
   * The claim being filled in right now, drawn in the rectangle it would
   * occupy.
   *
   * Not a mock-up of one. It goes through `drawClaim` like anything else, so
   * what the buyer is looking at while they choose between their icon and their
   * preview image is the renderer that will draw them tomorrow — same mount
   * sampling, same contain-not-stretch fit, same address plate. A preview
   * drawn by a second code path is a promise the wall has to keep twice.
   */
  draft?: { rect: Rect; claim: ClaimEntry } | null;
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
  draft,
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

  /*
   * The draft, over the claims it would take.
   *
   * Last of the claims and over all of them, because that is what buying it
   * would do: these cells belong to somebody else until the payment lands, and
   * a preview that drew *under* them would be showing the buyer a rectangle
   * they cannot have.
   */
  if (draft) {
    drawClaim(ctx, camera, view, size, draft.claim, cellsIn(draft.rect), sprites, onLoad);
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

/**
 * The hairline that separates one claim from the next.
 *
 * Applied only where a claim's cell has no sibling across that edge, which is
 * the difference between a gap that means "two different buyers" and a gap that
 * means nothing. It used to be applied on all four edges of every cell, so a
 * 6x6 claim was drawn as thirty-six tiles with a lattice cut through the middle
 * of its own artwork — a logo sliced into squares, with the wall's ground
 * showing through the cuts and taking parts of the image with it.
 */
const SEAM = 0.5;

/**
 * The outline of everything a claim still holds, as one region.
 *
 * The shape is a polyomino, not a rectangle: cells get taken out of the middle
 * of a claim and the artwork has to keep drawing around the hole. So it is
 * still built cell by cell — but each cell contributes a rect that *abuts* its
 * siblings and only pulls back from its non-siblings, and the four corner radii
 * are set per corner rather than per cell.
 *
 * The two rules, and they are the whole function:
 *
 *   - an edge with a sibling across it is extended, not inset, so neighbouring
 *     subpaths overlap and the union has no seam to antialias;
 *   - a corner is rounded only where both of its edges are exposed, which is
 *     exactly the convex corners of the silhouette. An interior corner stays
 *     square, so four cells meeting in a block read as one surface rather than
 *     as four circles kissing.
 *
 * So a claim is one soft-cornered shape whatever its footprint. What this does
 * *not* round is the concave corners around a hole where cells have been taken:
 * `roundRect` cannot cut an arc into a shape, and the outline arithmetic that
 * could is not worth it here — a hole exists only because somebody else bought
 * those cells, and their claim draws its own soft-cornered tile over the top of
 * it. The square corner is behind another tile by construction.
 */
export function claimPath(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  view: Viewport,
  size: number,
  cells: { x: number; y: number }[],
  seam = SEAM,
) {
  const held = new Set(cells.map(cell => `${cell.x},${cell.y}`));
  const has = (x: number, y: number) => held.has(`${x},${y}`);

  ctx.beginPath();
  for (const cell of cells) {
    const at = cellToScreen(camera, view, cell.x, cell.y);
    const left = has(cell.x - 1, cell.y);
    const right = has(cell.x + 1, cell.y);
    const above = has(cell.x, cell.y - 1);
    const below = has(cell.x, cell.y + 1);

    // A sibling's edge is crossed rather than met, so the union of the subpaths
    // has no hairline down it.
    const x0 = at.x + (left ? -seam : seam);
    const y0 = at.y + (above ? -seam : seam);
    const x1 = at.x + size + (right ? seam : -seam);
    const y1 = at.y + size + (below ? seam : -seam);

    const radius = Math.min(size * RADIUS, (x1 - x0) / 2, (y1 - y0) / 2);
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, [
      !above && !left ? radius : 0,
      !above && !right ? radius : 0,
      !below && !right ? radius : 0,
      !below && !left ? radius : 0,
    ]);
  }
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
   * The silhouette, not the cells inside it: see `claimPath`.
   */
  claimPath(ctx, camera, view, size, cells);
  ctx.clip();

  const sprite = claim.image ? spriteFor(sprites, claim.image, onLoad) : null;
  const art = sprite?.image;

  /*
   * The mount: the artwork's own, if it has been sampled.
   *
   * The id-derived colour is still what a claim with no artwork gets — there is
   * no image there to clash with, and a wall of label tiles is exactly where a
   * hash-to-hue keeps the board looking like a board. Artwork that has not
   * finished loading gets the neutral rather than the hash, so a tile does not
   * flash a random colour on its way to its real one.
   */
  const mount = claim.image
    ? (sprite?.mount ?? NEUTRAL)
    : // A draft carries no id, and it is not a claim yet: the hash-to-hue would
      // be inventing an identity for something that does not have one, and the
      // colour would change the instant it were bought.
      claim.id
      ? groundFor(claim.id)
      : NEUTRAL;

  if (art && art.complete && art.naturalWidth > 0) {
    /*
     * Contained, not stretched.
     *
     * A favicon is square and a logo is usually not, and a wall that stretches
     * whatever it is handed to fill a rectangle makes every wide logo look
     * wrong in a way its owner will email about. Fitted inside, centred, with
     * the claim's own ground behind it so the letterboxing reads as a tile
     * rather than as a gap.
     */
    ctx.fillStyle = mount;
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
    const scale = Math.min(inner.w / art.naturalWidth, inner.h / art.naturalHeight);
    const w = art.naturalWidth * scale;
    const h = art.naturalHeight * scale;
    // A favicon is 32px being drawn at up to 160, so the browser's smoothing is
    // doing real work here rather than being a default nobody chose.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(art, corner.x + (width - w) / 2, corner.y + (height - h) / 2, w, h);
  } else {
    /*
     * No artwork, or it has not loaded yet: the label on its own ground.
     *
     * Not a spinner and not a blank. A claim with a broken image is still a
     * claim somebody paid for, and it has to be legible as one — this is also
     * what a moderated claim draws as, since hiding blanks the image and the
     * label together and leaves the ground.
     */
    ctx.fillStyle = mount;
    ctx.fillRect(corner.x, corner.y, width, height);

    if (claim.label && size > 24) {
      /*
       * No re-clip any more.
       *
       * There used to be one here, because the tile clip cut a gutter between
       * every pair of cells and a word crossing one was sliced into "se d1"
       * rather than "seed1". `claimPath` no longer cuts those gutters, so the
       * text is drawn through the same clip as the artwork — which is what it
       * always should have been: one surface, one mask.
       */

      ctx.fillStyle = "rgba(250,250,248,0.82)";
      ctx.font = `500 ${Math.min(size * 0.26, 17)}px Geist, ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(claim.label.slice(0, 14), corner.x + width / 2, corner.y + height / 2, width - 8);
    }
  }

  /*
   * Over the artwork, inside the same clip: the plate belongs to this claim and
   * must not spill onto the tile next door.
   *
   * Positioned from the cells the claim still *holds*, not from its rectangle.
   * The two are the same thing until somebody buys a cell out of the middle of
   * a claim, and then they are not: the rectangle keeps its original corner,
   * the clip does not, and a plate drawn at that corner is sliced in half by a
   * mask it is sitting outside — or vanishes into a neighbour's tile entirely.
   * It read as the tile next door overpainting this one's label, which is what
   * sent me looking at the draw order first. The draw order was fine.
   */
  if (art && art.complete && art.naturalWidth > 0) {
    const room = plateRoom(cells);
    drawAddress(
      ctx,
      cellToScreen(camera, view, room.x, room.y),
      room.w * size,
      room.h * size,
      claim.url,
    );
  }

  ctx.restore();
}

/**
 * Where a claim's address plate can sit: the largest clear rectangle at its
 * top-left, in cells.
 *
 * A claim is a set of cells rather than a rectangle — that is the whole reason
 * `claimPath` exists — and a plate is a rectangle, so this finds one that is
 * genuinely inside the shape. The topmost row, the first unbroken run along it,
 * and then how far that run's left-hand column continues downward. Whatever
 * comes back is solid: every cell of it is held.
 *
 * The top-left of the *silhouette*, so a claim whose original corner was bought
 * out from under it captions itself at the corner it has left rather than at
 * the one it remembers. On an untouched claim this returns the rectangle
 * itself, which is why nothing about a full tile changes.
 */
export function plateRoom(cells: { x: number; y: number }[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (!cells.length) return { x: 0, y: 0, w: 0, h: 0 };

  const held = new Set(cells.map(cell => `${cell.x},${cell.y}`));
  const top = Math.min(...cells.map(cell => cell.y));
  const x = Math.min(...cells.filter(cell => cell.y === top).map(cell => cell.x));

  let w = 0;
  while (held.has(`${x + w},${top}`)) w += 1;

  // The depth of the run's left column, not of the whole run: the plate is
  // anchored there, and a column that stops short is what would put its bottom
  // edge outside the shape.
  let h = 0;
  while (held.has(`${x},${top + h}`)) h += 1;

  return { x, y: top, w, h };
}

/**
 * The address, on the tile.
 *
 * A logo is not always enough. Half the marks on this wall are a letterform or
 * an abstract shape, and a visitor looking at one has no way to know whose it
 * is without hovering — which on a board whose whole product is *being seen* is
 * the wrong default. So the hostname goes on the tile itself.
 *
 * Top-left, and on a plate.
 *
 * Top-left because that is where a caption is looked for and because it is the
 * corner artwork is least likely to be using — a contained logo sits centred,
 * so the corners are the mount. On a plate because the thing behind it is
 * arbitrary: somebody's screenshot, a photograph, a white wordmark. Text alone
 * would be legible on most tiles and invisible on some, and "some" is not good
 * enough for the one piece of information a buyer is paying to have read.
 *
 * Drawn only when it can be read. Below about a hundred pixels of claim the
 * plate is wider than the tile and covers the artwork it is captioning, which
 * is worse than saying nothing — the hover plate already answers this at any
 * zoom, and this is the version for when there is room.
 */
export function drawAddress(
  ctx: CanvasRenderingContext2D,
  corner: { x: number; y: number },
  width: number,
  height: number,
  url: string,
): boolean {
  /* Whether it drew, so a caller — and a test — can tell "no room" apart from
   * "drawn". Three ways out of this function say nothing, and they used to be
   * indistinguishable from success. */
  if (width < 104 || height < 44) return false;

  let host = url;
  try {
    // The bare-domain form too, because a draft is drawn from what the buyer
    // has typed so far and `acme.com` is what people type. A stored claim's URL
    // has already been through `normaliseUrl` and takes the first branch.
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, "");
  } catch {
    return false;
  }
  if (!host.includes(".")) return false;

  const pad = Math.min(width, height) * 0.07;
  const fontSize = Math.max(10, Math.min(13, width * 0.075));
  ctx.font = `500 ${fontSize}px Geist, ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // Trimmed to what fits rather than clipped mid-glyph: a truncated host with
  // an ellipsis is still a name, where half a letter is a smudge.
  const room = width - pad * 2 - fontSize;
  if (ctx.measureText(host).width > room) {
    while (host.length > 4 && ctx.measureText(`${host}…`).width > room) host = host.slice(0, -1);
    host = `${host}…`;
  }

  const textWidth = ctx.measureText(host).width;
  const plateHeight = fontSize * 1.85;
  const plateWidth = textWidth + fontSize * 1.1;

  // The same translucent-dark-and-rounded chip the interface uses everywhere
  // else, so the wall and the controls over it are speaking one language.
  ctx.fillStyle = "rgba(10,10,11,0.72)";
  rounded(ctx, corner.x + pad, corner.y + pad, plateWidth, plateHeight, plateHeight / 2);
  ctx.fill();

  ctx.fillStyle = "rgba(250,250,248,0.92)";
  ctx.fillText(host, corner.x + pad + fontSize * 0.55, corner.y + pad + plateHeight / 2);
  return true;
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
