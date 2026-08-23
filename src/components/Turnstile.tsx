import { useEffect, useRef, useState } from "react";

/**
 * The challenge, as small as it is allowed to be.
 *
 * An IP limit alone does not stop anything determined, and the wall is
 * permanent, so the write path is guarded — but the guard sits inside a panel
 * whose whole job is to not read as a form. So it is rendered in Turnstile's
 * invisible-first mode: for almost everybody it resolves without a widget and
 * without a click, and it only becomes something to look at for the visitors
 * Cloudflare wants to interrupt.
 *
 * The script is loaded on demand rather than in the document head. It is a
 * third-party script on a landing page whose budget is measured in kilobytes,
 * and it is needed by the fraction of visitors who open the placement panel —
 * so it arrives when they do.
 */

/**
 * Cloudflare's documented always-passes site key.
 *
 * The default rather than a thrown error, because the pair to it is the test
 * *secret* in `.dev.vars.example`, and the two together are what make local
 * development exercise the real code path. A deployment that forgets to set
 * the real key therefore fails at the Worker — which refuses the write — rather
 * than here, which is the right end for that failure: fail closed, once.
 */
const TEST_KEY = "1x00000000000000000000AA";

/*
 * Guarded, and the guard is load-bearing rather than defensive style.
 *
 * `BUN_PUBLIC_*` values are inlined by the bundler only when they are actually
 * set; an unset one is left in the output as a literal `process.env.…`, and
 * `process` does not exist in a browser. So a deploy that simply forgot the
 * variable would not fall back to the test key — it would throw a
 * ReferenceError on the page the wall is on. Checked in the compiled bundle,
 * not the source, which is the only place the difference is visible.
 */
const SITE_KEY =
  (typeof process !== "undefined" && process.env.BUN_PUBLIC_TURNSTILE_SITE_KEY) || TEST_KEY;

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** One script tag however many widgets ask for it, and the same promise to
 * everybody who asks while it is still loading. */
let loading: Promise<Turnstile | null> | null = null;

function load(): Promise<Turnstile | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile | null>(resolve => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve(window.turnstile ?? null);
    // A blocked or failed script resolves `null` rather than hanging: the
    // placement is refused by the Worker either way, and a panel that never
    // answers is worse than one that says so.
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  return loading;
}

/**
 * Renders the challenge and hands its token up.
 *
 * `onToken(null)` on expiry, which is not a formality — a token is good for
 * five minutes and this panel can sit open for longer while somebody decides
 * on a name.
 */
export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let widget: string | null = null;
    let live = true;

    void load().then(turnstile => {
      if (!live || !hostRef.current) return;
      if (!turnstile) {
        setFailed(true);
        return;
      }
      widget = turnstile.render(hostRef.current, {
        sitekey: SITE_KEY,
        appearance: "interaction-only",
        size: "flexible",
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    });

    return () => {
      live = false;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [onToken]);

  return (
    <div>
      <div ref={hostRef} />
      {failed && (
        <p className="text-muted font-mono text-xs">
          the challenge could not load — a blocker, probably
        </p>
      )}
    </div>
  );
}
