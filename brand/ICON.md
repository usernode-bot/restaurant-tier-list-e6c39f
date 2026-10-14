# Brand icons

The app's mark is a steaming noodle bowl sitting on three stepped tier
bars (the tier board), drawn flat in the Homeroom brand colours. No text.

- `icon.png` — 1024×1024 app icon, black mark on yellow (`#FFEE6F`).
  Referenced as `icon.image` in `dapp.json`; the 🍜 emoji stays as the
  fallback. The platform rounds and crops the tile, so the artwork is
  full-bleed with square corners and the mark sits clear of the edges.
- `featured-light.png` — 1600×900. Cream (`#FFFEEA`) ground, yellow disc,
  black mark. The featured illustration for the Homeroom directory's
  light look.
- `featured-dark.png` — 1600×900. Black ground, yellow mark, no disc.
  The dark-look version of the same illustration.

Only Homeroom brand colours are used: Black `#000000`, Yellow `#FFEE6F`,
Cream `#FFFEEA`.

The PNGs are rendered by `render-icons.js` (Node core only): edit the
mark geometry there and rerun `node brand/render-icons.js`. The script
also writes small-size previews to the OS temp dir to check readability
at 64 and 32 px on light and dark. The files are kept out of `public/`
so the app never serves them.

There is no `dapp.json` field that publishes the featured illustrations
to the directory yet; they are committed here ready for that.
