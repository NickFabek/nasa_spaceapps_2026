// What agent-driven scans with this tool have turned up. Each entry opens the view that shows it.
// Every flagged source was checked against SIMBAD, the AAVSO Variable Star Index, Gaia DR3 (including
// its variability tables), 2MASS, AllWISE and the ZTF, WISE and AGB variable-star catalogues, and its
// variability was confirmed independently with ten years of NEOWISE photometry. Full list: submissions/candidates.md
export const FOUND = [
  {
    kind: 'New candidate', name: 'Gaia DR3 2054043683842071424',
    what: 'A star known only for hydrogen emission. Quiet until 2020, then repeated infrared outbursts; SPHEREx caught a new one growing, up 77% at 4.7 µm in a year.',
    url: '?ra=303.11985&dec=31.78993&fov=6&at=0,0',
  },
  {
    kind: 'New candidate', name: '2MASS J19262114+1813483',
    what: 'A dust-hidden star, 36–68% fainter at 2–5 µm in Sep 2026 than a year before. Older NEOWISE data show it swings by 1.6 magnitudes.',
    url: '?ra=291.58812&dec=18.23002&fov=6&bands=3456&at=0,0',
  },
  {
    kind: 'New candidate', name: '2MASS J18483503+0025511',
    what: 'An extremely red giant in the Galactic plane, a third brighter at 2–5 µm than a year before. NEOWISE shows 1.2-magnitude swings.',
    url: '?ra=282.14604&dec=0.43108&fov=6&bands=3456&at=0,0',
  },
  {
    kind: 'New candidate', name: '2MASS J20294781+4024376',
    what: 'No SIMBAD entry. Brightened through all three passes, 13% at 1.4 µm and 35% at 4.7 µm.',
    url: '?ra=307.44909&dec=40.41053&fov=6&at=0,0',
  },
  {
    kind: 'Caught changing', name: 'Serpens protostar [HMH2007] 67',
    what: 'Invisible below 2.4 µm. Four to five times brighter at 4–5 µm in Sep 2025 than in either 2026 pass.',
    url: '?ra=277.27588&dec=0.51176&fov=6&bands=56&at=0,0',
  },
  {
    kind: 'Recovered', name: "Barnard's Star",
    what: 'Measured blind at 9.97″ a year from the 2010 and 2026 images. Gaia says 10.39.',
    url: "?ra=269.44607&dec=4.77071&fov=6&name=Barnard's+Star",
  },
];
export const FOUND_NOTE = 'Four of 14 new variable-star candidates from scans of about 430 fields run by an AI agent. Each changed in SPHEREx data, varies in ten years of independent NEOWISE data, and has no variability on record in SIMBAD, the AAVSO index, Gaia DR3 or the ZTF, WISE and AGB catalogues checked. None is confirmed by anyone else yet.';
