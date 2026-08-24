#!/usr/bin/env bun
/**
 * Artwork for a wall of companies that do not exist.
 *
 * The showcase board used to be twenty-odd real logos, fetched live from the
 * real sites — which made it look right and made it somebody else's property.
 * A screenshot of this project is a screenshot of those marks, and none of them
 * were ours to put in a README.
 *
 * Replacing the names is the easy half. The hard half is that the *reason* the
 * board looked good was the media: a wall of `label on a coloured square` reads
 * as a placeholder, and the thing being shown off here is precisely how real
 * artwork sits in a rectangle. So the fictional brands get drawn rather than
 * described — each one an SVG built to the exact aspect of the tile it will
 * live in, rasterised by `sharp` and uploaded through the same
 * `/wall/artwork` route a buyer's PNG goes through.
 *
 * Drawn to the tile's aspect, deliberately. `paint.ts` contains artwork rather
 * than stretching it, so a square favicon in a 6x3 is a small mark with a lot
 * of mount around it — which is what the real board's favicons looked like, and
 * not what its og:images looked like. A brand whose art is 6x3 fills its 6x3.
 *
 * And every ground is flat and opaque to its own edge, which is not decoration:
 * `mount.ts` extends a flat edge colour over the whole tile, so the artwork and
 * its frame become one shape. A gradient falls back to hue-at-wall-lightness,
 * which is why the two gradient tiles here are the two that want a visible
 * frame around them.
 */

/*
 * The wall's own typeface, found where the app finds it.
 *
 * librsvg resolves font families through fontconfig, which knows about the
 * system's fonts and nothing about `node_modules`. Rather than hope the machine
 * running this has something Geist-shaped installed — and get DejaVu on the one
 * that does not — this writes a fontconfig file that adds the package's own
 * directory and inherits everything else, and points libvips at it before it
 * starts.
 *
 * Set before `sharp` is imported, since fontconfig is initialised once, on
 * first use, from the environment as it was.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FONT_DIR = resolve(
  dirname(Bun.resolveSync("geist/package.json", import.meta.dir)),
  "dist/fonts",
);
const FONT_STATE = resolve(import.meta.dir, "../.wrangler/state/fonts");

mkdirSync(FONT_STATE, { recursive: true });
writeFileSync(
  `${FONT_STATE}/fonts.conf`,
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <cachedir>${FONT_STATE}/cache</cachedir>
</fontconfig>
`,
);
process.env.FONTCONFIG_FILE = `${FONT_STATE}/fonts.conf`;

const { default: sharp } = await import("sharp");

/* ── the drawing surface ───────────────────────────────────────────────── */

/**
 * One cell is one hundred units.
 *
 * Every brand below is written against cells rather than pixels — a 6x3 tile is
 * a 600x300 viewBox — so the same drawing can be asked for at any size and the
 * proportions are the ones that were drawn. `orbit.dev` is on the board twice,
 * at 8x4 and at 4x4, and gets a wider window in the first without a second
 * drawing existing.
 */
const U = 100;

/** A brand: its ink on the wall, given the rectangle it has to fill. */
type Draw = (w: number, h: number) => string;

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w * U}" height="${h * U}" viewBox="0 0 ${w * U} ${h * U}">${body}</svg>`;

/** A flat ground, edge to edge. See the note about `mount.ts` above: this is
 * what makes a tile a tile rather than a picture with a border. */
const ground = (w: number, h: number, fill: string) =>
  `<rect width="${w * U}" height="${h * U}" fill="${fill}"/>`;

/**
 * Text, positioned by its middle rather than its baseline.
 *
 * `dominant-baseline` is the attribute for this and librsvg's support for it is
 * not something to bet twenty tiles on, so the baseline is computed: a little
 * over a third of the size below the centre puts the optical middle of a line
 * of Latin capitals where it was asked for.
 */
