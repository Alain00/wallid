import { useEffect, useRef, useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { cn } from "@/lib/utils";
import { MAX_NAME } from "@/wall/limits";
import { areaOf, type Rect } from "@/wall/geometry";
import { money } from "@/wall/pricing";
import { checkout, priceOf, resolveArtwork } from "@/wall/source";

/**
 * Buying a rectangle.
 *
 * Docked right and vertically centred on a wide screen, a sheet on a narrow
 * one, and not a modal in either case: the wall behind stays pannable and
 * dismissing is a click on it. On desktop it has no ground of its own at all —
 * the scrim on the canvas is what separates this from the wall, so a card here
 * would be a second, redundant surface stacked on the first.
 *
 * Four things are asked for and two of them are required. The artwork is the
 * step this panel is really built around; see `resolve`.
 */

type Art = { key: string; source: string } | null;

export function BuyPanel({
  rect,
  onClose,
  onBought,
}: {
  rect: Rect;
  onClose: () => void;
  onBought: (claim: {
    rect: Rect;
    id: string;
    label: string;
    url: string;
    image: string | null;
    prices: number[];
  }) => void;
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
  const file = useRef<HTMLInputElement>(null);

  /* Escape closes, because the panel is dismissible and a dismissible thing
     that only closes by clicking a small ✕ is not really dismissible. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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
   * Fired on blur of the site field rather than behind its own button, because
   * the buyer has at that moment typed the only thing this needs, and asking
   * them to press "fetch my icon" is asking them to understand what a favicon
   * is. If it finds nothing they can still upload, and the failure is a line of
   * text rather than a blocked form.
   */
  const resolve = async (chosen?: File) => {
    if (!url.trim() && !chosen) return;
    setBusy("art");
    setError(null);
    const found = await resolveArtwork({ file: chosen, url, turnstile: turnstile.current });
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
        setLabel(
          new URL(url.startsWith("http") ? url : `https://${url}`).hostname
            .replace(/^www\./, "")
            .slice(0, MAX_NAME),
        );
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
  const ready = busy === null && url.trim() && label.trim() && total !== null;

  return (
    <div
      role="dialog"
      aria-label="Buy these cells"
      className={cn(
        "fixed z-30 flex flex-col gap-6",
        // A sheet on a phone. It takes what it needs and no more: with the
        // keyboard up there are a few hundred pixels of viewport left, and a
        // panel taller than that scrolls the page instead.
        "inset-x-0 bottom-0 max-h-[min(34rem,86svh)] overflow-y-auto overscroll-contain",
        "bg-ground/85 rounded-t-3xl p-6 backdrop-blur",
        // Docked and transparent on a wide one. The scrim on the canvas is
        // already doing the separating.
        "md:inset-x-auto md:top-1/2 md:right-12 md:bottom-auto md:w-[26rem] md:-translate-y-1/2",
        "md:max-h-none md:overflow-visible md:rounded-none md:bg-transparent md:p-0 md:backdrop-blur-none",
        "lg:right-16 lg:w-[28rem]",
      )}
    >
      <div>
        {/* The one hand-lettered voice on the site, at the size it earns.
            `text-balance` because it is two lines by design, and a lone word on
            the second is what makes hand lettering look like a font. */}
        <h2 className="text-ink font-hand text-4xl leading-[1.0] text-balance sm:text-5xl md:text-6xl">
          Nice spot.
        </h2>
        <p className="text-muted mt-2 font-mono text-sm">
          {rect.w} × {rect.h} · {cells} cell{cells === 1 ? "" : "s"} · {rect.x}, {rect.y}
        </p>
      </div>

      {/*
        The site, written on the wall rather than typed into a box.

        Dashed-underlined and sized to its own content, so it reads as something
        being written down rather than as data entry — and it is still an input,
        focusable by clicking the underline like any other.
      */}
      <Written
        id="wall-url"
        label="Your site"
        value={url}
        onChange={setUrl}
        onBlur={() => void resolve()}
        placeholder="acme.com"
        inputMode="url"
        autoFocus
        note={
          busy === "art"
            ? "looking for your icon…"
            : art?.source === "favicon"
              ? "found your icon"
              : "we will use the icon your site already has"
        }
      />

      <Written
        id="wall-label"
        label="Name"
        value={label}
        onChange={setLabel}
        placeholder="Acme"
        maxLength={MAX_NAME}
      />

      {/*
        The artwork, as a preview you can click rather than a file row.

        The tile is drawn at the same corner radius the canvas draws claims at,
        because it is showing the same thing — this is a preview of a cell, not
        a thumbnail in a form.
      */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => file.current?.click()}
          aria-label="Choose an image"
          className={cn(
            "size-16 shrink-0 overflow-hidden rounded-[0.7rem] border transition-colors duration-150",
            art ? "border-line/70" : "border-line hover:border-muted border-dashed",
          )}
        >
          {art ? (
            <img src={`/img/${art.key}`} alt="" className="size-full object-contain p-1.5" />
          ) : (
            <span className="text-muted/60 text-2xl leading-none">+</span>
          )}
        </button>
        <div className="min-w-0">
          <button
            onClick={() => file.current?.click()}
            className="text-ink/80 hover:text-ink border-line hover:border-muted border-b border-dashed pb-0.5 text-base transition-colors duration-150"
          >
            {art ? "use a different image" : "upload one instead"}
          </button>
          <p className="text-muted mt-1.5 text-sm">png, jpeg, webp or ico. up to 256 KB.</p>
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/x-icon"
          className="sr-only"
          onChange={event => {
            const chosen = event.target.files?.[0];
            if (chosen) void resolve(chosen);
          }}
        />
      </div>

      <Written
        id="wall-email"
        label="Email, to hear when someone takes it"
        value={email}
        onChange={setEmail}
        placeholder="you@acme.com"
        inputMode="email"
      />

      <Turnstile onToken={token => (turnstile.current = token ?? "")} />

      {error && <p className="text-[var(--color-warn)] text-base">{error}</p>}

      <div className="border-line/70 space-y-4 border-t border-dashed pt-5">
        {takeovers > 0 && (
          /* Said before the total, not after it. Taking cells is the mechanic,
             and a buyer who did not realise they were doing it is a buyer whose
             bank hears about it later. */
          <p className="text-muted text-base">
            {takeovers} of these is held by someone else. Buying takes{" "}
            {takeovers === 1 ? "it" : "them"}.
          </p>
        )}

        <div className="flex items-end justify-between gap-4">
          <span className="text-muted text-sm lowercase">total</span>
          <span className="text-ink font-hand text-4xl leading-none sm:text-5xl">
            {total === null ? "…" : money(total)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void pay()}
            disabled={!ready}
            className={cn(
              "bg-ink text-ground rounded-full px-5 py-2.5 text-sm lowercase",
              "transition-opacity duration-150 disabled:opacity-40",
            )}
          >
            {busy === "pay" ? "taking you to stripe…" : "buy these cells"}
          </button>
          <button
            onClick={onClose}
            className="border-line/70 text-ink/80 hover:text-ink hover:border-muted rounded-full border px-4 py-2.5 text-sm lowercase transition-colors duration-150"
          >
            never mind
          </button>
        </div>

        <p className="text-muted text-sm">
          Yours until somebody pays more. Nothing renews.{" "}
          <a className="hover:text-ink underline underline-offset-2" href="/rules">
            the rules
          </a>
          .
        </p>
      </div>
    </div>
  );
}

/**
 * A field that looks written rather than filled in.
 *
 * An invisible copy of the value carries the width, so the rule under it is
 * exactly as wide as what has been typed. `whitespace-pre` keeps a trailing
 * space measurable, without which the caret walks off the end of it.
 */
function Written({
  id,
  label,
  value,
  onChange,
  note,
  ...props
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  note?: string;
} & Omit<React.ComponentProps<"input">, "value" | "onChange" | "id">) {
  return (
    <div>
      <label htmlFor={id} className="text-muted block text-sm lowercase">
        {label}
      </label>
      <span
        className={cn(
          "mt-1 inline-grid max-w-full border-b border-dashed pb-0.5 transition-colors duration-200",
          "border-line hover:border-muted focus-within:border-ink",
        )}
      >
        <span
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 px-0.5 text-xl whitespace-pre"
        >
          {value || props.placeholder}
        </span>
        <input
          {...props}
          id={id}
          value={value}
          onChange={event => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          // `size={1}` is load-bearing: both elements share one grid cell, and
          // an input's default intrinsic width is about twenty characters,
          // which would set the column instead of the value.
          size={1}
          className={cn(
            "text-ink placeholder:text-muted/50 col-start-1 row-start-1 w-full",
            "min-w-0 bg-transparent px-0.5 text-xl outline-none",
          )}
        />
      </span>
      {note && <p className="text-muted mt-1.5 text-sm lowercase">{note}</p>}
    </div>
  );
}
