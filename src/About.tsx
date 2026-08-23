import { SUPPORT_EMAIL, X_HANDLE, X_PROFILE } from "../origin";

export function About() {
  return (
    <article className="mx-auto max-w-2xl space-y-6 px-5 py-16">
      <h1 className="font-hand text-4xl">About</h1>
      <p className="text-muted">
        wallid is a fixed board of 16,384 cells that you buy one at a time. Prices only go up, and
        anything you own can be taken by anybody willing to pay more for it. That is the entire
        product.
      </p>
      <p className="text-muted">
        It is built by {X_HANDLE} (<a className="underline" href={X_PROFILE}>on X</a>). Payments run
        through Stripe; we never see a card number. Something wrong with a payment:{" "}
        <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
      <p className="text-muted">
        Logos are fetched from the site each claim links to, or uploaded. If yours is on here and
        should not be, mail the address above and it comes down.
      </p>
    </article>
  );
}