const text = (
  content: string,
  o: {
    x: number;
    y: number;
    size: number;
    fill: string;
    weight?: number;
    family?: string;
    tracking?: number;
    anchor?: "start" | "middle" | "end";
  },
) =>
  `<text x="${o.x}" y="${o.y + o.size * 0.355}" font-family="${o.family ?? "Geist"}" font-size="${o.size}"` +
  ` font-weight="${o.weight ?? 700}" fill="${o.fill}" text-anchor="${o.anchor ?? "middle"}"` +
  (o.tracking ? ` letter-spacing="${o.tracking}"` : "") +
  `>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;

/** A group scaled and centred so a glyph drawn in a unit box lands in the
 * middle of the tile at a chosen size. Glyph paths below are all written
 * against a 0..100 box, which makes them comparable and reusable. */
const glyph = (w: number, h: number, span: number, body: string) => {
  const size = Math.min(w, h) * U * span;
  return `<g transform="translate(${(w * U - size) / 2} ${(h * U - size) / 2}) scale(${size / 100})">${body}</g>`;
};

/** A rounded window inset into a tile — the shape every fake screenshot below
 * starts from. */
const card = (x: number, y: number, w: number, h: number, fill: string, r = 10, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${extra}/>`;

/** A row of rounded bars standing in for a line of code. Widths are given as
 * fractions of the space available, which keeps a fake editor looking like
 * prose at any window size. */
const codeLine = (
  x: number,
  y: number,
  unit: number,
  height: number,
  parts: [number, string][],
) => {
  let at = x;
  return parts
    .map(([span, fill]) => {
      const width = span * unit;
      const bar = `<rect x="${at}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}"/>`;
      at += width + unit * 0.35;
      return bar;
    })
    .join("");
};

/* ── the brands ────────────────────────────────────────────────────────── */

/**
 * Twenty-three companies, none of them real.
 *
 * Keyed by the domain the claim links to, which is also what its plate reads —
 * so the key is the brand. Each name is coined, and each was checked to be a
 * domain nobody is currently serving anything from: a fictional mark pointing
 * at somebody's real site would be a worse version of the problem this file
 * exists to solve. The varied endings are deliberate rather than decorative —
 * a board where every plate reads `.example` reads as a mock-up, and the thing
 * being shown off is what a real wall looks like.
 *
 * Each one also occupies the *visual* role its predecessor did. The board is a
 * composition, and swapping the black tile carrying one big glyph for a pale
 * card carrying a wordmark would fix the legal problem by breaking the picture.
 */
