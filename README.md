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

- **Whole field** — once a field has loaded, every source in it is checked automatically: how far
  it moved between the 2010 WISE image and SPHEREx, and whether its brightness changed between
  SPHEREx passes. Flagged sources are listed and bracketed on the image.

## For AI agents (WebMCP)

The page registers five tools on `document.modelContext` (Chrome's WebMCP API): `look_at_sky`,
`list_changes`, `inspect_position`, `set_view` and `get_view`. Where the browser does not provide
WebMCP (it is behind an origin trial), the page installs a stand-in with the same `getTools()` /
`executeTool()` methods, so an agent that can run script in the page uses the same calls:

```js
const tools = await document.modelContext.getTools();
const look = tools.find((t) => t.name === 'look_at_sky');
const result = JSON.parse(await document.modelContext.executeTool(look, { target: '277.49 1.23', field_arcmin: 10 }));
```

To enable native WebMCP on the deployed site, register the origin for Chrome's WebMCP origin trial
and add the token as `<meta http-equiv="origin-trial" content="…">` in `app/pages/index.html`.

## What a scan has found

An AI agent drove the tool over 28 fields (10,691 exposures: 16 star-forming regions and 12
inner-Galaxy fields) and checked every flagged source against SIMBAD, Gaia DR3, 2MASS and AllWISE.

- **IRAS 18274−0205** (Serpens South protostar): 232 mJy at 4.7 µm in Sep 2025, unsaturated in all
  23 exposures; saturating by 2026. Unsaturated bands rose across three passes (2 µm: 4 → 10 → 15
  mJy; 3 µm: 14 → 60 → 87 mJy). In Sep 2025 it was several times fainter than 2MASS (1999) or WISE (2010).
- **V371 Ser / EC 53** (known eruptive protostar): 74% fainter in Sep 2026 than Sep 2025.
- **IRAS 16253−2429** (Ophiuchus protostar): 56% fainter in Aug 2026 than Aug 2025.
- **2MASS J03290907+3121291** (NGC 1333): 77% brighter in Aug 2026 than Aug 2025.
- **Barnard's Star**: recovered blind at 9.97″/yr (Gaia: 10.39).

All are catalogued objects; no uncatalogued object has been found. Two candidates in Lupus III were
rejected as diffraction light from bright neighbours, which led to the scan's current rejection rules.
Unpaired "appeared since 2010" detections are not reported because nebulosity produces false ones.

## How it works

- `app/pages/` — static site: plain HTML/CSS/JS, WebGPU with a canvas fallback.
- `app/pages/js/scan.js` — the whole-field check; `app/pages/js/mcp.js` — the agent tools;
  `app/pages/js/found.js` — objects listed on the start page.
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
