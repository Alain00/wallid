export function NotFound() {
  return (
    <article className="mx-auto max-w-2xl space-y-4 px-5 py-24 text-center">
      <h1 className="font-hand text-5xl">Nothing here</h1>
      <p className="text-muted">That is not a cell, a claim, or a page.</p>
      <a className="underline" href="/">
        Back to the wall
      </a>
    </article>
  );
}
