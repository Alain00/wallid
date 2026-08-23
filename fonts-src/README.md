# Font sources

The originals. `../fonts/` holds subsets of these, and those are what ship. The
full variable files are ~216 KB together, which on a simulated slow-4G
connection would be the single largest contributor to LCP.

Three faces, all SIL OFL: **Geist** and **Geist Mono**, which the site is set
in, and **Caveat**, which every heading uses.

This directory is deliberately *not* under `fonts/`: `build.ts` copies that
directory into `dist` wholesale, so a nested `source/` would ship too.

## Regenerating

Needs `fonttools` (`pip install fonttools brotli`), which is why this is a
manual step committed to the repo rather than something `bun run build` does —
the build stays dependency-free.

```sh
for f in geist-variable geist-mono-variable; do
  pyftsubset "fonts-src/$f.woff2" \
    --output-file="fonts/$f.woff2" \
    --flavor=woff2 \
    --layout-features='kern,liga,calt' \
    --unicodes='U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+20AC,U+2122,U+2190-2193,U+2212'
done
```

The range is Basic Latin + Latin-1 Supplement + General Punctuation, plus the
euro, trademark, arrows and minus signs. Widen it if the copy ever grows a
character outside it — the failure mode is a silent fallback glyph, not an
error, so check visually after changing any prose.

## Caveat, instanced then subset

Caveat ships variable from Google Fonts and is used at exactly one weight here,
so it is instanced to 600 first and only then subset. That is about a third of
the bytes of the variable file.

```sh
fonttools varLib.instancer fonts-src/caveat-variable.woff2 wght=600 \
  -o /tmp/caveat-600.ttf --no-overlap-flag

pyftsubset /tmp/caveat-600.ttf \
  --output-file=fonts/caveat.woff2 \
  --flavor=woff2 \
  --layout-features='kern,liga,calt' \
  --unicodes='U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+20AC,U+2122,U+2190-2193,U+2212'
```

**Not** cut to the characters of a single sentence, which is the tempting
optimisation and the wrong one here: six headings across five pages will be
reworded, and no one is going to keep a hand-maintained charset in step with
them. It went wrong exactly that way once already, as a heading whose first two
letters rendered in a serif while the rest was in Caveat.
