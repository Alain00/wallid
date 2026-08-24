/**
 * What the client and the Worker must agree about a name.
 *
 * The same arrangement as `geometry.ts`, for the same reason: the field caps
 * what you can type and the Worker refuses what it is sent, and if those two
 * numbers ever disagree the interface either truncates a name the wall would
 * have accepted or offers one it will refuse after the fact. One constant, two
 * importers.
 *
 * Only the cap lives here. The charset and the blocklist stay on the server —
 * they are refusals a client cannot usefully pre-empt (the blocklist is not in
 * the repo at all), and a name that fails them comes back as a sentence rather
 * than as a disabled button.
 */

/**
 * In code points, not UTF-16 units.
 *
 * 24 is a layout number before it is a policy one: it is what the hover plate
 * was drawn against, and it truncates at 22. The charset now accepts letters
 * and marks in any script, so 24 code points of Devanagari is a much wider
 * plate than 24 of Latin — see the handoff's open decisions.
 */
export const MAX_NAME = 24;

/**
 * What a claim's artwork may weigh, in bytes.
 *
 * Here rather than in the Worker because both ends need it now: the Worker
 * refuses anything heavier, and the browser — which is what redraws an SVG or
 * an oversized preview into something storable — has to aim *under* it. A
 * client that encoded to 400 KB and a server that accepted 256 KB would fail
 * after the upload rather than before it, which on the buying path is a
 * spinner that ends in a sentence about bytes.
 *
 * 256 KB is generous for a logo and mean for anything trying to use this wall
 * as image hosting.
 */
export const MAX_BYTES = 256 * 1024;