export const BRANDS: Record<string, Draw> = {
  /* — full-bleed marks: a flat ground and one white shape. The tiles that give
       the board its colour, and the ones `mount.ts` turns edge-to-edge. — */

  "galewind.net": (w, h) =>
    svg(w, h, ground(w, h, "#ff5f2e") + glyph(w, h, 0.62, `
      <g fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round">
        <path d="M6 32 H60 a12 12 0 1 0 -12 -12"/>
        <path d="M6 54 H76 a13 13 0 1 1 -13 13"/>
        <path d="M6 76 H48"/>
      </g>`)),

  "stoop.social": (w, h) =>
    svg(w, h, ground(w, h, "#0b0b0c") + glyph(w, h, 0.56, `
      <g transform="rotate(45 50 50)">
        <rect x="18" y="18" width="64" height="64" rx="10" fill="none" stroke="#fff" stroke-width="11"/>
      </g>
      <rect x="40" y="40" width="20" height="20" rx="5" fill="#fff"/>`)),

  "apex.sh": (w, h) =>
    svg(w, h, ground(w, h, "#08080a") + glyph(w, h, 0.6, `
      <path d="M10 72 L50 14 L90 72" fill="none" stroke="#fff" stroke-width="13"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M26 92 H74" stroke="#fff" stroke-width="13" stroke-linecap="round"/>`)),

  /* A slab, and the one highlight down its left face that makes it read as
     something standing up rather than as a black rectangle. */
  "basalt.build": (w, h) =>
    svg(w, h, ground(w, h, "#fcfcfb") + glyph(w, h, 0.62, `
      <path d="M36 4 h28 a7 7 0 0 1 7 7 v78 a7 7 0 0 1 -7 7 h-28 a7 7 0 0 1 -7 -7 v-78 a7 7 0 0 1 7 -7 z"
            fill="#101011"/>
      <path d="M42 12 V88" stroke="#4a4a4d" stroke-width="4" stroke-linecap="round"/>`)),

  "windkite.io": (w, h) =>
    svg(w, h, ground(w, h, "#8b46ff") + glyph(w, h, 0.6, `
      <path d="M50 4 L82 40 L50 74 L18 40 Z" fill="#fff"/>
      <path d="M18 40 H82 M50 4 V74" stroke="#8b46ff" stroke-width="4"/>
      <path d="M50 74 q9 8 0 15 q-9 7 0 13" fill="none" stroke="#fff" stroke-width="7"
            stroke-linecap="round"/>`)),

  "runeglass.ai": (w, h) =>
    svg(w, h, ground(w, h, "#08080a") + glyph(w, h, 0.62, `
      <g stroke="#fff" stroke-width="14" stroke-linecap="round" fill="none">
        <path d="M26 8 V92"/>
        <path d="M26 48 L76 8"/>
        <path d="M26 52 L78 92"/>
      </g>`)),

  "junipergrove.org": (w, h) =>
    svg(w, h, ground(w, h, "#08150f") + glyph(w, h, 0.34, `
      <path d="M50 6 L88 28 V72 L50 94 L12 72 V28 Z" fill="none" stroke="#7fd58a" stroke-width="9"
            stroke-linejoin="round"/>
      <circle cx="50" cy="50" r="12" fill="#7fd58a"/>`)),

  "knotly.app": (w, h) =>
    svg(w, h, ground(w, h, "#12b3a0") + glyph(w, h, 0.66, `
      <g fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round">
        <path d="M22 34 a18 18 0 1 0 0 32 q28 -16 56 -32 a18 18 0 1 1 0 32 q-28 -16 -56 -32"/>
      </g>`)),

  "spool.dev": (w, h) =>
    svg(w, h, ground(w, h, "#2f86c4") + glyph(w, h, 0.66, `
      <rect x="18" y="14" width="64" height="16" rx="8" fill="#fff"/>
      <rect x="18" y="70" width="64" height="16" rx="8" fill="#fff"/>
      <rect x="34" y="28" width="32" height="44" fill="#fff"/>
      <g stroke="#2f86c4" stroke-width="5" stroke-linecap="round">
        <path d="M38 38 H62"/><path d="M38 50 H62"/><path d="M38 62 H62"/>
      </g>`)),

  "ottercove.land": (w, h) =>
    svg(w, h, ground(w, h, "#121214") + glyph(w, h, 0.74, `
      <circle cx="27" cy="31" r="10" fill="#fff"/>
      <circle cx="73" cy="31" r="10" fill="#fff"/>
      <ellipse cx="50" cy="57" rx="32" ry="29" fill="#fff"/>
      <circle cx="39" cy="51" r="4.5" fill="#121214"/>
      <circle cx="61" cy="51" r="4.5" fill="#121214"/>
      <ellipse cx="50" cy="67" rx="11" ry="8" fill="#121214"/>
      <g stroke="#121214" stroke-width="2.5" stroke-linecap="round">
        <path d="M28 66 H38"/><path d="M62 66 H72"/>
      </g>`)),

  /* — wordmarks: the tiles that carry a name rather than a shape. — */

  "q7.codes": (w, h) =>
    svg(w, h, ground(w, h, "#0a0a0a") +
      text("Q7", { x: (w * U) / 2, y: (h * U) / 2, size: Math.min(w, h) * U * 0.44, fill: "#fff", weight: 800, tracking: -2 })),

  "tollhouse.build": (w, h) =>
    svg(w, h, ground(w, h, "#4f4fd9") +
      text("tollhouse", { x: (w * U) / 2, y: (h * U) / 2, size: Math.min(w * U * 0.19, h * U * 0.44), fill: "#fff", weight: 700, tracking: -1 })),

  "stratus.cloud": (w, h) => {
    const size = Math.min(w * U * 0.2, h * U * 0.36);
    const mid = (h * U) / 2;
    return svg(w, h, ground(w, h, "#132433") +
      text("stratus", { x: (w * U) / 2, y: mid - size * 0.16, size, fill: "#fff", weight: 700, tracking: -1 }) +
      `<path d="M${(w * U) / 2 - size * 1.25} ${mid + size * 0.72} q${size * 1.25} ${size * 0.5} ${size * 2.5} 0"
             fill="none" stroke="#f4a24a" stroke-width="${size * 0.13}" stroke-linecap="round"/>`);
  },

  /* A lantern above its own name, drawn large enough to be a mark rather than
     a decoration on one — this tile is four cells across and a small glyph in
     the middle of it would read as a mistake. */
  "lanternhouse.ai": (w, h) => {
    const size = Math.min(w * U * 0.3, h * U * 0.34);
    const mid = (h * U) / 2;
    return svg(w, h, ground(w, h, "#f0e9dd") +
      `<g transform="translate(${(w * U - size) / 2} ${mid - size * 1.15}) scale(${size / 100})">
         <circle cx="50" cy="55" r="30" fill="#f6dcbb"/>
         <g fill="none" stroke="#8c3f22" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
           <path d="M50 2 V13"/>
           <path d="M30 22 h40 l-4 -9 h-32 z"/>
           <path d="M26 90 h48 l-5 -10 h-38 z"/>
           <path d="M34 22 V80"/><path d="M66 22 V80"/>
         </g>
         <path d="M50 36 q13 12 13 22 a13 13 0 0 1 -26 0 q0 -10 13 -22 z" fill="#e0813f"/>
       </g>` +
      text("Lanternhouse", { x: (w * U) / 2, y: mid + size * 0.72, size: size * 0.3, fill: "#2a231c", weight: 600, tracking: -0.5 }));
  },

  "quadranth.com": (w, h) => {
    const side = Math.min(w * U, h * U) * 0.3;
    const gap = side * 0.14;
    const left = (w * U - side * 2 - gap) / 2;
    const top = (h * U - side * 2 - gap) / 2;
    const tile = (dx: number, dy: number, fill: string) =>
      `<rect x="${left + dx * (side + gap)}" y="${top + dy * (side + gap)}" width="${side}" height="${side}" rx="${side * 0.18}" fill="${fill}"/>`;
    return svg(w, h, ground(w, h, "#26261a") +
      tile(0, 0, "#3fb8a0") + tile(1, 0, "#f0a63c") + tile(0, 1, "#e4587a") + tile(1, 1, "#8b6ff0"));
  },
};

