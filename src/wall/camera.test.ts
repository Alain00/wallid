import { describe, expect, test } from "bun:test";
import {
  CELL,
  cellToScreen,
  cellUnder,
  MAX_ZOOM,
  MIN_ZOOM,
  framing,
  moveBy,
  pinchTo,
  placeInFreeSpace,
  screenToCell,
  type Camera,
  type Viewport,
} from "./camera";

const view: Viewport = { width: 800, height: 600 };
const camera: Camera = { x: 64, y: 64, zoom: 1 };

/**
 * The one invariant that ties this file to `paint.ts`: a cell's coordinate is
 * the top-left corner of the square drawn for it. Pick and paint have to agree
 * about that or the pointer lights a tile next to the one it is over — which is
 * what `Math.round` in `cellUnder` did, half a cell out diagonally.
 */
test("every point inside a drawn tile picks that tile", () => {
  for (const zoom of [0.1, 0.5, 1, 2]) {
    const cam = { ...camera, zoom };
    const size = CELL * zoom;
    for (const target of [{ x: 64, y: 64 }, { x: 0, y: 0 }, { x: 70, y: 61 }]) {
      const corner = cellToScreen(cam, view, target.x, target.y);
      // The corner itself, and just inside the far edge of the same tile.
      for (const [dx, dy] of [[0.5, 0.5], [size - 0.5, 0.5], [0.5, size - 0.5], [size - 0.5, size - 0.5]]) {
        expect(cellUnder(cam, view, corner.x + dx!, corner.y + dy!)).toEqual(target);
      }
    }
  }
});

test("screen and cell space are inverses", () => {
  const at = cellToScreen(camera, view, 12.25, 90.5);
  const back = screenToCell(camera, view, at.x, at.y);
  expect(back.x).toBeCloseTo(12.25);
  expect(back.y).toBeCloseTo(90.5);
});

/**
 * The pan invariant: the point you took hold of stays under the cursor, at any
 * zoom and however far the gesture travels. This is what a drag *is*, and
 * accumulating per-event deltas only approximates it.
 */
test("a drag keeps the grabbed point under the cursor", () => {
  for (const zoom of [0.1, 0.7, 2]) {
    const cam = { ...camera, zoom };
    const grab = screenToCell(cam, view, 120, 340);
    for (const cursor of [{ x: 121, y: 341 }, { x: 700, y: 40 }, { x: 5, y: 590 }]) {
      const next = framing(view, grab, cursor, cam.zoom);
      const back = cellToScreen(next, view, grab.x, grab.y);
      expect(back.x).toBeCloseTo(cursor.x);
      expect(back.y).toBeCloseTo(cursor.y);
    }
  }
});

/** `moveBy` moves the camera the way it is pointed: positive x looks further
 * right, which slides the wall left. The sign was inverted at every caller. */
test("moveBy moves the camera, not the wall", () => {
  const moved = moveBy(camera, CELL, 0);
  expect(moved.x).toBeCloseTo(camera.x + 1);
  const at = cellToScreen(moved, view, camera.x, camera.y);
  expect(at.x).toBeCloseTo(view.width / 2 - CELL);
});

/**
 * Where a selection lands while the panel is open. Everything here is about the
 * one failure that matters: flying the buyer's rectangle to a spot the panel is
 * covering, which looks like the wall ignoring them.
 */
