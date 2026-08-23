/**
 * Every page on the site, in one list.
 *
 * Adding a page used to mean editing five places that had to agree, and nothing
 * checked that they did: a hand-copied HTML document, an entry module, the
 * bundler's `entrypoints` array, a `finish()` call beside it, and a pair of dev
 * server routes. Four of those five were boilerplate around the same four facts
 * — a title, a description, a URL and an entry module — so they are stated here
 * once and everything else is derived.
 *
 * `document.ts` renders each entry into an HTML file, `build.ts` bundles and
 * rewrites the list, `server.ts` routes it. None of the three keeps a second
 * copy of the list, so none of them can drift from this one.
 *
 * To add a page: write `pages/<name>.tsx`, add an entry below. That is all.
 */
import type { ReactNode } from "react";
import { GITHUB_PROFILE, SUPPORT_EMAIL, X_PROFILE, absolute } from "./origin";
import { CELLS, SIDE } from "./src/wall/geometry";

export type Page = {
  /** Document name. Produces `<name>.html`, which is generated and gitignored. */
  name: string;
  /**
   * The URL it is served at.
   *
   * Doubles as `og:url`. Exactly one page must claim `"/"`; it becomes the dev
   * server's catch-all and is the only page whose route is not also served at
   * its `.html` spelling.
   */
  route: string;
  /** Module the document loads, relative to the site root. */
  entry: string;
  title: string;
  description: string;
  /** `og:title`. Separate from `title`, which carries the tagline a card should not. */
  ogTitle: string;
  /** `og:description`, when the card wants a shorter line than the meta tag. */
  ogDescription?: string;
  /**
   * Markup to put in `#root` at build time, as a thunk.
   *
   * A thunk, and an async one, so that the component tree is only imported by
   * whoever actually renders it. `server.ts` reads this same manifest and must
   * not pull the entire React app into the dev server process to do it.
   */
  prerender?: () => Promise<ReactNode>;
  /** JSON-LD nodes for this page, one `<script type="application/ld+json">` each. */
  schema?: object[];
  /** In `sitemap.xml`, and meant to be found. Defaults to true. */
  indexable?: boolean;
  /**
   * Load the bundle on `load` from an inline script rather than from a
   * `<script src>` the preload scanner finds. Buys first paint by delaying
   * interactivity.
   */
  defer: boolean;
};

/**
 * Who is behind this, as one node every page points at.
 *
 * A `Person`, not an `Organization`, and that is a substantive claim rather
 * than a schema preference: this is one developer, and a wall that takes
 * payments should be honest about who is on the other end of a refund request.
 * `Organization` would imply a company that does not exist, and on a site
 * asking for card details that is the wrong thing to imply.
 *
 * `@id` rather than a copy, so a crawler reading three pages comes away with
 * one maintainer who has three pages rather than three people sharing a name.
 */
const MAINTAINER = {
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": absolute("/#alain"),
  name: "Alain",
  url: GITHUB_PROFILE,
  sameAs: [GITHUB_PROFILE, X_PROFILE],
  contactPoint: [
    {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: SUPPORT_EMAIL,
      availableLanguage: ["English"],
    },
  ],
};

/**
 * The wall itself, as the thing being sold.
 *
 * `Product` with an `offers` node, which is the honest type: this page sells
 * something at a price. The price named is the *floor* — a cell nobody holds —
 * because it is the only price that is a fact about the product rather than
 * about the wall's current state, and a structured price that goes stale every
 * time somebody buys is worse than none.
 */
const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  "@id": absolute("/#wall"),
  name: "wallid",
  url: absolute("/"),
  description: `A fixed wall of ${CELLS.toLocaleString()} cells. Buy any rectangle of it, put your logo in it, and hold it until somebody pays more.`,
  brand: { "@type": "Brand", name: "wallid" },
  offers: {
    "@type": "Offer",
    price: "1.00",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: absolute("/"),
  },
};

/** Redirects, answered by `dist/_redirects` in production and by the dev
 * server from this same list. */
export const ALIASES: { from: string; to: string; status: number }[] = [
  { from: "/terms", to: "/rules", status: 301 },
];

export const PAGES: Page[] = [
  {
    name: "index",
    route: "/",
    entry: "./pages/index.tsx",
    title: `wallid — ${CELLS.toLocaleString()} cells, and prices only go up`,
    description: `A fixed ${SIDE} by ${SIDE} wall. Buy a rectangle of it from $1 a cell, put your logo in it, and hold it until somebody pays more than you did.`,
    ogTitle: "wallid",
    ogDescription: `${CELLS.toLocaleString()} cells. Buy one. Lose it to whoever pays more.`,
    schema: [MAINTAINER, PRODUCT],
    /*
     * Not prerendered, and it is the one page where that is the right call. The
     * whole of this page above the fold is a canvas that cannot exist until the
     * client has fetched the wall, so server markup for it would be a header
     * and an empty box — a first paint that is strictly a worse version of the
     * loading state, and a hydration boundary around the component that most
     * needs to mount fast.
     */
    defer: false,
  },
  {
    name: "rules",
    route: "/rules",
    entry: "./pages/rules.tsx",
    title: "The rules — wallid",
    description:
      "How cells are priced, how they are taken, when you are refunded and when you are not.",
    ogTitle: "The rules",
    // Prerendered: it is static prose, it is the page linked from beside a Pay
    // button, and it must be readable before any JavaScript runs.
    prerender: async () => {
      const { Rules } = await import("./src/Rules");
      return <Rules />;
    },
    defer: true,
  },
  {
    name: "about",
    route: "/about",
    entry: "./pages/about.tsx",
    title: "About — wallid",
    description: "Who runs this wall, and how to reach them about a payment.",
    ogTitle: "About wallid",
    prerender: async () => {
      const { About } = await import("./src/About");
      return <About />;
    },
    defer: true,
  },
  {
    name: "privacy",
    route: "/privacy",
    entry: "./pages/privacy.tsx",
    title: "Privacy — wallid",
    description: "A cookie, an optional email address, and Stripe. That is the list.",
    ogTitle: "Privacy",
    prerender: async () => {
      const { Privacy } = await import("./src/Privacy");
      return <Privacy />;
    },
    defer: true,
  },
  {
    name: "404",
    route: "/404",
    entry: "./pages/404.tsx",
    title: "Nothing here — wallid",
    description: "That is not a cell, a claim, or a page.",
    ogTitle: "Nothing here",
    indexable: false,
    prerender: async () => {
      const { NotFound } = await import("./src/NotFound");
      return <NotFound />;
    },
    defer: true,
  },
];