/* — the previews: tiles that are a picture of a product rather than a mark.
     These are the ones a wide rectangle was invented for, and the reason the
     board bothers with `og` at all. — */

Object.assign(BRANDS, {
  /* A garden trellis rather than a hatch pattern: few battens, wide gaps, and
     the dark card showing through them. Drawn dense it stops being a lattice
     and becomes a texture, which is a different and much louder tile. */
  "trelliswork.dev": (w: number, h: number) => {
    const pad = Math.min(w, h) * U * 0.09;
    const inner = { w: w * U - pad * 2, h: h * U - pad * 2 };
    const radius = Math.min(w, h) * U * 0.06;
    const step = inner.w / 3.2;
    const battens: string[] = [];
    for (let i = -3; i < 6; i++) {
      const x = pad + i * step;
      battens.push(
        `<path d="M${x} ${pad + inner.h} L${x + inner.h} ${pad}" stroke="#ff5c7a" stroke-width="${step * 0.08}" stroke-linecap="round"/>`,
        `<path d="M${x} ${pad} L${x + inner.h} ${pad + inner.h}" stroke="#ff8fa4" stroke-width="${step * 0.08}" stroke-linecap="round" opacity="0.5"/>`,
      );
    }
    return svg(w, h,
      ground(w, h, "#f2e7ea") +
      card(pad, pad, inner.w, inner.h, "#16161a", radius) +
      `<g clip-path="url(#trellis-clip)">${battens.join("")}</g>` +
      `<defs><clipPath id="trellis-clip"><rect x="${pad}" y="${pad}" width="${inner.w}" height="${inner.h}" rx="${radius}"/></clipPath></defs>`);
  },

  "mochi.sh": (w: number, h: number) =>
    svg(w, h, ground(w, h, "#fbefdc") + glyph(w, h, 0.74, `
      <ellipse cx="50" cy="56" rx="40" ry="34" fill="#fffdf8" stroke="#e6d6ba" stroke-width="3"/>
      <ellipse cx="30" cy="64" rx="8" ry="5" fill="#f6b3ad"/>
      <ellipse cx="70" cy="64" rx="8" ry="5" fill="#f6b3ad"/>
      <ellipse cx="38" cy="50" rx="4.5" ry="6" fill="#3c3227"/>
      <ellipse cx="62" cy="50" rx="4.5" ry="6" fill="#3c3227"/>
      <path d="M42 64 q8 7 16 0" fill="none" stroke="#3c3227" stroke-width="4" stroke-linecap="round"/>`)),

  "parleyworks.ai": (w: number, h: number) => {
    const pad = Math.min(w, h) * U * 0.1;
    const inner = { w: w * U - pad * 2, h: h * U - pad * 2 };
    return svg(w, h,
      `<defs><linearGradient id="parley-g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#8ed8ff"/><stop offset="0.55" stop-color="#b9a4ff"/><stop offset="1" stop-color="#ffb0d0"/>
       </linearGradient></defs>` +
      ground(w, h, "#0d1424") +
      card(pad, pad, inner.w, inner.h, "url(#parley-g)", inner.h * 0.16) +
      card(pad + inner.w * 0.12, pad + inner.h * 0.36, inner.w * 0.76, inner.h * 0.28, "#ffffff", inner.h * 0.14) +
      text("Parley", { x: (w * U) / 2, y: pad + inner.h * 0.5, size: inner.h * 0.17, fill: "#1a1a2e", weight: 600, tracking: -0.5 }));
  },

  "studiolo.dev": (w: number, h: number) => {
    const pad = Math.min(w, h) * U * 0.11;
    const inner = { w: w * U - pad * 2, h: h * U - pad * 2 };
    const line = inner.h * 0.055;
    const unit = inner.w * 0.1;
    const rows = [
      [[1.1, "#7aa2f7"], [2.0, "#c0caf5"]],
      [[0.7, "#bb9af7"], [1.6, "#9ece6a"], [0.9, "#c0caf5"]],
      [[1.5, "#c0caf5"], [1.0, "#e0af68"]],
      [[0.8, "#7aa2f7"], [2.4, "#565f89"]],
    ] as [number, string][][];
    return svg(w, h,
      ground(w, h, "#d7e3f4") +
      card(pad, pad, inner.w, inner.h, "#1a1b26", inner.h * 0.09) +
      card(pad, pad, inner.w, inner.h * 0.16, "#24283b", inner.h * 0.09) +
      card(pad, pad + inner.h * 0.1, inner.w * 0.22, inner.h * 0.06, "#24283b", 0) +
      `<g>${[0, 1, 2].map(i => `<circle cx="${pad + inner.w * (0.07 + i * 0.06)}" cy="${pad + inner.h * 0.08}" r="${inner.h * 0.022}" fill="#565f89"/>`).join("")}</g>` +
      rows.map((parts, i) =>
        codeLine(pad + inner.w * 0.08 + (i === 1 || i === 2 ? inner.w * 0.07 : 0), pad + inner.h * (0.28 + i * 0.15), unit, line, parts)).join("") +
      card(pad + inner.w * 0.62, pad + inner.h * 0.62, inner.w * 0.3, inner.h * 0.06, "#7aa2f7", inner.h * 0.03));
  },

  "orbitary.dev": (w: number, h: number) => {
    const pad = Math.min(w, h) * U * 0.07;
    const inner = { w: w * U - pad * 2, h: h * U - pad * 2 };
    const line = inner.h * 0.045;
    const unit = inner.w * 0.055;
    const rows = [
      [[1.6, "#d4d4d8"], [1.1, "#8ac6a0"]],
      [[0.9, "#c4a2e8"], [2.2, "#d9b48f"]],
      [[2.0, "#8fb6e0"], [0.8, "#d4d4d8"]],
      [[1.2, "#d9b48f"], [1.5, "#6f7076"]],
      [[0.8, "#c4a2e8"], [1.9, "#d4d4d8"], [0.7, "#8ac6a0"]],
    ] as [number, string][][];
    return svg(w, h,
      ground(w, h, "#e9ecf1") +
      card(pad, pad, inner.w, inner.h, "#191a1f", inner.h * 0.07) +
      card(pad, pad, inner.w, inner.h * 0.13, "#232429", inner.h * 0.07) +
      card(pad, pad + inner.h * 0.08, inner.w, inner.h * 0.05, "#232429", 0) +
      `<g>${[0, 1, 2].map(i => `<circle cx="${pad + inner.w * (0.035 + i * 0.03)}" cy="${pad + inner.h * 0.065}" r="${inner.h * 0.018}" fill="#4a4b52"/>`).join("")}</g>` +
      card(pad, pad + inner.h * 0.13, inner.w * 0.16, inner.h * 0.87, "#141519", 0) +
      rows.map((parts, i) =>
        codeLine(pad + inner.w * 0.2 + (i === 1 || i === 3 ? inner.w * 0.04 : 0), pad + inner.h * (0.24 + i * 0.13), unit, line, parts)).join("") +
      /* The palette floating over the buffer: the one thing every editor's own
         screenshot has in it, and what makes this read as a product rather
         than as a rectangle of coloured bars. */
      card(pad + inner.w * 0.34, pad + inner.h * 0.52, inner.w * 0.52, inner.h * 0.36, "#2b2c33", inner.h * 0.05,
        ` stroke="#3a3b44" stroke-width="${inner.h * 0.008}"`) +
      card(pad + inner.w * 0.37, pad + inner.h * 0.58, inner.w * 0.34, line, "#7d7e88", line / 2) +
      card(pad + inner.w * 0.37, pad + inner.h * 0.68, inner.w * 0.46, line, "#4d4e58", line / 2) +
      card(pad + inner.w * 0.37, pad + inner.h * 0.77, inner.w * 0.28, line, "#4d4e58", line / 2));
  },

  "quayside.dev": (w: number, h: number) => {
    const size = Math.min(w * U * 0.072, h * U * 0.15);
    return svg(w, h,
      `<defs><linearGradient id="quayside-g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#3b1e8f"/><stop offset="0.5" stop-color="#7c3aed"/><stop offset="1" stop-color="#c084fc"/>
       </linearGradient></defs>` +
      ground(w, h, "#3b1e8f") +
      `<rect width="${w * U}" height="${h * U}" fill="url(#quayside-g)"/>` +
      `<g fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="${size * 0.14}">
         <circle cx="${w * U * 0.86}" cy="${h * U * 0.18}" r="${size * 1.5}"/>
         <circle cx="${w * U * 0.12}" cy="${h * U * 0.88}" r="${size * 2.2}"/>
       </g>` +
      text("Ship from anywhere,", { x: w * U * 0.08, y: h * U * 0.4, size, fill: "#fff", weight: 700, anchor: "start", tracking: -size * 0.03 }) +
      text("together.", { x: w * U * 0.08, y: h * U * 0.4 + size * 1.3, size, fill: "#fff", weight: 700, anchor: "start", tracking: -size * 0.03 }) +
      text("quayside.dev", { x: w * U * 0.08, y: h * U * 0.82, size: size * 0.55, fill: "#e9d5ff", weight: 500, anchor: "start", tracking: size * 0.05 }));
  },

  "glyph.dev": (w: number, h: number) => {
    const size = Math.min(w, h) * U * 0.13;
    return svg(w, h,
      `<defs><linearGradient id="glyph-g" x1="0" y1="1" x2="0.8" y2="0">
         <stop offset="0" stop-color="#0b2f33"/><stop offset="0.55" stop-color="#1f6f74"/><stop offset="1" stop-color="#f0a35e"/>
       </linearGradient></defs>` +
      ground(w, h, "#0b2f33") +
      `<rect width="${w * U}" height="${h * U}" fill="url(#glyph-g)"/>` +
      `<g transform="translate(${(w * U) / 2} ${h * U * 0.42})">
         <circle r="${size * 1.05}" fill="none" stroke="#fff" stroke-width="${size * 0.13}"/>
         <ellipse rx="${size * 0.42}" ry="${size * 1.05}" fill="none" stroke="#fff" stroke-width="${size * 0.13}"/>
         <path d="M${-size * 1.05} 0 H${size * 1.05}" stroke="#fff" stroke-width="${size * 0.13}"/>
       </g>` +
      text("GLYPH", { x: (w * U) / 2, y: h * U * 0.74, size: size * 0.78, fill: "#fff", weight: 600, tracking: size * 0.3 }));
  },

  /* The one drawing on the board, and the tile that stops it being a row of
     logos. A wall wants something on it that nobody could have fetched. */
  "koan.institute": (w: number, h: number) => {
    const pad = Math.min(w, h) * U * 0.06;
    const inner = { w: w * U - pad * 2, h: h * U - pad * 2 };
    const cx = (w * U) / 2;
    const cy = pad + inner.h * 0.44;
    const r = Math.min(inner.w, inner.h) * 0.3;
    const rule = Array.from({ length: 4 }, (_, i) =>
      `<path d="M${cx - r * (1.15 - i * 0.16)} ${pad + inner.h * (0.74 + i * 0.045)} H${cx + r * (1.15 - i * 0.16)}" stroke="#111" stroke-width="${r * 0.028}"/>`).join("");
    return svg(w, h,
      ground(w, h, "#fbfbf9") +
      `<rect x="${pad}" y="${pad}" width="${inner.w}" height="${inner.h}" fill="none" stroke="#111" stroke-width="${pad * 0.42}"/>` +
      /* An ensō: one stroke, opened at the top right, thinning as it closes. */
      `<path d="M${cx + r * 0.62} ${cy - r * 0.72} a${r} ${r} 0 1 0 ${r * 0.2} ${r * 0.42}"
             fill="none" stroke="#111" stroke-width="${r * 0.19}" stroke-linecap="round"/>` +
      rule +
      text("KOAN", { x: cx, y: pad + inner.h * 0.93, size: r * 0.28, fill: "#111", weight: 600, tracking: r * 0.1 }));
  },
});

