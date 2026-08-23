import { useEffect, useRef, useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { MAX_NAME } from "@/wall/limits";
import { areaOf, type Rect } from "@/wall/geometry";
import { money } from "@/wall/pricing";
import { checkout, priceOf, resolveArtwork } from "@/wall/source";

/**
 * Buying a rectangle.
 *
 * Four things are asked for and only two of them are required: where (already
 * chosen, by dragging), what it links to, what it is called, and what it looks
 * like. The artwork is the step this panel is really built around — see
 * `resolve` below.
 */

type Art = { key: string; source: string } | null;

export function BuyPanel({
  rect,
  onClose,
  onBought,
}: {
  rect: Rect;
  onClose: () => void;
  onBought: (claim: { rect: Rect; id: string; label: string; url: string; image: string | null; prices: number[] }) => void;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [art, setArt] = useState<Art>(null);
  const [busy, setBusy] = useState<"art" | "pay" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [takeovers, setTakeovers] = useState(0);
  const turnstile = useRef<string>("");

  /*
   * The price, from the server that will charge it.
   *
   * The canvas already showed a figure while the rectangle was being dragged,
   * computed from the chunks the client holds. This asks again, because between
   * the drag and the card somebody else may have bought into the rectangle, and
   * the number beside a Pay button has to be the one the checkout is built on.
   */
  useEffect(() => {
    let live = true;
    void priceOf(rect).then(priced => {
      if (!live || !priced) return;
      setTotal(priced.totalCents);
      setTakeovers(priced.takeovers);
    });
    return () => {
      live = false;
    };
  }, [rect]);

  /*
   * The artwork, resolved from whatever the buyer has already given us.
   *
   * Fired on blur of the URL field rather than behind its own button, because
   * the buyer has at that moment typed the only thing this needs and asking
   * them to press "fetch my icon" is asking them to understand what a favicon
   * is. If it finds nothing they can still upload, and the failure is a line of
   * text rather than a blocked form.
   */
  const resolve = async (file?: File) => {
    if (!url.trim() && !file) return;
    setBusy("art");
    setError(null);
    const found = await resolveArtwork({ file, url, turnstile: turnstile.current });
    setBusy(null);
    if ("error" in found) {
      setArt(null);
      setError(found.error);
      return;
    }
    setArt(found);
    // A domain is a better default name than an empty field, and it is what
    // most buyers would have typed anyway.
    if (!label.trim() && url.trim()) {
      try {
        setLabel(new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").slice(0, MAX_NAME));
      } catch {
        // A URL that will not parse is one the server is about to refuse with a
        // sentence of its own. Nothing to do here.
      }
    }
  };

  const pay = async () => {
    setBusy("pay");
    setError(null);
    const priced = await priceOf(rect);
    const result = await checkout({
      rect,
      label,
      url,
      image: art?.key ?? null,
      imageSource: art?.source,
      email: email || null,
      turnstile: turnstile.current,
    });
    setBusy(null);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    // Drawn before the redirect, so the wall the buyer comes back to already
    // has them on it. The webhook is what makes it true; this is what makes it
    // feel true.
    onBought({
      rect,
      id: result.claimId,
      label,
      url,
      image: art?.key ?? null,
      prices: priced?.cells.map(cell => cell.priceCents) ?? [],
    });
    window.location.href = result.url;
  };

  const cells = areaOf(rect);

  return (
    <aside className="fixed inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col gap-5 overflow-y-auto border-l border-line bg-raised p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-hand text-3xl">Nice spot.</h2>
          <p className="text-sm text-muted">
            {rect.w} × {rect.h}, {cells} cell{cells === 1 ? "" : "s"}, at ({rect.x}, {rect.y})
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink">
          ✕
        </button>
      </header>

      <Field label="Your site">
        <input
          value={url}
          onChange={event => setUrl(event.target.value)}
          onBlur={() => void resolve()}
          placeholder="acme.com"
          inputMode="url"
          className="w-full rounded-md border border-line bg-ground px-3 py-2 outline-none focus-visible:border-ink"
        />
        <p className="text-xs text-muted">
          {busy === "art"
            ? "Looking for your icon…"
            : art?.source === "favicon"
              ? "Found your icon. Upload a different one if you would rather."
              : "We will use the icon your site already has."}
        </p>
      </Field>

      <Field label="Name">
        <input
          value={label}
          maxLength={MAX_NAME}
          onChange={event => setLabel(event.target.value)}
          placeholder="Acme"
          className="w-full rounded-md border border-line bg-ground px-3 py-2 outline-none focus-visible:border-ink"
        />
      </Field>

      <Field label="Artwork">
        <div className="flex items-center gap-3">
          {art ? (
            <img src={`/img/${art.key}`} alt="" className="h-12 w-12 rounded-md border border-line object-contain" />
          ) : (
            <div className="h-12 w-12 rounded-md border border-dashed border-line" />
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/x-icon"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void resolve(file);
            }}
            className="text-xs text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-ground file:px-3 file:py-1.5 file:text-ink"
          />
        </div>
        <p className="text-xs text-muted">PNG, JPEG, WebP or ICO. Up to 256 KB. No SVG, no GIF.</p>
      </Field>

      <Field label="Email, if you want to know when someone takes it">
        <input
          value={email}
          onChange={event => setEmail(event.target.value)}
          placeholder="you@acme.com"
          inputMode="email"
          className="w-full rounded-md border border-line bg-ground px-3 py-2 outline-none focus-visible:border-ink"
        />
      </Field>

      <Turnstile onToken={token => (turnstile.current = token ?? "")} />

      {error && <p className="text-sm text-[oklch(0.72_0.16_25)]">{error}</p>}

      <div className="mt-auto space-y-3 border-t border-line pt-4">
        {takeovers > 0 && (
          /* Said before the total, not after it. Taking cells is the mechanic,
             and a buyer who did not realise they were doing it is a buyer whose
             bank hears about it later. */
          <p className="text-sm text-muted">
            {takeovers} of these cell{takeovers === 1 ? " is" : "s are"} held by someone else. Buying
            takes {takeovers === 1 ? "it" : "them"} from {takeovers === 1 ? "them" : "their owners"}.
          </p>
        )}
        <div className="flex items-baseline justify-between">
          <span className="text-muted">Total</span>
          <span className="font-mono text-2xl">{total === null ? "…" : money(total)}</span>
        </div>
        <button
          onClick={() => void pay()}
          disabled={busy !== null || !url.trim() || !label.trim() || total === null}
          className="w-full rounded-md bg-ink px-4 py-3 font-medium text-ground disabled:opacity-40"
        >
          {busy === "pay" ? "Taking you to Stripe…" : "Buy these cells"}
        </button>
        <p className="text-xs text-muted">
          Cells are yours until somebody pays more. Nothing here is a subscription and nothing
          renews. <a className="underline" href="/rules">The rules</a>.
        </p>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}
