// What agent-driven scans with this tool have turned up. Each entry opens the view that shows it.
// Every flagged source was checked against SIMBAD, the AAVSO Variable Star Index, Gaia DR3 (including
// its variability tables), 2MASS, AllWISE and the ZTF and WISE variable-star catalogues before listing.
export const FOUND = [
  {
    kind: 'New candidate', name: '2MASS J20355040+4349233',
    what: 'A very red star in Cygnus with no SIMBAD entry and no variability on record. It dimmed 13–24% in five infrared bands in a year while its neighbours stayed flat.',
    url: '?ra=308.95999&dec=43.82317&fov=6&bands=3456&at=0,0',
  },
  {
    kind: 'New candidate', name: 'Gaia DR3 2054043683842071424',
    what: 'A star known only for hydrogen emission. Its infrared excess grew across three passes, by 23% at 1.4 µm and 77% at 4.7 µm, while its visible light held steady.',
    url: '?ra=303.11985&dec=31.78993&fov=6&at=0,0',
  },
  {
    kind: 'Caught changing', name: 'Serpens protostar [HMH2007] 67',
    what: 'Invisible below 2.4 µm. Four to five times brighter at 4–5 µm in Sep 2025 than in either 2026 pass.',
    url: '?ra=277.27588&dec=0.51176&fov=6&bands=56&at=0,0',
  },
  {
    kind: 'Caught changing', name: 'IRAS 18274−0205',
    what: 'A protostar in Serpens South. Fainter in Sep 2025 than in 1999 or 2010; a year later it had brightened four- to six-fold.',
    url: '?ra=277.51&dec=-2.05&fov=10&bands=3456&at=-15.7,-42.7',
  },
  {
    kind: 'Recovered', name: 'V371 Serpentis',
    what: 'A protostar known to erupt every 18 months. The scan found it 74% fainter in Sep 2026 than in Sep 2025.',
    url: '?ra=277.49&dec=1.23&fov=10&bands=3456&at=-95.9,171.4',
  },
  {
    kind: 'Recovered', name: "Barnard's Star",
    what: 'Measured blind at 9.97″ a year from the 2010 and 2026 images. Gaia says 10.39.',
    url: "?ra=269.44607&dec=4.77071&fov=6&name=Barnard's+Star",
  },
];
export const FOUND_NOTE = 'From scans of about 175 fields run by an AI agent through this page\'s WebMCP tools. "New candidate" means the change is real in SPHEREx data and the star is not listed as variable in SIMBAD, the AAVSO index, Gaia DR3 or the ZTF and WISE variable catalogues. It still needs independent confirmation.';
