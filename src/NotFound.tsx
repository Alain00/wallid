export function NotFound() {
  return (
    <article className="mx-auto flex h-dvh max-w-lg flex-col justify-center gap-5 px-6 text-center">
      <h1 className="text-ink font-hand text-6xl leading-[0.95] sm:text-8xl">Nothing here</h1>
      <p className="text-muted text-lg">That is not a cell, a claim, or a page.</p>
      <div>
        <a
          href="/"
          className="border-line/70 text-ink/80 hover:text-ink hover:border-muted inline-block rounded-full border px-4 py-2 text-sm lowercase transition-colors duration-150"
        >
          back to the wall
        </a>
      </div>
    </article>
  );
}
