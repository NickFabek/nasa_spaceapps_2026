// What an agent-driven scan with this tool has turned up so far. Each entry opens the view that shows it.
// Every flagged source was checked against SIMBAD, Gaia DR3, 2MASS and AllWISE before being listed.
export const FOUND = [
  {
    kind: 'Caught changing', name: 'IRAS 18274−0205',
    what: 'A protostar in Serpens South. In Sep 2025 it was several times fainter than in 1999 or 2010; a year later it had brightened four- to six-fold.',
    url: '?ra=277.51&dec=-2.05&fov=10&bands=3456&at=-15.7,-42.7',
  },
  {
    kind: 'Recovered', name: 'V371 Serpentis',
    what: 'A protostar known to erupt every 18 months. The scan found it 74% fainter in Sep 2026 than in Sep 2025.',
    url: '?ra=277.49&dec=1.23&fov=10&bands=3456&at=-95.9,171.4',
  },
  {
    kind: 'Caught changing', name: 'IRAS 16253−2429',
    what: 'A newborn star in Ophiuchus, 56% fainter in Aug 2026 than a year before.',
    url: '?ra=247.1&dec=-24.6&fov=10&bands=3456&at=-32.6,-24.2',
  },
  {
    kind: 'Caught changing', name: '2MASS J03290907+3121291',
    what: 'A young star in NGC 1333, 77% brighter in Aug 2026 than a year before.',
    url: '?ra=52.27&dec=31.33&fov=10&at=54.6,101.6',
  },
  {
    kind: 'Recovered', name: "Barnard's Star",
    what: 'Measured blind at 9.97″ a year from the 2010 and 2026 images. Gaia says 10.39.',
    url: "?ra=269.44607&dec=4.77071&fov=6&name=Barnard's+Star",
  },
];
export const FOUND_NOTE = 'From a scan of 28 fields (10,691 exposures) run by an AI agent through this page. Every source it flagged was checked against SIMBAD, Gaia, 2MASS and AllWISE, and all are catalogued objects: nothing new to science yet. Two early candidates were rejected as stray light from bright neighbours.';
