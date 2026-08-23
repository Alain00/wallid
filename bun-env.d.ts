/// <reference types="bun-types" />

/**
 * Side-effect stylesheet imports.
 *
 * Bun's bundler resolves `import "./styles.css"` and emits a `<link>`;
 * TypeScript has no idea what a `.css` module is and reports the import as
 * missing. This is the declaration that says "yes, that is a thing", and it
 * carries no shape because nothing imports a value from a stylesheet.
 */
declare module "*.css";
