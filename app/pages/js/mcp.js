// WebMCP: expose the tool to AI agents as callable functions.
//
// Chrome's WebMCP API is `document.modelContext` (registerTool / getTools /
// executeTool; behind an origin trial at the time of writing). Where the browser
// does not provide it, a small stand-in with the same three methods is installed
// so that an agent able to run script in the page can still discover and call
// the tools the same way:
//
//   const tools = await document.modelContext.getTools();
//   await document.modelContext.executeTool(tools.find(t => t.name === 'look_at_sky'), { target: 'Barnard star' });

function installStandIn() {
  const tools = new Map(), target = new EventTarget();
  const ctx = {
    standIn: true,
    async registerTool(tool, opts = {}) {
      if (tools.has(tool.name)) throw new DOMException(`Tool "${tool.name}" is already registered`, 'InvalidStateError');
      tools.set(tool.name, tool);
      opts.signal?.addEventListener('abort', () => { tools.delete(tool.name); target.dispatchEvent(new Event('toolchange')); });
      target.dispatchEvent(new Event('toolchange'));
    },
    async getTools() {
      return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, title: t.title || '', description: t.description, inputSchema: t.inputSchema, annotations: t.annotations || {}, origin: location.origin }));
    },
    async executeTool(tool, input = {}, opts = {}) {
      const t = tools.get(typeof tool === 'string' ? tool : tool?.name);
      if (!t) throw new DOMException('Unknown tool', 'NotFoundError');
      return t.execute(input || {}, { signal: opts.signal });
    },
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
  };
  Object.defineProperty(document, 'modelContext', { value: ctx, configurable: true });
  return ctx;
}

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });

/** @param api functions supplied by app.js */
export async function registerTools(api) {
  const ctx = document.modelContext || navigator.modelContext || installStandIn();
  const text = (o) => JSON.stringify(o);
  const tools = [
    {
      name: 'look_at_sky',
      description: 'Load NASA SPHEREx infrared images of a patch of sky and wait until they have arrived. Give an object name ("Barnard\'s Star"), coordinates in degrees ("269.446 4.771") or sexagesimal, or "random" for a random patch away from the Milky Way. Returns how many exposures and telescope passes were found, plus the sources that moved or changed brightness. Takes 20-90 seconds.',
      inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Object name, "RA Dec" coordinates, or "random".' }, field_arcmin: num('Width of the patch in arcminutes.', { enum: [3, 6, 10, 15, 20] }) }, required: ['target'] },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async ({ target, field_arcmin }) => text(await api.look(String(target), field_arcmin)),
    },
    {
      name: 'list_changes',
      description: 'For the field currently loaded: every detected source with its position, whether the Gaia catalogue knows it, how far it moved between the 2010 WISE image and SPHEREx, and whether its brightness changed between SPHEREx passes. Sources flagged "moved" or "changed" that are "unlisted" (not in Gaia) are the interesting ones.',
      inputSchema: { type: 'object', properties: { only_flagged: { type: 'boolean', description: 'Return only sources that moved, changed or are not in Gaia. Default true.' }, limit: num('Maximum number of sources. Default 40.') } },
      annotations: { readOnlyHint: true },
      execute: async ({ only_flagged = true, limit = 40 }) => text(api.changes(only_flagged, limit)),
    },
    {
      name: 'inspect_position',
      description: 'Measure one position in the loaded field: the nearest Gaia star (if any), and the infrared spectrum from every SPHEREx exposure, summarised as the median flux in mJy per telescope pass and wavelength band, plus the percentage change per band between passes measured only at matched wavelengths (trust this over comparing the medians). Also selects that spot in the page so the user sees it.',
      inputSchema: { type: 'object', properties: { ra: num('Right ascension in degrees.'), dec: num('Declination in degrees.') }, required: ['ra', 'dec'] },
      annotations: { readOnlyHint: true },
      execute: async ({ ra, dec }) => text(api.inspect(+ra, +dec)),
    },
    {
      name: 'set_view',
      description: 'Change how the loaded field is displayed. mode: "blink" (one image per telescope pass), "difference" (one pass minus another), "stack" (add all exposures along a motion) or "exposures" (single images). bands: which of the six detectors to include, 1 (0.75 µm) to 6 (5 µm). motion_east / motion_north: trial motion in arcsec per year for stack mode. play: start or stop the blink.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['blink', 'difference', 'stack', 'exposures'] },
          bands: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 6 }, description: 'Detectors to include, e.g. [5,6].' },
          motion_east: num('Arcsec per year toward east, for stack mode.'), motion_north: num('Arcsec per year toward north, for stack mode.'),
          known_stars: { type: 'boolean', description: 'Show rings on Gaia stars.' }, wise_2010: { type: 'boolean', description: 'Include the 2010 WISE image as an extra pass.' },
          play: { type: 'boolean' },
        },
      },
      execute: async (args) => text(api.setView(args || {})),
    },
    {
      name: 'get_view',
      description: 'What is on screen now: target position, field size, display mode, bands, telescope passes with dates and exposure counts, and a shareable link that reproduces the view.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => text(api.view()),
    },
  ];
  for (const t of tools) await ctx.registerTool(t);
  return { native: !ctx.standIn, count: tools.length };
}
