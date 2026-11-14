# Driftscope

NASA Space Apps 2026 — *Planet X and SPHEREx*. A public web tool that shows how any patch
of sky changes over time in NASA SPHEREx infrared images, to help people find things that move.

- **Blink visits** — one stacked image per six-monthly survey visit, played like a short video.
- **Frames** — every individual exposure, with per-pixel quality flags.
- **Difference** — one visit minus another; movers leave a blue/orange pair.
- **Shift & stack** — slide all exposures along a trial motion and add them (WebGPU).
- **Spectrum** — click a source to measure it in every exposure (up to 102 wavelengths).
- **Links** — `?ra=<deg>&dec=<deg>&fov=<arcmin>&mode=epoch|frame|diff|stack&bands=34&embed=1`

## How it works

- `app/pages/` — static site (plain HTML/CSS/JS, WebGPU with a canvas fallback).
- `app/functions/api/search.js` — asks IRSA which SPHEREx images cover a position (live, so new data appears automatically).
- `app/functions/api/cutout.js` — reads only the needed bytes of each image from the public
  SPHEREx bucket on AWS, returns a small float tile, and caches it in R2 (binding `CACHE`).
- `app/functions/api/resolve.js` — object name to coordinates (CDS Sesame), with proper motion applied.
- `app/lib/config.js` — list of SPHEREx releases to search. **Add new releases here.**

No API keys are needed.

## Run locally

```bash
cd app && npx wrangler pages dev pages --r2=CACHE
```
