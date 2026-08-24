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
          Logos we fetch from the site you link to — its icon or its preview image — stored under a
          hash of their own bytes. There is nothing to upload, so there is nothing of yours here
          that your own server was not already serving to anybody who asked.
        </Item>
        <Item>
          No third-party analytics and no tracking scripts other than Stripe and Turnstile. The wall
          counts how many people are looking at it, from the requests it already serves: one row
          holding a country and a code derived from your address, which changes every day and cannot
          be traced back to you or joined across days. The count on the wall is that, added up —
          how many people are here in the last minute and a half. The visit total is the same rows
          counted once a day and kept — a running number of days somebody showed up, never a history
          of who.
        </Item>
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
