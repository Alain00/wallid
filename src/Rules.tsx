import { BASE_CENTS, STEP, money } from "@/wall/pricing";
import { CELLS, SIDE } from "@/wall/geometry";
import { Page } from "@/components/Page";

/**
 * The rules.
 *
 * Its own page, linked from beside the Pay button, and deliberately blunt.
 * Everything here is a thing somebody could otherwise learn by losing cells
 * they thought they owned, and a wall that takes money owes that explanation
 * before the payment rather than in a support reply after it.
 */
export function Rules() {
  return (
    <Page title="The rules">
      <Rule title={`The wall is ${SIDE} by ${SIDE}, forever`}>
        {CELLS.toLocaleString()} cells. We will not add more, ever. If we did, every cell already
        paid for would lose the thing its price was a statement about.
      </Rule>

      <Rule title="Cells are priced one at a time">
        A rectangle costs the sum of its cells. A cell nobody holds costs {money(BASE_CENTS)}. A
        cell somebody holds costs {STEP * 100}% more than they paid. Your total is never compared
        against anyone else's total, only your price for each cell against theirs.
      </Rule>

      <Rule title="Buying a held cell takes it">
        There is no consent step and no waiting period. If you pay a cell's price, it is yours and
        its previous holder loses it. This is the point of the wall, not a loophole in it.
      </Rule>

      <Rule title="You can lose cells the same way">
        Anything you buy can be taken by anyone willing to pay {STEP * 100}% more. Give us an email
        address and we will tell you when it happens.
      </Rule>

      <Rule title="It is all or nothing">
        If any cell of your rectangle is bought by someone else in the seconds between your quote
        and your payment, the whole claim is refunded. We will not sell you nine of the twelve
        cells you asked for.
      </Rule>

      <Rule title="There are no refunds otherwise">
        Not when you are outbid, not when you change your mind, not when your logo turns out to be
        blurry. You are paying for a cell at a price, not for a duration.
      </Rule>

      <Rule title="Nothing expires and nothing renews">
        This is not rent and not a subscription. A cell you hold is held until somebody takes it,
        which may be tomorrow or may be never.
      </Rule>

      <Rule title="We can hide a claim">
        Anything illegal, deceptive, or aimed at a person gets hidden. Hidden claims keep their
        cells and keep their prices: moderation is not a refund, and it will not hand the wall back
        to whoever put something there.
      </Rule>

      <Rule title="One link, and we check it">
        Every claim points at one https address. We normalise it, refuse credentials embedded in
        it, and remove claims that point at malware or a scam.
      </Rule>
    </Page>
  );
}

/**
 * Dashed rules between the rules, rather than boxes around them.
 *
 * A bordered card per item turns nine short paragraphs into nine objects to
 * look at. A hairline between them keeps it prose, which is what it is.
 */
function Rule({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line/70 space-y-2 border-t border-dashed pt-6">
      <h2 className="text-ink text-xl">{title}</h2>
      <p className="text-muted text-lg leading-relaxed">{children}</p>
    </section>
  );
}
