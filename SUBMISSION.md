# Space Apps submission: text for each field

Copy each block into the matching field on your team's project page, then press
**Submit for Judging** before 11:59 pm local time on Sunday.

## Before you paste

1. Team: **Spherical Software**. Member: **Nicholas Fabek**. Both are on slide 1.
2. Open the three links below in a private browser window to confirm they load without a login.
3. Read the "Use of AI" block and change anything that does not match what happened. The rules say
   AI must not be used to come up with the idea, and that AI-written code must be acknowledged.
4. Optional: the guide recommends checking that a new website is classified by FortiGuard
   (https://www.fortiguard.com/webfilter). The `pages.dev` address below is on Cloudflare's own
   domain, which filters already know, so it is the safer one to submit.

## Project Name

Spherical

## High-Level Project Summary

Spherical is a free website that shows how any patch of sky changes between images taken by NASA's
SPHEREx telescope, which photographs the whole sky twice a year in 102 colours of infrared light.
Type an object name or coordinates and it fetches every SPHEREx exposure of that spot, straight from
NASA's public archive, and plays them as a short film: blink between passes, subtract one from
another, or stack hundreds of exposures along a motion to bring out faint moving objects. It adds a
2010 WISE image for a 16-year baseline, rings the stars the Gaia catalogue already knows, and draws
a spectrum for anything you click. It also checks every source in the field automatically and lists
what moved or changed brightness. The challenge asked for a tool that lets the public search SPHEREx
images for moving objects such as nearby brown dwarfs or a distant planet; Spherical does that for
any position, with no account, download or API key. It matters because SPHEREx records hundreds of
millions of objects, far more than scientists can inspect, and moving or changing objects are found
by comparing images. In test scans of about 1,000 fields the tool measured the motion of Barnard's
Star to within 4% of the catalogue value and turned up 14 stars whose brightness changes are not in
the variable-star catalogues we checked.

## Link to Project Demo

https://nasa-spaceapps-2026-bgg.pages.dev/slides/

(Seven slides. Arrow keys or the buttons at top right move between them. Same deck at
https://spherical.software/slides/)

## Link to Final Project

https://nasa-spaceapps-2026-bgg.pages.dev/

(Source code: https://github.com/NickFabek/nasa_spaceapps_2026. If the form wants a repository
here instead of the live site, use that link and keep the live site in the description.)

## Detailed Project Description

**What it does**

Spherical turns SPHEREx's archive into something anyone can look through. Enter a name
("Barnard's Star"), coordinates, or press "Take me somewhere random". The site then:

- finds every SPHEREx exposure covering that position (typically 300 to 500) and fetches a small
  cutout of each;
- **Blink**: shows one combined image per six-monthly SPHEREx pass, plus a 2010 WISE image, so
  anything that moved jumps;
- **Difference**: subtracts one pass from another, so a mover appears as a blue and orange pair and
  a star that brightened stands out;
- **Shift and stack**: slides every exposure along a trial motion and adds them, which brings out
  movers too faint for a single image;
- **Exposures**: shows each single image with its wavelength and NASA's per-pixel quality flags;
- lets you choose any of the telescope's six infrared bands;
- rings known stars from ESA's Gaia catalogue at the place they were on the date shown, so a moving
  dot without a ring stands out;
- draws a spectrum (up to 102 wavelengths, downloadable as CSV) for any dot you click;
- **Whole field**: checks every source automatically for motion since 2010 and for brightness
  changes between passes, and lists the ones worth a look;
- puts the whole view into the page address, so any finding can be shared or embedded.

The start page explains the mission to a general reader, with a live 3D diagram of how SPHEREx
scans the sky, and a 30-second guided tour introduces the controls.

**How it works**

The site is plain HTML, CSS and JavaScript hosted on Cloudflare Pages. Small Cloudflare Functions
ask NASA's IRSA archive which SPHEREx images cover a position, then read only the few kilobytes
needed from each 60 MB image file in NASA's public SPHEREx bucket on AWS, using HTTP range requests.
They decode the FITS headers, the distortion-corrected sky coordinates, the Rice-compressed quality
flags and the wavelength map, and return a small tile, cached in Cloudflare R2. In the browser,
WebGPU aligns, stacks and subtracts hundreds of tiles in real time (with a canvas fallback where
WebGPU is missing). The same pipeline reads the 2010 AllWISE atlas for the long baseline. Nothing is
pre-computed and no data is copied into the project, so new SPHEREx releases appear by adding one
line of configuration.

The page also offers its functions to AI agents through the browser's WebMCP interface
(`look_at_sky`, `list_changes`, `inspect_position`, `set_view`, `get_view`), so software can search
the sky with the same tool people use.

**What it has found**

To test it, an AI agent ran the tool over about 1,000 fields, first through the WebMCP tools and
then with a script that runs the same code.

- Barnard's Star, found without being told where to look: 9.97 arcseconds per year (Gaia: 10.39).
  Teegarden's Star and Epsilon Indi were recovered to within 1%.
- In 608 fields away from the Milky Way, 19 fast-moving stars were picked out, with speeds that
  match the CatWISE and Gaia catalogues. All 19 were already known. No new moving object was found.
- 14 stars show brightness changes that are not recorded in SIMBAD, the AAVSO Variable Star Index
  (VizieR copy), Gaia DR3 or the ZTF and WISE variable-star catalogues. Each is confirmed as
  variable by ten years of independent NEOWISE measurements. They are listed in the repository with
  draft reports for the AAVSO.

Limits, stated plainly: the 14 candidates have not been confirmed by anyone else; stars like these
are common in the Milky Way, so they are new to the catalogues rather than rare; SPHEREx's 6
arcsecond pixels make faint sources hard to place, which caused false alarms the scan now rejects;
and the coldest known brown dwarf, WISE 0855, is too faint for SPHEREx single exposures.

**Why it matters**

Most nearby brown dwarfs found in recent years were spotted by volunteers comparing WISE images by
eye. SPHEREx adds a new all-sky map every six months with a spectrum at every point, and each new
pass makes motion easier to see. Spherical gives the public, students and researchers a direct way
to look, and gives software agents the same access.

**Tools and languages**

HTML, CSS, JavaScript, WebGPU (WGSL shaders), Cloudflare Pages, Functions and R2, Node.js for the
offline scan scripts. No frameworks or build step.

## Use of Artificial Intelligence

The task comes from the challenge statement: a public tool that takes a sky position and shows
SPHEREx images of it over time. The team chose the challenge and the technology, decided which
features to build, directed the design, and reviewed and tested the results.

An AI coding assistant (Anthropic's Claude, used through Claude Code) was used for:

- proposing the technical plan and writing the code of the website, the server functions and the
  scan scripts;
- drafting the wording of the site, the README, the slides and this submission;
- running the tool over about 1,000 fields and checking flagged sources against astronomical
  catalogues.

This is acknowledged on the site's start page, in the README, on the last slide, in the page
metadata and in the commit history (AI-assisted commits carry a co-author line).

No image, video or audio in the project is AI-generated. Every sky image is real data from NASA's
SPHEREx and WISE missions, processed by the project's code. The 3D mission diagram is a schematic
drawn by code in the browser and is labelled as a diagram that is not to scale. No NASA logos or
branding are used.

## NASA Data

- **SPHEREx Level 2 spectral images** (releases DR1 and QR3): images, quality flags, variance and
  wavelength maps. Found through the IRSA image search service and read from NASA's public SPHEREx
  bucket on AWS Open Data. This is the core of the tool.
  https://irsa.ipac.caltech.edu/Missions/spherex.html
- **AllWISE Atlas images** (WISE, 2010): the earlier image that gives each field a 16-year baseline
  for motion. https://irsa.ipac.caltech.edu/Missions/wise.html
- **NEOWISE-R Single Exposure Source Table**: ten years of brightness measurements, used to confirm
  that the stars flagged by the tool really vary.
- **CatWISE2020 catalogue**: independent proper motions, used to check every motion flag.
- **2MASS and AllWISE source catalogues**: names and earlier brightness of flagged sources.
- **NASA/IPAC Infrared Science Archive (IRSA)** services: SIA image search, Gator catalogue queries.
  https://irsa.ipac.caltech.edu
- Backyard Worlds: Planet 9 and WiseView (NASA-funded citizen science) inspired the approach, and
  the tool links to WiseView for each position.

## Space Agency Partner Data and Other References

- **ESA Gaia Data Release 3** (European Space Agency), through the ESA Gaia Archive: positions,
  motions and variability flags of known stars. https://gea.esac.esa.int/archive/
- **CDS Strasbourg**: Sesame name resolver, SIMBAD and VizieR (with the Harvard CfA mirrors), for
  turning names into coordinates and checking what is already known. https://cds.unistra.fr
- **AAVSO International Variable Star Index (VSX)**, via VizieR. https://www.aavso.org/vsx/
- Variable-star catalogues used for checks: Chen et al. 2020 (ZTF periodic variables), Petrosky et
  al. 2021 and Chen et al. 2018 (WISE variables), and two catalogues of AGB stars from VizieR.
- **Cloudflare** Pages, Workers Functions and R2 (hosting and cache).
- **AWS Open Data** (hosts NASA's SPHEREx and WISE image buckets).
- **Google Fonts**: Archivo and IBM Plex Mono (SIL Open Font License).
- **WebGPU** and **WebMCP** browser interfaces.
- **Claude** by Anthropic (see Use of Artificial Intelligence).
- SPHEREx mission facts: NASA/JPL-Caltech SPHEREx pages. https://science.nasa.gov/mission/spherex/
