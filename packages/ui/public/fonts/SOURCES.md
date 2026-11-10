# Self-hosted fonts

All four families are SIL Open Font License 1.1 (OFL), matching `docs/design/tokens.css`'s own note. Vendored once, as static files — no runtime calls to Google or any other font host from `fern ui`.

- `doto-700.woff2` — Doto, variable weight axis (served as `font-weight: 700 900`), latin subset. Source: Google Fonts (`fonts.gstatic.com`), OFL.
- `instrument-serif-400.woff2`, `instrument-serif-400-italic.woff2` — Instrument Serif, weight 400, normal and italic, latin subset. Source: Google Fonts (`fonts.gstatic.com`), OFL.
- `geist-variable.woff2` — Geist, variable weight axis. Source: [vercel/geist-font](https://github.com/vercel/geist-font), OFL.
- `geist-mono-variable.woff2` — Geist Mono, variable weight axis. Source: [vercel/geist-font](https://github.com/vercel/geist-font), OFL.

Only the latin subset was vendored (matches this product's English-only UI copy today); re-vendor with a wider subset if that changes.
