import { useCallback, useState } from "react";
import { BuyPanel } from "@/components/BuyPanel";
import { Pulse } from "@/components/Pulse";
import { cn } from "@/lib/utils";
import * as god from "@/wall/god";
import { Wall } from "@/components/Wall";
import { CELLS, SIDE, type Rect } from "@/wall/geometry";
import { BASE_CENTS, STEP, money } from "@/wall/pricing";
import type { ChunkBody } from "@/wall/chunk";

/**
 * wallid.lol.
 *
 * The wall is the page — full viewport, edge to edge, with everything else
 * floating over it. There is no hero above it explaining what this is, because
 * the wall explains itself faster than a paragraph can: a bounded grid, some of
 * it bought, most of it not, and a price that follows the cursor.
 *
 * Which makes the layout one decision: nothing may sit *beside* the wall or
 * *below* it, because either would be taking space from the only thing worth
 * looking at. Everything is an overlay, everything is dismissible, and the
 * middle of the screen stays clickable.
 */
/**
 * The claim id Stripe just sent us back with, if this load is a buyer
 * returning from a payment.
 *
 * `success_url` is `/?claim=<id>` — see the checkout route — and it is the only
 * signal that a purchase has just settled, because the redirect through Stripe
 * destroys every piece of state the panel was holding. Read once, at module
 * scope, and stripped from the address bar immediately: a reload should not
 * replay the arrival, and the id has no business staying in a URL somebody
 * might share.
 */
const arrived = (() => {
  if (typeof location === "undefined") return null;
  const claim = new URLSearchParams(location.search).get("claim");
  if (claim) history.replaceState(null, "", location.pathname);
  return claim;
})();

