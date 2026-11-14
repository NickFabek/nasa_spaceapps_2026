# Spherical

NASA Space Apps 2026 — *Planet X and SPHEREx*. A public web tool for finding things that move
or change in NASA SPHEREx infrared images of any patch of sky.

Live: https://nasa-spaceapps-2026-bgg.pages.dev

## What it does

- **Any position** — object name, coordinates, or a random patch. Links carry the whole view:
  `?ra=<deg>&dec=<deg>&fov=<arcmin>&mode=epoch|diff|stack|frame&bands=56&mue=&mun=&embed=1`
- **Blink** — one stacked image per six-monthly SPHEREx pass, plus the 2010 WISE image for a
  15-year baseline. Movers jump.
- **Difference** — one pass minus another; a mover leaves a blue/orange pair.
- **Shift & stack** — every exposure slid along a trial motion and added on the GPU, to pull out
  movers too faint for a single image. The highest and lowest sample at each pixel are dropped,
  which removes cosmic-ray hits.
- **Exposures** — every single image with its wavelength, quality check and per-pixel flags.
- **Bands** — the six detectors (0.75–5.0 µm) can be combined or viewed alone.
- **Known stars** — Gaia DR3 stars are ringed where they were on the date shown, using their
  proper motions. A mover without a ring is worth a look.
- **Click a dot** — tells you whether Gaia knows it, and measures it in every exposure to give a
  spectrum of up to 102 wavelengths (CSV download), with links to SIMBAD and WiseView.

## How it works

- `app/pages/` — static site: plain HTML/CSS/JS, WebGPU with a canvas fallback.
- `app/functions/api/search.js` — asks IRSA which SPHEREx images cover a position.
- `app/functions/api/cutout.js` — reads only the needed bytes of each image from the public
  SPHEREx bucket on AWS and returns a small float tile plus flags.
- `app/functions/api/wise.js` — the same for the 2010 AllWISE atlas.
- `app/functions/api/gaia.js` — Gaia DR3 stars in the field.
- `app/functions/api/resolve.js` — object name to coordinates (CDS Sesame), proper motion applied.
- `app/lib/config.js` — list of SPHEREx releases to search. **Add new releases here.**

Tiles and search answers are cached in R2 (binding `CACHE`). No API keys are needed.

## Run locally

```bash
cd app && npx wrangler pages dev pages --r2=CACHE
```
