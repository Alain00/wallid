import { cell, chunksCovering, type Cell, type Chunk } from "./geometry";

/**
 * The wall's view of itself: where the camera is, and the arithmetic that turns
 * cells into pixels and pointers back into cells.
 *
 * Separate from `geometry.ts` on purpose. That file is the wall's rules and is
 * shared with the Worker, which has no viewport and no pixels; this one is the
 * client's alone. Nothing here may be needed to decide whether a placement is
 * legal, or the two would have to agree about screen sizes.
 */

/**
 * A cell's size in CSS pixels at 1x zoom.
 *
 * Also, transitively, a request-count decision: it is what makes a 32-cell
 * chunk ~2560px, which is what makes a viewport span two to four chunks. Moving
 * it moves the chunk arithmetic in ADR 0011 with it.
 */
export const CELL = 80;

/**
 * Zoom bounds. Out far enough to see the shape of the crowd and find the empty
 * quarter you want, in far enough to read a caption. Beyond either end the wall
 * stops being a wall: a field of dots, or one tile and nothing else.
 *
 * The floor was 0.45, and it was a cost decision that has twice stopped being
 * the right one.
 *
 * The original argument counted requests: a 4K viewport at 0.35 covers 137
 * cells, two dozen chunks in the worst alignment, and two dozen bodies full of
 * labels and prices to draw tiles whose captions cannot be read anyway. That
 * argument was about where those requests landed, and they landed in D1 once
 * per client, because nothing upstream caches a Response a Worker builds. They
 * land in the edge cache now (`cached`, in `worker/wall/index.ts`), and a chunk
 * nobody has ever written to is not asked for at all — so the worst alignment
 * is a bound on a full wall rather than a bill for an empty one.
 *
 * The second argument was legibility, and it put the floor at `SPRITE_ZOOM` —
 * 0.3, the last zoom that draws faces rather than colours. That was wrong about
 * what the far end is *for*. A field of flat discs is a poor way to look at
 * ninety cells and the only way to look at the whole board: the tiles stop
 * being failed faces and become the drawing. Which is what ADR 0011 wants an
 * overview tile for, and what the sprite path already renders below
 * `SPRITE_ZOOM` without one.
 *
 * So: 0.1. Eight pixels a cell, twenty times the wall on screen, and the LOD
 * that was written as a fallback doing the job it turns out to be good at.
 *
 * The thing that bounds this is `SPRITE_BUDGET` in `paint.ts`, and the risk is
 * not where it looks: the expensive zooms are the ones just *above*
 * the low end, where thousands of cells are on screen and every one of them
 * still wants a sprite. Below it they are rectangles. Measured against the
 * five-thousand fixture rather than the wall we have — see the handoff.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** Where the camera looks, in cell space, and how close. `x`/`y` are the cell
 * coordinates under the centre of the viewport, fractional between cells. */
export type Camera = { x: number; y: number; zoom: number };

/** The drawing surface, in CSS pixels. */
export type Viewport = { width: number; height: number };

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * One press of a zoom button.
 *
 * A ratio rather than a step, because zoom is multiplicative everywhere else in
 * this file — `zoomAt` multiplies, a pinch multiplies — and a constant *added*
 * to zoom would move the wall by a different amount at each end of the range.
 * 1.4 is about ten presses across the whole span now that the span is 0.1 to 2,
 * which is few enough to cross deliberately and many enough that no single
 * press throws away where you were looking.
 *
 * Here rather than in the buttons that spend it: it was a literal in
 * `WallSection`, written once as `1.4` and once as `1 / 1.4`. Two places to
 * change, and a pair that can quietly stop being each other's inverse — press
 * in, press out, and land somewhere that is not where you started.
 */
export const ZOOM_STEP = 1.4;

/** Cell space to screen space. The half-viewport is the camera's centre, so the
 * camera's own cell always lands in the middle whatever the zoom. */
export function cellToScreen(camera: Camera, view: Viewport, x: number, y: number) {
  const scale = CELL * camera.zoom;
  return {
    x: view.width / 2 + (x - camera.x) * scale,
    y: view.height / 2 + (y - camera.y) * scale,
  };
}

/** Screen space back to cell space, fractional. */
export function screenToCell(camera: Camera, view: Viewport, sx: number, sy: number) {
  const scale = CELL * camera.zoom;
  return {
    x: camera.x + (sx - view.width / 2) / scale,
    y: camera.y + (sy - view.height / 2) / scale,
  };
}

/**
 * The cell a pointer is over.
 *
 * `Math.round`, not `Math.floor`, because a cell is drawn centred on its own
 * integer coordinate rather than with its corner there — the wall reads as a
 * field of tiles, not as a spreadsheet, and centring is what
 * lets artwork sit inside its cell without belonging to the next one.
 */
export function cellUnder(camera: Camera, view: Viewport, sx: number, sy: number): Cell {
  const at = screenToCell(camera, view, sx, sy);
  return cell(Math.round(at.x), Math.round(at.y));
}

/**
 * The inclusive cell box on screen, widened by `margin` cells.
 *
 * The margin is not slack for rounding — it is the prefetch ring. Fetching the
 * cells just outside the viewport is what makes a pan reveal tiles already
 * drawn rather than a band of empty wall that fills in a beat later.
 */
export function visibleBox(camera: Camera, view: Viewport, margin = 0) {
  const min = screenToCell(camera, view, 0, 0);
  const max = screenToCell(camera, view, view.width, view.height);
  return {
    x0: Math.floor(min.x) - margin,
    y0: Math.floor(min.y) - margin,
    x1: Math.ceil(max.x) + margin,
    y1: Math.ceil(max.y) + margin,
  };
}