describe("placeInFreeSpace", () => {
  const rect = { x: 40, y: 40, w: 4, h: 4 };

  test("puts the rectangle beside a docked panel, not behind it", () => {
    const panel = { left: 500, top: 100, width: 300 };
    const camera = placeInFreeSpace(view, panel, rect);
    const centre = cellToScreen(camera, view, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(centre.x).toBeCloseTo(panel.left / 2);
    expect(centre.x).toBeLessThan(panel.left);
  });

  test("puts it above a phone sheet", () => {
    // A box spanning nearly the whole width is the sheet, whatever its height.
    const sheet = { left: 0, top: 380, width: view.width };
    const camera = placeInFreeSpace(view, sheet, rect);
    const centre = cellToScreen(camera, view, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(centre.y).toBeCloseTo(sheet.top / 2);
    expect(centre.y).toBeLessThan(sheet.top);
  });

  test("fits the rectangle into the free space at any size", () => {
    const panel = { left: 500, top: 0, width: 300 };
    for (const size of [1, 4, 16]) {
      const camera = placeInFreeSpace(view, panel, { x: 10, y: 10, w: size, h: size });
      const drawn = size * CELL * camera.zoom;
      // Inside the free strip, and — unless the zoom clamp got there first —
      // large enough to actually look at.
      expect(drawn).toBeLessThanOrEqual(panel.left);
      if (camera.zoom < MAX_ZOOM) expect(drawn).toBeGreaterThan(panel.left * 0.4);
    }
  });

  test("respects the zoom bounds", () => {
    const panel = { left: 500, top: 0, width: 300 };
    // A single cell would want 3x to fill the strip; the wall does not go there.
    expect(placeInFreeSpace(view, panel, { x: 0, y: 0, w: 1, h: 1 }).zoom).toBe(MAX_ZOOM);
    // The whole wall in a sliver would want far less than the floor.
    expect(placeInFreeSpace(view, panel, { x: 0, y: 0, w: 128, h: 128 }).zoom).toBe(MIN_ZOOM);
  });

  test("uses the whole viewport when nothing is in the way", () => {
    const camera = placeInFreeSpace(view, null, rect);
    const centre = cellToScreen(camera, view, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(centre.x).toBeCloseTo(view.width / 2);
    expect(centre.y).toBeCloseTo(view.height / 2);
  });

  test("survives a panel that covers almost everything", () => {
    // No zero-width free region, and therefore no infinite zoom.
    const camera = placeInFreeSpace(view, { left: 0, top: 0, width: view.width }, rect);
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(camera.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});

/**
 * The pinch, which is the only way to zoom on a phone and therefore the only
 * thing standing between a visitor and a wall they cannot read.
 */
describe("pinch", () => {
  const span = (dist: number, x: number, y: number) => ({ dist, at: { x, y } });

  test("spreading the fingers zooms in about their midpoint", () => {
    const at = { x: 300, y: 200 };
    const before = screenToCell(camera, view, at.x, at.y);
    const next = pinchTo(camera, view, span(100, at.x, at.y), span(200, at.x, at.y));

    expect(next.zoom).toBeCloseTo(camera.zoom * 2, 10);
    // Whatever was between the fingers is still between the fingers.
    const after = screenToCell(next, view, at.x, at.y);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  test("a hand that slides without spreading is a pan", () => {
    const next = pinchTo(camera, view, span(140, 300, 200), span(140, 380, 260));

    expect(next.zoom).toBe(camera.zoom);
    // The wall follows the hand, so the camera goes the other way.
    expect(next.x).toBeCloseTo(camera.x - 80 / (CELL * camera.zoom), 10);
    expect(next.y).toBeCloseTo(camera.y - 60 / (CELL * camera.zoom), 10);
  });

  test("spreading and sliding at once keeps the wall under the fingers", () => {
    const from = span(100, 300, 200);
    const to = span(160, 420, 250);
    const grabbed = screenToCell(camera, view, from.at.x, from.at.y);

    const next = pinchTo(camera, view, from, to);

    // The point the hand took hold of has travelled with the hand's midpoint.
    const landed = screenToCell(next, view, to.at.x, to.at.y);
    expect(landed.x).toBeCloseTo(grabbed.x, 10);
    expect(landed.y).toBeCloseTo(grabbed.y, 10);
  });

  test("the zoom clamps rather than running away", () => {
    const far = pinchTo({ ...camera, zoom: MAX_ZOOM }, view, span(50, 100, 100), span(5000, 100, 100));
    expect(far.zoom).toBe(MAX_ZOOM);

    const near = pinchTo({ ...camera, zoom: MIN_ZOOM }, view, span(5000, 100, 100), span(50, 100, 100));
    expect(near.zoom).toBe(MIN_ZOOM);
  });

  /* Two fingers landing on the same pixel, or the first move of a gesture with
   * nothing to compare against: a division that would send the camera to
   * infinity and the wall to nowhere. */
  test("a zero span leaves the camera alone", () => {
    expect(pinchTo(camera, view, span(0, 100, 100), span(120, 140, 90))).toEqual(camera);
    expect(pinchTo(camera, view, span(120, 100, 100), span(0, 140, 90))).toEqual(camera);
  });
});