export function App() {
  const [selection, setSelection] = useState<Rect | null>(null);
  const [reading, setReading] = useState(false);
  /**
   * The claim taking shape in the panel, drawn on the wall behind it.
   *
   * Held here rather than in `BuyPanel` because the two components that need it
   * are siblings: the panel knows what the buyer has typed, and only the canvas
   * can draw it. `useCallback` because the panel reports on every change and an
   * identity that changed each render would report in a loop.
   */
  const [draft, setDraft] = useState<{ label: string; url: string; image: string | null }>({
    label: "",
    url: "",
    image: null,
  });
  const onDraft = useCallback(
    (next: { label: string; url: string; image: string | null }) => setDraft(next),
    [],
  );
  /** Where the panel is sitting, so the wall can fly the selection clear of it. */
  const [panelBox, setPanelBox] = useState<DOMRect | null>(null);
  const onBox = useCallback((box: DOMRect | null) => setPanelBox(box), []);
  const [optimistic, setOptimistic] = useState<{
    rect: Rect;
    claim: ChunkBody["claims"][number];
    prices: number[];
  } | null>(null);

  /*
   * God mode. Development only — `god.AVAILABLE` is a literal `false` in a
   * production build, so everything below it is dead code the bundler drops.
   *
   * Held here because three components need to agree about it: the panel places
   * instead of selling, the wall offers a remove button, and the chip in the
   * corner is the toggle. `refresh` is bumped after anything that changes the
   * wall from outside the normal flow, so the canvas re-reads past the index's
   * thirty-second cache instead of ignoring the button you just pressed.
   */
  const [godOn, setGodOn] = useState(god.enabled);
  const [refresh, setRefresh] = useState(0);
  const changed = () => setRefresh(n => n + 1);

  return (
    <div className="bg-ground relative h-dvh w-full overflow-clip">
      <div className="absolute inset-0">
        <Wall
          onSelect={rect => {
            // Cleared with the rectangle it belonged to. The panel remounts per
            // selection and reports again immediately, but without this the
            // previous buyer's logo appears for a frame inside the new one.
            setDraft({ label: "", url: "", image: null });
            setSelection(rect);
          }}
          optimistic={optimistic}
          god={godOn}
          refresh={refresh}
          onFree={rect => void god.free(rect).then(changed)}
          dim={!!selection}
          reserved={panelBox}
          arrived={arrived}
          draft={
            selection && {
              rect: selection,
              // No id: this is not a claim yet, and the renderer reads that as
              // "do not give it a colour of its own".
              claim: { id: "", label: draft.label, url: draft.url, image: draft.image, rect: selection },
            }
          }
        />
      </div>

      {/*
        A clearing behind the heading, as its own layer.

        Over a lattice a padded box reads as a rectangle laid on top of it,
        where a fade to nothing makes the wall look like it thins around the
        words. Anchored to the corner the heading is in rather than to the
        middle, because that is where the heading went.

        The far stop is the ground colour at zero alpha, not the `transparent`
        keyword — `transparent` is transparent *black*, and the ground is
        #0a0a0b, so interpolating to it dips through colours darker than the
        page and paints a dark smear across the very wall it should vanish into.
      */}
      <div
        aria-hidden="true"
        /* Full width on a phone. The header stack is three paragraphs tall
           there and only a screen wide, so a 44rem ellipse anchored to the
           corner ran out before the last line of it — which is why the hint
           about dragging was being read against a wall of logos. */
        className="pointer-events-none absolute top-0 left-0 h-[26rem] w-full sm:h-[30rem] sm:w-[44rem] sm:max-w-full"
        style={{
          backgroundImage:
            "radial-gradient(120% 100% at 0% 0%, var(--color-ground) 0%, var(--color-ground) 30%, rgb(from var(--color-ground) r g b / 0) 76%)",
        }}
      />

      {/*
        The heading, out of the middle: the middle of this screen is where
        somebody has to be able to drag. What it says is an instruction rather
        than a claim, because the wall makes the claim by existing.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 p-6 sm:p-10">
        {/* `text-4xl` on a phone rather than `text-5xl`. At 48px the two lines
            of this plus the paragraph and the gesture hint took nearly half the
            viewport, on a page whose entire argument is the thing underneath
            them. */}
        <h1 className="text-ink font-hand max-w-[16ch] text-4xl leading-[0.95] text-balance sm:text-7xl md:text-8xl">
          Drag out a piece of it.
        </h1>
        <p className="text-muted mt-2.5 max-w-[46ch] text-sm sm:mt-4 sm:text-lg">
          {CELLS.toLocaleString()} cells, and there will never be more. From {money(BASE_CENTS)}{" "}
          each. Yours until somebody pays {STEP * 100}% more.
        </p>
        {/* The heading is an instruction, and on a phone it is the wrong one:
            a finger that drew a rectangle the moment it landed would be a wall
            nobody could look around. There, dragging pans and the rectangle
            costs a hold — which is worth one line of copy, because a gesture
            nobody has been told about is a gesture nobody makes. Coarse
            pointers only; a mouse still just drags. */}
        <p className="text-muted/80 mt-2 hidden text-xs pointer-coarse:block sm:text-sm">
          Drag to look around, pinch to zoom. Press and hold to pick cells.
        </p>
      </div>

      {/* Bottom-left, in the same pill language as the zoom controls: a floating
          chip rather than a bar, so the wall runs under it uninterrupted. */}
      {/*
        Wrapping, and every chip unbreakable.

        Five chips do not fit across a phone, and flex's default was to solve
        that by squeezing each one until its label broke over three lines — "how
        it works" as a three-line stack next to "god mode on" as another. A
        chip is a word or two on one line or it is not a chip; the row is what
        gives way.
      */}
      <nav className="absolute right-4 bottom-4 left-4 flex flex-wrap items-center gap-1.5 sm:right-auto sm:bottom-6 sm:left-6">
        <Chip onClick={() => setReading(true)}>how it works</Chip>
        <Chip href="/rules">rules</Chip>
        <Chip href="/about">about</Chip>
        {/* Last in the row and not a chip you can press: it is a fact about the
            wall rather than a way into anything. It renders nothing at all when
            the count is unavailable, so the row simply looks the way it always
            did. */}
        <Pulse />

        {/*
          God mode's switch, and the wall's only self-destruct button.

          Development only: `god.AVAILABLE` is a build-time constant, false in
          anything deployed, so this whole block is removed rather than hidden.
          It sits in the ordinary chip row rather than in a corner of its own
          because a mode that changes what the buy button does should be visible
          from wherever you are about to press it.
        */}
        {/* The guard is written out rather than read from `god.AVAILABLE`, and
            that is a bundler detail worth one line: `build.ts` substitutes this
            expression with a literal `false` right here, so the markup below is
            removed. A cross-module constant is not folded the same way, and the
            chip survived into the production bundle as unreachable JSX. */}
        {process.env.NODE_ENV !== "production" && (
          <>
            <Chip
              aria-pressed={godOn}
              className={godOn ? "border-warn/50 text-warn" : undefined}
              onClick={() => {
                const next = !godOn;
                god.enable(next);
                setGodOn(next);
              }}
            >
              god mode {godOn ? "on" : "off"}
            </Chip>
            {godOn && (
              <Chip
                className="border-warn/40 text-warn"
                onClick={() => {
                  // The one irreversible thing on the page. A wall is minutes
                  // of work to rebuild and there is no undo, so it asks.
                  if (!confirm("Clear every claim from the development wall?")) return;
                  void god.free("all").then(changed);
                }}
              >
                clear the wall
              </Chip>
            )}
          </>
        )}
      </nav>

      {reading && <Explainer onClose={() => setReading(false)} />}

      {selection && (
        <BuyPanel
          rect={selection}
          onClose={() => setSelection(null)}
          onDraft={onDraft}
          onBox={onBox}
          god={godOn}
          onBought={bought => {
            setOptimistic({
              rect: bought.rect,
              claim: {
                id: bought.id,
                label: bought.label,
                url: bought.url,
                image: bought.image,
                rect: bought.rect,
              },
              prices: bought.prices,
            });
            setSelection(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The one button shape on this site.
 *
 * A pill with a translucent ground and a blurred backdrop, so it floats on the
 * wall instead of sitting in a bar cut out of it. Lowercase, because every
 * other piece of chrome here is and title case on a chip reads as a toolbar.
 */
function Chip({
  href,
  children,
  className: extra,
  ...props
}: React.ComponentProps<"button"> & { href?: string }) {
  const className = cn(
    "border-line/70 bg-ground/70 text-ink/80 rounded-full border px-3 py-1.5 text-sm lowercase whitespace-nowrap backdrop-blur transition-colors duration-150 sm:px-4 sm:py-2",
    "hover:text-ink hover:border-muted",
    extra,
  );
  return href ? (
    <a className={className} href={href}>
      {children}
    </a>
  ) : (
    <button className={className} {...props}>
      {children}
    </button>
  );
}

/**
 * How it works, over the wall rather than under it.
 *
 * The long-form copy used to be a section below the fold, which on a page whose
 * whole argument is a full-screen board meant the argument had a scrollbar
 * under it. As an overlay it is available and never in the way, and the wall
 * stays visible through it — "there are only so many of these" means nothing if
 * you cannot see them while reading it.
 */
function Explainer({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30">
      {/* Three quarters, not opaque. The wall behind is the illustration for
          every sentence in here. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="bg-ground/75 absolute inset-0 backdrop-blur-sm"
      />

      <article className="relative mx-auto flex h-full max-w-2xl flex-col justify-center gap-7 p-8 sm:p-12">
        <h2 className="text-ink font-hand text-5xl leading-[0.95] text-balance sm:text-6xl">
          Prices only go up.
        </h2>

        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <Fact term="A free cell" detail={`${money(BASE_CENTS)}, flat`} />
          <Fact term="A held cell" detail={`${STEP * 100}% above what its holder paid`} />
          <Fact term="Priced per cell" detail="Never per rectangle. That is the game" />
          <Fact term="Nothing expires" detail="No rent, no renewal, no auction ending" />
        </dl>

        <p className="text-muted text-lg leading-relaxed">
          The wall is {SIDE} by {SIDE} and fixed. A cell somebody has fought over four times costs
          what four people were willing to pay for it. The ones nobody has touched still cost a
          dollar.
        </p>
        <p className="text-muted text-lg leading-relaxed">
          Buying a held cell takes it, with no consent step and no waiting period. Anything you buy
          can be taken from you the same way.
        </p>

        <div className="flex items-center gap-1.5">
          <Chip href="/rules">read the rules</Chip>
          <Chip onClick={onClose}>back to the wall</Chip>
        </div>
      </article>
    </div>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="border-line/70 border-t border-dashed pt-3">
      <dt className="text-ink text-base">{term}</dt>
      <dd className="text-muted text-sm">{detail}</dd>
    </div>
  );
}
