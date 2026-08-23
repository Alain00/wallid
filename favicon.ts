/**
 * The favicon, generated rather than committed.
 *
 * A cell. That is the whole mark: one square of the wall, drawn at the same
 * proportions the canvas draws them at, on the same near-black ground. A wall
 * whose icon is a wall in miniature is a tab you can find without reading it,
 * and there is nothing else this site is about.
 *
 * Generated at build time because it is four numbers that must agree with
 * `styles.css`, and a committed SVG is four numbers that quietly stop agreeing.
 */
const GROUND = "#0a0a0b";
const INK = "#fafaf8";

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${GROUND}"/>
  <g fill="none" stroke="${INK}" stroke-opacity="0.28" stroke-width="1">
    <path d="M11.5 6.5v19M16.5 6.5v19M21.5 6.5v19M6.5 11.5h19M6.5 16.5h19M6.5 21.5h19"/>
  </g>
  <rect x="6" y="6" width="20" height="20" rx="2" fill="none" stroke="${INK}" stroke-opacity="0.5"/>
  <rect x="12" y="12" width="10" height="10" rx="1.5" fill="${INK}"/>
</svg>
`;

export async function writeFavicon() {
  await Bun.write("favicon.svg", FAVICON);
}
