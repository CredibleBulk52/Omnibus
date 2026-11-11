// Event tiers: one set of names and colours for every page (2026-10-26).
// Essential is Comic yellow everywhere (user choice), matching the Event pages.
export const TIER_LABEL = { essential: 'Essential', recommended: 'Recommended', 'tie-in': 'Tie-in', aftermath: 'Aftermath' };
export const TIER_COLOUR = { essential: '#f5c518', recommended: '#4caa60', 'tie-in': '#8a8a98', aftermath: '#4a8ccc' };
export const tierColour = tier => TIER_COLOUR[tier] || TIER_COLOUR['tie-in'];
