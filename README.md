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

An AI agent drove the tool over about 250 fields (star-forming regions and the northern Galactic
plane), first through its WebMCP tools and then with `tools/hunt.mjs`, and checked every flagged source against SIMBAD, the AAVSO Variable
Star Index (VSX), Gaia DR3 and its variability tables, 2MASS, AllWISE, and the ZTF and WISE
variable-star catalogues.

**New variable-star candidates** (real change in SPHEREx data, no variability on record in any of
the above; independent confirmation still needed):

- **2MASS J20355040+4349233** (RA 308.95999, Dec +43.82317). Very red (J−K = 4.2), no SIMBAD entry,
  no Gaia counterpart. At matched wavelengths it dimmed 13–24% in five bands between Jun 2025 and
  Jun 2026 (most of it by Oct 2025). Twelve other stars in the field changed by 0 to −3%.
- **Gaia DR3 2054043683842071424** (RA 303.11985, Dec +31.78993). Known only as an Hα-excess source
  (Fratta+ 2021). Below 1.1 µm it is unchanged, in agreement with ZTF photometry, which is flat from
  2018 to Oct 2025. Its infrared excess grew from May 2025 to May 2026: +23% at 1.4 µm, +32% at 2 µm,
  +59% at 4.1 µm, +77% at 4.7 µm, consistent with a circumstellar disk building up.
- **2MASS J19053064+0612311** (RA 286.37767, Dec +6.20867). Extremely red (J−K = 5.4), in the
  dust of the Galactic plane, no SIMBAD entry, no Gaia counterpart. It brightened through all three
  passes regardless of season: 4.7 µm +12% (Sep 2025 → Apr 2026) then +10% (→ Sep 2026); 4.1 µm +21%
  and 2 µm +22% over the year.

Two weaker candidates from the same hunt, real but with caveats: **2MASS J20451747+4430291**
(RA 311.32274, Dec +44.50809; faded 15–41% between same-season passes, but three Gaia stars are
blended within 9″) and **2MASS J19164098+1131014** (RA 289.17074, Dec +11.51693; brightened 30–50%
in three bands, but the bands do not all agree).

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
