import { describe, expect, test } from "bun:test";
import { aspectOf, tileEdge } from "./raster";

/**
 * The aspect ratio is the half of rasterising that has no browser in it, and
 * the half that silently disfigures a logo when it is wrong: a square mark
 * fitted at 300x150 is the CSS default sizing showing through, which is exactly
 * what `img.naturalWidth` would have handed us.
 */
describe("aspectOf", () => {
  test("reads the viewBox, which is the only size most icons declare", () => {
    expect(aspectOf('<svg viewBox="0 0 24 24"/>')).toBe(1);
    expect(aspectOf('<svg viewBox="0 0 120 60"/>')).toBe(2);
    // Commas are legal separators, and a non-zero origin is not the size.
    expect(aspectOf('<svg viewBox="-10,-10,40,20"/>')).toBe(2);
  });

  test("falls back to explicit width and height", () => {
    expect(aspectOf('<svg width="200" height="100"/>')).toBe(2);
    expect(aspectOf('<svg width="200px" height="100px"/>')).toBe(2);
  });

  test("prefers the viewBox when a file carries both", () => {
    // The width/height on a favicon is frequently 16, and the viewBox is the
    // shape it was actually drawn in.
    expect(aspectOf('<svg width="16" height="16" viewBox="0 0 120 60"/>')).toBe(2);
  });

  test("guesses square rather than parsing a size that depends on a page", () => {
    expect(aspectOf('<svg width="100%" height="100%"/>')).toBe(1);
    expect(aspectOf('<svg width="10em" height="4em"/>')).toBe(1);
    expect(aspectOf("<svg/>")).toBe(1);
    expect(aspectOf("not markup at all")).toBe(1);
  });

  test("ignores a zero or negative box instead of dividing by it", () => {
    expect(aspectOf('<svg viewBox="0 0 0 0"/>')).toBe(1);
    expect(aspectOf('<svg viewBox="0 0 -4 2"/>')).toBe(1);
  });
});

/**
 * How many pixels a claim's artwork is worth.
 *
 * The number this replaces was a flat 320 — the most a single *cell* is drawn
 * at — which meant a 6x3 claim stored a 320px image and painted it across 1920
 * device pixels. That is the softness and banding a social preview showed on a
 * wide rectangle, and it was invisible on the 1x1 tiles it was designed for.
 */
describe("tileEdge", () => {
  test("a single cell keeps a favicon's worth of pixels", () => {
    expect(tileEdge({ w: 1, h: 1 })).toBe(320);
  });

  test("grows with the rectangle it will be painted across", () => {
    expect(tileEdge({ w: 3, h: 1 })).toBe(960);
    expect(tileEdge({ w: 2, h: 4 })).toBe(1280);
  });

  test("follows the long side, whichever it is", () => {
    expect(tileEdge({ w: 6, h: 1 })).toBe(tileEdge({ w: 1, h: 6 }));
  });

  test("stops before it asks for a file nobody can store", () => {
    // A 16x16 would want 5120px, which cannot be encoded under MAX_BYTES and is
    // read from far enough away not to need it.
    expect(tileEdge({ w: 16, h: 16 })).toBe(1536);
  });
});
