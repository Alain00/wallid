import { Page } from "@/components/Page";
import { SUPPORT_EMAIL, X_HANDLE, X_PROFILE } from "../origin";
import { CELLS } from "@/wall/geometry";

export function About() {
  return (
    <Page title="About">
      <p className="text-muted text-lg leading-relaxed">
        wallid is a fixed board of {CELLS.toLocaleString()} cells that you buy one at a time. Prices
        only go up, and anything you own can be taken by anybody willing to pay more for it. That is
        the entire product.
      </p>
      <p className="text-muted text-lg leading-relaxed">
        It is built by {X_HANDLE} (
        <a className="hover:text-ink underline underline-offset-2" href={X_PROFILE}>
          on X
        </a>
        ). Payments run through Stripe; we never see a card number. Something wrong with a payment:{" "}
        <a className="hover:text-ink underline underline-offset-2" href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
      <p className="text-muted text-lg leading-relaxed">
        Logos are fetched from the site each claim links to, or uploaded. If yours is on here and
        should not be, mail the address above and it comes down.
      </p>
    </Page>
  );
}
