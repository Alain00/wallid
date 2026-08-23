import { useState } from "react";
import { BuyPanel } from "@/components/BuyPanel";
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
export function App() {
  const [selection, setSelection] = useState<Rect | null>(null);
  const [reading, setReading] = useState(false);
  const [optimistic, setOptimistic] = useState<{
    rect: Rect;
    claim: ChunkBody["claims"][number];
    prices: number[];
  } | null>(null);

  return (
    <div className="bg-ground relative h-dvh w-full overflow-clip">
      <div className="absolute inset-0">
        <Wall onSelect={rect => setSelection(rect)} optimistic={optimistic} dim={!!selection} />
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
        className="pointer-events-none absolute top-0 left-0 h-[30rem] w-[44rem] max-w-full"
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
        <h1 className="text-ink font-hand max-w-[16ch] text-5xl leading-[0.95] text-balance sm:text-7xl md:text-8xl">
          Drag out a piece of it.
        </h1>
        <p className="text-muted mt-3 max-w-[46ch] text-base sm:mt-4 sm:text-lg">
          {CELLS.toLocaleString()} cells, and there will never be more. From {money(BASE_CENTS)}{" "}
          each. Yours until somebody pays {STEP * 100}% more.
        </p>
      </div>

      {/* Bottom-left, in the same pill language as the zoom controls: a floating
          chip rather than a bar, so the wall runs under it uninterrupted. */}
      <nav className="absolute bottom-4 left-4 flex items-center gap-1.5 sm:bottom-6 sm:left-6">
        <Chip onClick={() => setReading(true)}>how it works</Chip>
        <Chip href="/rules">rules</Chip>
        <Chip href="/about">about</Chip>
      </nav>

      {reading && <Explainer onClose={() => setReading(false)} />}

      {selection && (
        <BuyPanel
          rect={selection}
          onClose={() => setSelection(null)}
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
  ...props
}: React.ComponentProps<"button"> & { href?: string }) {
  const className =
    "border-line/70 bg-ground/70 text-ink/80 rounded-full border px-4 py-2 text-sm lowercase backdrop-blur transition-colors duration-150 hover:text-ink hover:border-muted";
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
