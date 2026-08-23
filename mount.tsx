/**
 * How every page attaches itself to its document.
 *
 * The stylesheet import and the hydrate-or-render branch were re-derived, and
 * re-commented, in each entry file. Both are load-bearing and neither is a
 * per-page decision, so a page module is one line and this is the only place
 * either fact is written down.
 */
import type { ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./styles.css";

// Nothing here injects an analytics script. Cloudflare Web Analytics is
// enabled on the zone and its beacon is inserted at the edge, so the measuring
// costs this bundle nothing and there is no token to keep in the repo.

/**
 * Renders `tree` into `#root`, hydrating if there is already markup there.
 *
 * The check is for markup rather than for a build flag or a manifest field,
 * because that is the thing that actually differs. `build.ts` prerenders the
 * pages whose manifest entry asks for it, so in production their markup is
 * already present and hydrating adopts it. The dev server has no prerender step
 * — it hands the document over as generated, with an empty root — and hydrating
 * that logs "server rendered HTML didn't match" on every reload. React recovers
 * by rendering client-side anyway, which is the right result reached by way of
 * an error message, and an error you are trained to ignore is worse than no
 * error at all.
 *
 * A page that is never prerendered takes the same branch for free.
 */
export function mount(tree: ReactNode) {
  const root = document.getElementById("root")!;
  if (root.firstChild) hydrateRoot(root, tree);
  else createRoot(root).render(tree);
}