/** The chunks to have in hand for this view. One margin of cells by default, so
 * the request for a chunk goes out before its first cell is visible. */
export function chunksInView(camera: Camera, view: Viewport, margin = 4): Chunk[] {
  const box = visibleBox(camera, view, margin);
  return chunksCovering(box.x0, box.y0, box.x1, box.y1);
}

/**
 * The camera that puts `target` at a given point on screen.
 *
 * `flyTo` centres, which is right for "take me to my claim" and wrong for
 * the placement panel: the panel occupies one side of the viewport, so a cell
 * flown to the centre lands under it or beside it by luck. This composes the
 * flight's destination instead — the cell ends up where the interface has room
 * for it, and the arrow drawn from the panel to the cell has a predictable
 * length and direction rather than whatever the click happened to produce.
 *
 * `at` is in CSS pixels from the top-left of the surface, which is what a
 * layout measurement gives you.
 */
export function framing(view: Viewport, target: Cell, at: { x: number; y: number }, zoom: number): Camera {
  const scale = CELL * zoom;
  return {
    x: target.x - (at.x - view.width / 2) / scale,
    y: target.y - (at.y - view.height / 2) / scale,
    zoom,
  };
}

/** Dragging: pixels moved, translated into cells at the current zoom. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  const scale = CELL * camera.zoom;
  return { ...camera, x: camera.x - dx / scale, y: camera.y - dy / scale };
}

/**
 * Zoom about a screen point, keeping whatever is under it fixed there.
 *
 * Anchoring to the pointer rather than to the centre is the difference between
 * zooming *into* something and zooming and then having to chase it. Note that
 * the anchor is resolved before the zoom changes and re-placed after, which is
 * also what makes the clamp behave: at the limits the factor is absorbed and
 * the camera does not drift.
 */
export function zoomAt(camera: Camera, view: Viewport, factor: number, sx: number, sy: number): Camera {
  const before = screenToCell(camera, view, sx, sy);
  const zoom = clampZoom(camera.zoom * factor);
  const after = screenToCell({ ...camera, zoom }, view, sx, sy);
  return { x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y), zoom };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * How long a flight lasts. Fixed rather than proportional to distance: a
 * duration that grows with the traverse makes finding a far-off claim feel
 * like a punishment, and the zoom-out below is what absorbs the distance
 * instead.
 */
export const FLIGHT_MS = 700;

/**
 * How long a zoom press takes.
 *
 * Much shorter than a flight, because it is a different kind of motion. A
 * flight is travel and wants watching; a press is a control and wants to be
 * over. Long enough to see which way the wall went — a snap leaves you
 * re-reading a screen with no evidence it is the same one — and short enough
 * that four presses in a row feel like four presses rather than a queue.
 */
export const ZOOM_MS = 220;

/**
 * The camera partway through a flight, `t` from 0 to 1.
 *
 * Not a straight interpolation. Crossing a long stretch of wall at reading zoom
 * is a smear of tiles with no landmarks in it, so the camera pulls back as it
 * travels and comes back in on arrival — the same arc a map makes, and for the
 * same reason: the way out is what tells you where you went.
 *
 * The pull-back is scaled by how far there is to go, so a short hop does not
 * lurch backwards before moving. A flight between neighbours is very nearly the
 * straight interpolation it should be.
 */
export function flightAt(from: Camera, to: Camera, t: number): Camera {
  const clamped = Math.min(1, Math.max(0, t));
  // Exactly the endpoints, not a float's width away from them. The last frame
  // of a flight hands the camera back to the drag-and-wheel state it will keep
  // for the rest of the session, so `sin(PI)`'s 1.2e-16 would not round off —
  // it would be the zoom every subsequent gesture multiplies.
  if (clamped === 0) return { ...from };
  if (clamped === 1) return { ...to };
  const eased = easeInOut(clamped);
  const span = Math.hypot(to.x - from.x, to.y - from.y);

  // Zero below roughly a viewport's worth of travel, and saturating well before
  // the wall's likely extent — past a point, further away should not mean
  // further out, it should just mean longer in the same wide shot.
  const pull = Math.min(1, Math.max(0, (span - 12) / 60));
  const arc = 1 - pull * 0.55 * Math.sin(Math.PI * clamped);

  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    // Geometrically, not linearly. Zoom is a ratio — everything that sets it
    // multiplies — so the middle of the range 0.1 to 2 is 0.45, not 1.05.
    // Interpolated linearly, the far half of a long zoom-out crawls while the
    // near half snaps: the wall appears to stick, then let go.
    zoom: clampZoom(from.zoom * (to.zoom / from.zoom) ** eased * arc),
  };
}

/**
 * Where to pin the arrow that points at an off-screen cell, or `null` while the
 * cell is on screen and the arrow would be pointing at something already
 * visible.
 *
 * This is the discoverability half of the locate control: the arrow is what
 * tells a visitor their claim is still out there and in which direction, without
 * a line of copy saying so. The returned point is clamped to an inset rectangle
 * so the arrow sits inside the viewport rather than half off its edge.
 */
export function edgeMarker(
  camera: Camera,
  view: Viewport,
  target: Cell,
  inset = 28,
): { x: number; y: number; angle: number } | null {
  const at = cellToScreen(camera, view, target.x, target.y);
  const inside = at.x >= 0 && at.x <= view.width && at.y >= 0 && at.y <= view.height;
  if (inside) return null;

  return {
    x: Math.min(view.width - inset, Math.max(inset, at.x)),
    y: Math.min(view.height - inset, Math.max(inset, at.y)),
    angle: Math.atan2(at.y - view.height / 2, at.x - view.width / 2),
  };
}
