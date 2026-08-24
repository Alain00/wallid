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
 * Read straight, with no `typeof process` around it — and that is the whole
 * point of this comment, because the guard that used to be here is what put
 * production on the test key for an afternoon.
 *
 * It was written to stop a `ReferenceError` if the variable were never set. But
 * `env: "BUN_PUBLIC_*"` in `build.ts` substitutes the *value* and leaves the
 * guard alone, so the compiled expression was
 *
 *   typeof process < "u" && "0x4AAA…" || "1x0000…"
 *
 * and in a browser `typeof process` is `"undefined"`, so the whole thing
 * collapsed to the test key. The real key was right there in the bundle,
 * inlined, next to the branch that threw it away — which is why grepping the
 * bundle for it said everything was fine.
 *
 * The `ReferenceError` it was defending against cannot happen now: `build.ts`
 * defines this key unconditionally, so it is always a literal by the time it
 * reaches a browser.
 */
/*
 * Development is always the test pair, whatever `.env` says.
 *
 * The two halves of Turnstile have to match: a token minted by the real *site*
 * key only verifies against the real *secret*. `.env` is read at build time and
 * carries the production site key; `.dev.vars` carries the secret and falls
 * back to Cloudflare's always-passes test one when it has none. A machine set
 * up for production therefore has a real key on the client and a test secret on
 * the server — and every write fails with "could not verify you are human",
 * which names neither half and sounds like the visitor's fault.
 *
 * The real key would not have worked on localhost anyway: the widget is scoped
 * to the hostnames it was created for, and `localhost` is not one of them.
 *
 * `process.env.NODE_ENV` is substituted with a literal by `build.ts`, so a
 * production bundle contains `"production" !== "production"` and the branch
 * disappears — the shipped page cannot reach the test key by any route. That
 * matters more than it looks: this file's other long comment is about the
 * afternoon production spent on the test key.
 */
const SITE_KEY =
  process.env.NODE_ENV !== "production" ? TEST_KEY : process.env.BUN_PUBLIC_TURNSTILE_SITE_KEY || TEST_KEY;

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
