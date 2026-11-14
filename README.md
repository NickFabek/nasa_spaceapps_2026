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

## What scans have found

An AI agent drove the tool over about 430 fields (star-forming regions and the northern Galactic
plane), first through its WebMCP tools and then with `tools/hunt.mjs`, and checked every flagged source against SIMBAD, the AAVSO Variable
Star Index (VSX), Gaia DR3 and its variability tables, 2MASS, AllWISE, and the ZTF and WISE
variable-star catalogues.

**New variable-star candidates: 14.** Each shows a real change in SPHEREx data, is independently
confirmed as variable by ten years of NEOWISE photometry, and has no variability on record in SIMBAD,
VSX, Gaia DR3, or the ZTF, WISE and AGB catalogues checked. The full table is in
[`submissions/candidates.md`](submissions/candidates.md); draft AAVSO entries for three are alongside it.
The largest: 2MASS J19262114+1813483 (1.6 mag in NEOWISE; 36–68% fainter at 2–5 µm in Sep 2026 than a
year before), 2MASS J19013726+0318372 (1.5 mag) and 2MASS J18483503+0025511 (1.2 mag). The most unusual:
Gaia DR3 2054043683842071424, an Hα-emission star with repeated infrared outbursts since 2020 and a new
one under way. None is confirmed by anyone else, and stars like these are common in the Galactic plane:
they are new to the catalogues, not rare objects.

**Known objects caught changing**

- **[HMH2007] 67** (Serpens G3–G6 protostar): 433 mJy at 4.7 µm in Sep 2025, about 120 mJy in Apr
  and Sep 2026.
- **IRAS 18274−0205** (Serpens South protostar): 232 mJy at 4.7 µm in Sep 2025, saturating by 2026;
  2 µm rose 4 → 10 → 15 mJy across three passes.
- **IRAS 16253−2429**, **2MASS J03290907+3121291**, **IRAS 15398−3359** and other young stars:
  20–77% changes between same-season passes.

**Recovered blind**: V371 Ser (EC 53), Barnard's Star (9.97″/yr; Gaia 10.39), the Miras
OGLE GD-LPV-18622, OGLE GD-LPV-23781 and OGLE BLG-LPV-264724.

**Rejected**: two Lupus III sources (diffraction light from bright neighbours) and
2MASS J20161735+3712567 (real change, but already in the Petrosky+ 2021 WISE variables catalogue).
These rejections shaped the scan's rules: ignore sources beside far brighter ones, require a stable
position, and prefer comparisons between passes a whole year apart.

## Request allowance

Each field opened for the first time costs about 400 Cloudflare Function requests (one per
exposure). The free plan allows 100,000 a day, roughly 250 new fields; after that the API stops
until midnight UTC and the page says so. Fields already opened in the same browser load from its
cache. For long hunts use `tools/hunt.mjs`, which runs the same search, cutout and scan code in
Node and makes no Cloudflare requests:

```bash
node tools/hunt.mjs fields.json          # [["tag", ra, dec], ...]
node tools/hunt.mjs --inspect 286.37767,6.20867
node tools/crosscheck.mjs "286.37767,6.20867"
```

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
