import { useCallback, useEffect, useRef, useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { cn } from "@/lib/utils";
import { domainOf, nameOf } from "@/wall/domain";
import { MAX_NAME } from "@/wall/limits";
import { areaOf, type Rect } from "@/wall/geometry";
import { money } from "@/wall/pricing";
import * as god from "@/wall/god";
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

/**
 * How long the site field waits after the last keystroke before it goes and
 * looks.
 *
 * Long enough that finishing `.com` and carrying on to `/pricing` is one fetch
 * rather than two, short enough that it lands while the buyer is still looking
 * at the field it came from. The guard that matters is not this number but
 * `domainOf`: nothing is fetched until what has been typed is already an
 * address, so the timer never runs on a prefix.
 */
const TYPING_MS = 500;

export function BuyPanel({
  rect,
  onClose,
  onDraft,
  onBox,
  onBought,
  god: godMode = false,
}: {
  rect: Rect;
  onClose: () => void;
  /**
   * What the wall should be drawing behind this panel, as it is filled in.
   *
   * Reported upward rather than drawn here, because the thing that can draw it
   * properly is the canvas — and a preview rendered by the panel would be a
   * second implementation of the tile, agreeing with the real one only for as
   * long as somebody remembered to keep them in step.
   */
  onDraft: (draft: { label: string; url: string; image: string | null }) => void;
  /**
   * Where this panel actually is, so the wall can put the buyer's rectangle
   * somewhere it is not.
   *
   * Measured and reported rather than assumed. The panel is a sheet on a phone
   * and a docked column on a desktop, at breakpoints written as Tailwind
   * classes a few lines below — and a copy of those numbers in the canvas would
   * be a second source of truth that goes wrong the first time somebody widens
   * the column. `null` when it is gone.
   */
  onBox: (box: DOMRect | null) => void;
  onBought: (claim: {
    rect: Rect;
    id: string;
    label: string;
    url: string;
    image: string | null;
    prices: number[];
  }) => void;
  /**
   * Place the claim instead of selling it. Development only — see
   * `src/wall/god.ts`; in a production build this is a constant `false` and
   * everything behind it is removed by the bundler.
   *
   * The panel is otherwise unchanged, deliberately: the artwork step, the
   * label check and the price all still run, so what a god-mode wall is full of
   * is what a bought wall would look like. Only the card is missing.
   */
  god?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [art, setArt] = useState<Art>(null);
  /* Which of the two pictures of their site is showing. Held rather than read
     off `art`, because the toggle has to look right during the fetch — and
     because a failed switch leaves the old artwork on screen while the buyer's
     choice has already moved. */
  const [source, setSource] = useState<"favicon" | "og">("favicon");
  /* What each `want` resolved to, so flipping between them is instant and
     costs the buyer's own server nothing on the second look. */
  const seen = useRef<{ favicon?: NonNullable<Art>; og?: NonNullable<Art> }>({});
  /* The `host|want` pair the last fetch was for. Both the typing timer and the
     blur read it, so an address that has already been looked at is not looked
     at again when the buyer tabs out of the field — including when the look
     came back empty, which is the case that would otherwise re-run a failure. */
  const asked = useRef<string>("");
  const [busy, setBusy] = useState<"art" | "pay" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [takeovers, setTakeovers] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  /*
   * The Turnstile token, and the wait for it.
   *
   * A ref alone was a race, and production is where it showed: the challenge is
   * invisible and takes a moment to resolve, while the artwork fetch now fires
   * *as the address is typed*. Lose that race and the panel posts an empty
   * token, the Worker refuses before it ever asks Cloudflare, and the buyer is
   * told they could not be verified as human — for a check that had not
   * finished running.
   *
   * Invisible locally, because `.dev.vars` carries Cloudflare's test key and a
   * test key answers instantly. There is no version of this that a local run
   * would have caught.
   *
   * So: everything guarded waits for the token rather than reading whatever is
   * there. Only the first call ever waits — after that the Worker's pass
   * carries the rest of the flow.
   */
  const turnstile = useRef<string>("");
  const waiting = useRef<((token: string) => void)[]>([]);

  const receiveToken = useCallback((token: string | null) => {
    turnstile.current = token ?? "";
    // An expiry hands back `null`, and nothing is owed to a waiter then — the
    // widget re-solves on its own and the next token wakes them.
    if (token) waiting.current.splice(0).forEach(resolve => resolve(token));
  }, []);

  /**
   * The token, once there is one.
   *
   * The timeout resolves with whatever is held rather than rejecting: an empty
   * string still reaches the Worker and still comes back as one honest
   * sentence, which is a better failure than a panel that hangs on a script
   * some visitor's extension has blocked.
   */
  const withToken = useCallback(
    (ms = 10_000) =>
      turnstile.current
        ? Promise.resolve(turnstile.current)
        : new Promise<string>(resolve => {
            waiting.current.push(resolve);
            setTimeout(() => resolve(turnstile.current), ms);
          }),
    [],
  );
  /* Issued by the artwork step, spent by whatever guarded call comes next. A
     Turnstile token is redeemed once, and resolving artwork redeems it — so
     without this, paying afterwards is a 403. See `allowed` in the Worker. */
  const pass = useRef<string>("");
  /* `resolve` closes over this render's state, and the typing timer must call
     the current one rather than the one alive when the timer was set. */
  const latest = useRef<(want?: "favicon" | "og") => Promise<void>>(null!);

  /* The panel's own box, on mount and whenever the layout moves it — a
     breakpoint crossing, a phone rotating, the sheet growing as fields fill. */
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const report = () => onBox(element.getBoundingClientRect());
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onBox(null);
    };
  }, [onBox]);

  /* The wall draws what this panel knows, as soon as it knows it. Three fields
     rather than the whole form: these are the only ones that reach the tile. */
  useEffect(() => {
    onDraft({ label, url, image: art?.key ?? null });
  }, [label, url, art?.key, onDraft]);

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
   * is. If it finds nothing the failure is a line of text rather than a blocked
   * form: a claim with no artwork is drawn as its name, which is a tile.
   */
  const resolve = async (want: "favicon" | "og" = "favicon") => {
    if (!url.trim()) return;
    // Already fetched this one: switching back to it is free, so the toggle
    // does not make the buyer wait for an answer we are holding.
    const remembered = seen.current[want];
    if (remembered) {
      const host = domainOf(url);
      if (host) asked.current = `${host}|${want}`;
      setSource(want);
      setArt(remembered);
      setError(null);
      return;
    }

    setBusy("art");
    setError(null);
    const host = domainOf(url);
    if (host) asked.current = `${host}|${want}`;
    const found = await resolveArtwork({
      url,
      want,
      rect,
      turnstile: await withToken(),
      pass: pass.current,
    });
    setBusy(null);
    if ("error" in found) {
      // The artwork already on screen survives a failed *switch*: asking for a
      // preview a site does not have should not take away the icon it does.
      if (art) {
        setError(found.error);
        return;
      }
      setArt(null);
      setError(found.error);
      return;
    }
    if (found.pass) pass.current = found.pass;
    seen.current[want] = found;
    setSource(want);
    setArt(found);
    // A domain is a better default name than an empty field, and it is what
    // most buyers would have typed anyway.
    if (!label.trim() && host) setLabel(nameOf(host, MAX_NAME));
  };
  latest.current = resolve;

  /*
   * The same step again, without waiting for the buyer to leave the field.
   *
   * Blur is a fine trigger and a late one: on a form this short the buyer often
   * types their domain and goes straight to the Name field or the price, and
   * the icon they were promised appears after they have stopped thinking about
   * it. So the moment the text is *already an address* — `vercel.com`,
   * `https://posthog.com` — this looks, and the tile fills in underneath them.
   *
   * What keeps it from being a fetch per keystroke is `domainOf` rather than
   * the timer: a half-typed `acme.c` is not an address, so nothing is scheduled
   * for it, and `asked` means the same address is never looked at twice.
   */
  useEffect(() => {
    // Nothing to look at yet.
    const host = domainOf(url);
    if (!host) return;
    // One fetch at a time. This runs again when the in-flight one lands, so a
    // domain finished mid-fetch is picked up rather than dropped.
    if (busy) return;
    if (asked.current === `${host}|${source}`) return;

    const timer = setTimeout(() => void latest.current(source), TYPING_MS);
    return () => clearTimeout(timer);
  }, [url, source, busy]);

  const pay = async () => {
    setBusy("pay");
    setError(null);
    const priced = await priceOf(rect);

    if (godMode) {
      const placed = await god.place({
        rect,
        label,
        url,
        image: art?.key ?? null,
        imageSource: art?.source,
      });
      setBusy(null);
      if ("error" in placed) {
        setError(placed.error);
        return;
      }
      // Settled already, rather than pending a webhook — so this is the wall
      // catching up with the server rather than running ahead of it, and the
      // panel closes on the same call the buy path closes on.
      onBought({
        rect,
        id: placed.claimId,
        label,
        url,
        image: art?.key ?? null,
        prices: placed.prices.length ? placed.prices : (priced?.cells.map(cell => cell.priceCents) ?? []),
      });
      return;
    }

    const result = await checkout({
      rect,
      label,
      url,
      image: art?.key ?? null,
      imageSource: art?.source,
      email: email || null,
      turnstile: await withToken(),
      pass: pass.current,
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
      ref={panel}
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
        onChange={next => {
          // The remembered pair belongs to the address that produced it — the
          // host, not the text: adding `/pricing` to a domain already fetched
          // is not a new site, and throwing the pair away would refetch it.
          if (domainOf(next) !== domainOf(url)) seen.current = {};
          setUrl(next);
        }}
        onBlur={() => {
          // Usually already done: an address resolves as it is typed, and this
          // is here for what the typing path will not touch — an address it
          // could not recognise, which the Worker may still make sense of.
          const want = source === "og" ? "og" : "favicon";
          const host = domainOf(url);
          if (host && asked.current === `${host}|${want}`) return;
          void resolve(want);
        }}
        placeholder="acme.com"
        inputMode="url"
        autoFocus
        note={
          busy === "art"
            ? "looking at your site…"
            : art?.source === "og"
              ? "using your site's preview image"
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
        The artwork: a preview of the cell, and which picture of themselves the
        buyer wants in it.

        There is no upload. Every tile on this wall is a site, and the only two
        images that can be *about* that site are the two the site publishes —
        its icon and its preview card. An upload field is how a wall of websites
        becomes a wall of images that happen to link somewhere: it is the
        control that lets somebody put anything at all in a cell, and the one
        that would need a moderator behind it. Taking it out means the artwork
        is always something the buyer's own server served, which is a claim the
        rules page can make and keep.

        The tile is drawn at the same corner radius the canvas draws claims at,
        because it is showing the same thing — a preview of a cell, not a
        thumbnail in a form.
      */}
      <div className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className={cn(
            "size-16 shrink-0 overflow-hidden rounded-[0.7rem] border transition-colors duration-150",
            art ? "border-line/70" : "border-line border-dashed",
          )}
        >
          {art ? (
            <img src={`/img/${art.key}`} alt="" className="size-full object-contain p-1.5" />
          ) : null}
        </div>
        <div className="min-w-0">
          {/*
            Two pictures of the same site, and the buyer picks.

            Neither is better in general, which is exactly why this is a choice
            and not a heuristic: a preview image fills a wide rectangle where an
            icon would float in the middle of it, and an icon is the only thing
            that still reads at one cell. Only offered once there is an address
            to fetch from — before that it would be two buttons that do nothing.
          */}
          {url.trim() ? (
            <>
              <div className="mb-2 flex items-center gap-1.5">
                <Pick on={source === "favicon"} onClick={() => void resolve("favicon")}>
                  icon
                </Pick>
                <Pick on={source === "og"} onClick={() => void resolve("og")}>
                  preview
                </Pick>
              </div>
              <p className="text-muted text-sm">
                Taken from your site. Nothing to upload.
              </p>
            </>
          ) : (
            <p className="text-muted text-sm">
              Your icon or preview image, taken from the address above.
            </p>
          )}
        </div>
      </div>

      <Written
        id="wall-email"
        label="Email, to hear when someone takes it"
        value={email}
        onChange={setEmail}
        placeholder="you@acme.com"
        inputMode="email"
      />

      <Turnstile onToken={receiveToken} />

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
            {busy === "pay"
              ? godMode
                ? "placing…"
                : "taking you to stripe…"
              : godMode
                ? "place these cells"
                : "buy these cells"}
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

/**
 * One of a pair of choices, in the same pill language as everything else that
 * floats on this wall. A border rather than a fill when selected: a filled
 * button here would read as the thing that submits the form, and the form is
 * submitted by the price at the bottom.
 */
function Pick({
  on,
  children,
  ...props
}: React.ComponentProps<"button"> & { on: boolean }) {
  return (
    <button
      {...props}
      aria-pressed={on}
      className={cn(
        "rounded-full border px-3 py-1 text-sm lowercase transition-colors duration-150",
        on
          ? "border-muted text-ink"
          : "border-line/70 text-muted hover:text-ink hover:border-muted",
      )}
    >
      {children}
    </button>
  );
}
