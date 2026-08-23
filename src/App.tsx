import { useState } from "react";
import { BuyPanel } from "@/components/BuyPanel";
import { Wall } from "@/components/Wall";
import { CELLS, SIDE, type Rect } from "@/wall/geometry";
import { BASE_CENTS, STEP, money } from "@/wall/pricing";
import type { ChunkBody } from "@/wall/chunk";

/**
 * wallid.lol.
 *
 * The wall is the page. There is no hero above it explaining what this is,
 * because the wall explains itself faster than a paragraph can: a bounded grid,
 * some of it bought, most of it not, and a price that follows the cursor. The
 * copy lives underneath, for the people who scroll rather than drag.
 */
export function App() {
  const [selection, setSelection] = useState<Rect | null>(null);
  const [optimistic, setOptimistic] = useState<{
    rect: Rect;
    claim: ChunkBody["claims"][number];
    prices: number[];
  } | null>(null);

  return (
    <>
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <a href="/" className="font-hand text-2xl">
          wallid
        </a>
        <nav className="flex items-center gap-5 text-sm text-muted">
          <a className="hover:text-ink" href="/rules">
            Rules
          </a>
          <a className="hover:text-ink" href="/about">
            About
          </a>
        </nav>
      </header>

      <main>
        {/* Tall enough to be the page and short enough that the rules below it
            are discoverable by scrolling rather than by hoping. */}
        <section className="h-[78vh] border-b border-line">
          <Wall onSelect={rect => setSelection(rect)} optimistic={optimistic} />
        </section>

        <section className="mx-auto max-w-2xl space-y-6 px-5 py-16">
          <h1 className="font-hand text-4xl">
            {CELLS.toLocaleString()} cells. There will never be more.
          </h1>
          <p className="text-muted">
            The wall is {SIDE} by {SIDE} and fixed. Drag out a rectangle, put your logo in it, pay
            for it. It is yours until somebody pays more than you did.
          </p>
          <dl className="grid grid-cols-2 gap-5 border-y border-line py-6 text-sm">
            <Fact term="A free cell" detail={`${money(BASE_CENTS)} each`} />
            <Fact term="A held cell" detail={`${STEP * 100}% above what its holder paid`} />
            <Fact term="Buying takes it" detail="Per cell, never per rectangle" />
            <Fact term="Nothing expires" detail="No rent, no renewal, no auction ending" />
          </dl>
          <p className="text-muted">
            Prices only go up. That is the whole game: a cell somebody has fought over four times
            costs what four people were willing to pay for it, and the ones nobody has touched still
            cost a dollar. <a className="underline" href="/rules">Read the rules</a> before you buy.
          </p>
        </section>
      </main>

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
    </>
  );
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-ink">{term}</dt>
      <dd className="text-muted">{detail}</dd>
    </div>
  );
}
