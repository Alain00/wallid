import { SUPPORT_EMAIL } from "../origin";

/**
 * What is kept, in the shortest form that is still true.
 *
 * Short because there genuinely is not much: a cookie, an optional email, and
 * whatever Stripe holds. Length here would be padding, and padding on a privacy
 * page is how you hide something.
 */
export function Privacy() {
  return (
    <article className="mx-auto max-w-2xl space-y-6 px-5 py-16">
      <h1 className="font-hand text-4xl">Privacy</h1>
      <ul className="space-y-3 text-muted">
        <li>
          A cookie, so the wall knows which claims are yours. It holds a random token and nothing
          about you. No login exists.
        </li>
        <li>
          An email address, only if you give one, and only to tell you when your cells are taken.
        </li>
        <li>
          Card details go to Stripe and never reach us. We keep the payment id and the amount.
        </li>
        <li>
          Logos you upload, and logos we fetch from the site you link to, stored under a hash of
          their own bytes.
        </li>
        <li>No analytics, no third-party scripts other than Stripe and Cloudflare Turnstile.</li>
      </ul>
      <p className="text-muted">
        Anything to remove: <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </article>
  );
}
