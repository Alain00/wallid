import { useEffect, useRef, useState } from "react";

/**
 * `false` until the element is near the viewport, `true` from then on.
 *
 * This keeps the page's two heaviest illustrations — the wall's field and the
 * chat demo, about seventy inline SVGs between them — out of both the
 * prerendered HTML and the work that immediately follows hydration.
 *
 * Out of the HTML because prerendering that markup makes the document big
 * enough to cost an extra round trip on the way to first paint, and because the
 * wall's field is built from `Math.random()`, which cannot survive hydration.
 *
 * Out of the post-hydration burst because of what that window is: Total
 * Blocking Time measures the main thread *between first paint and
 * interactive*. A prerendered page paints early, so anything rendered on mount
 * lands squarely inside it — the same work that used to hide before first paint
 * on a client-rendered page, now counted. Waiting for the scroll puts it back
 * where it belongs, which is also when someone is going to look at it.
 *
 * The margin is modest on purpose. A full viewport of it sounds generous and is
 * self-defeating: the wall begins about a screen down, so a screen of margin
 * makes it intersect at rest and the work lands at load again, which is the
 * thing being avoided. Note that on a short viewport the wall's top edge can be
 * on screen at rest regardless — this is a saving where the fold allows one,
 * not a guarantee, and the wall's cost is addressed at its source in
 * `motion.css`.
 *
 * Without `IntersectionObserver` — no supported browser lacks it, but the
 * prerender runs in Bun — it resolves to `true` and everything renders at once,
 * which is the old behaviour and still correct.
 */
export function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        // One-way: once it has rendered there is nothing to gain by tearing it
        // back down, and the wall in particular would reshuffle if it did.
        if (entries.some(e => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, near] as const;
}