/* ── to bytes ──────────────────────────────────────────────────────────── */

/**
 * How large a drawing is asked for.
 *
 * A cell is drawn at up to 80px and upscaled when somebody zooms in, so the
 * long side is the number that matters and 960 of it is comfortably past what
 * any of these tiles will be shown at. The clamp is what keeps a 1x1 from being
 * asked for at 960 and an 8x4 from being asked for at 8x320: small tiles get
 * enough pixels to survive a zoom, large ones stop before the PNG is bigger
 * than `MAX_BYTES` for no visible gain.
 */
function cellPixels(w: number, h: number): number {
  return Math.round(Math.min(320, Math.max(128, 960 / Math.max(w, h))));
}

/** Whether this domain is one of ours to draw. Everything else on a board is
 * still fetched from the site it names — see `artworkFor` in `board.ts`. */
export const isFictional = (domain: string): boolean => domain in BRANDS;

/**
 * A brand, drawn to fill a `w` by `h` rectangle, as PNG bytes.
 *
 * Rasterised here rather than handed over as SVG, because the wall does not
 * store vectors: `artwork.ts` refuses them into the bucket and bounces them to
 * the browser to be redrawn, and this script has no canvas. `sharp` is the
 * canvas — a development dependency for a development board, not something the
 * Worker ever loads.
 */
