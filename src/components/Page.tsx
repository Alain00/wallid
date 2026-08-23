/**
 * Everything that is not the wall.
 *
 * One layout for the four static pages, because they are the same shape: a
 * hand-lettered heading at the size the wall's own heading uses, prose under
 * it, and one way back. Sharing it is what stops them drifting into four
 * slightly different sites.
 */
export function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-2xl space-y-8 px-6 py-16 sm:px-8 sm:py-24">
      <header className="space-y-6">
        <a
          href="/"
          className="border-line/70 bg-ground/70 text-ink/80 hover:text-ink hover:border-muted inline-block rounded-full border px-4 py-2 text-sm lowercase backdrop-blur transition-colors duration-150"
        >
          ← the wall
        </a>
        <h1 className="text-ink font-hand text-5xl leading-[0.95] text-balance sm:text-7xl">
          {title}
        </h1>
      </header>
      {children}
    </article>
  );
}
