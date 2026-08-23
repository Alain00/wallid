import { Page } from "@/components/Page";
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
    <Page title="Privacy">
      <ul className="text-muted space-y-5 text-lg leading-relaxed">
        <Item>
          A cookie, so the wall knows which claims are yours. It holds a random token and nothing
          about you. No login exists.
        </Item>
        <Item>
          An email address, only if you give one, and only to tell you when your cells are taken.
        </Item>
        <Item>
          Card details go to Stripe and never reach us. We keep the payment id and the amount.
        </Item>
        <Item>
          Logos you upload, and logos we fetch from the site you link to, stored under a hash of
          their own bytes.
        </Item>
        <Item>No analytics, and no third-party scripts other than Stripe and Turnstile.</Item>
      </ul>
      <p className="text-muted text-lg leading-relaxed">
        Anything to remove:{" "}
        <a className="hover:text-ink underline underline-offset-2" href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </Page>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return <li className="border-line/70 border-t border-dashed pt-5">{children}</li>;
}