export async function drawBrand(domain: string, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const draw = BRANDS[domain];
  if (!draw) throw new Error(`no such brand: ${domain}`);

  const pixels = cellPixels(w, h);
  const source = Buffer.from(draw(w, h));
  const png = await sharp(source, { density: (pixels / U) * 96 })
    .resize(w * pixels, h * pixels, { fit: "fill" })
    // The wall's tiles are opaque and `mount.ts` reads the artwork's edge to
    // colour the frame; an alpha channel here would only give it something
    // transparent to average.
    .flatten({ background: "#000000" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(png);
}

/* Run directly to look at them: `bun scripts/brands.ts [dir]`. A contact sheet
 * is the only way to tell whether twenty-three tiles read as twenty-three
 * companies or as one designer's afternoon. */
if (import.meta.main) {
  const out = process.argv[2] ?? ".wrangler/state/brands";
  mkdirSync(out, { recursive: true });
  const board = (await Bun.file(`${import.meta.dir}/board.json`).json()) as {
    label: string;
    w: number;
    h: number;
  }[];
  const sizes = new Map(board.map(claim => [claim.label, [claim.w, claim.h] as const]));
  for (const domain of Object.keys(BRANDS)) {
    const [w, h] = sizes.get(domain) ?? [3, 3];
    const bytes = await drawBrand(domain, w, h);
    await Bun.write(`${out}/${domain}.png`, bytes);
    console.log(`  ${domain.padEnd(20)} ${w}x${h}  ${(bytes.byteLength / 1024).toFixed(1)} KB`);
  }
  console.log(`\n  ${Object.keys(BRANDS).length} brands → ${out}`);
}
