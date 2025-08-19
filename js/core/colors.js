// Color helpers for pills, dots, and filters.
// Uses Okabe–Ito palette for better color-blind distinguishability.
// https://jfly.uni-koeln.de/color/

// Official DLC/module specific dot colors
const OFFICIAL_COLORS = {
  Core:     'rgb(122,160,255)', // tasteful blue that fits RimWorld
  Anomaly:  'rgb(58,62,41)',    // requested
  Biotech:  'rgb(125,179,179)', // requested
  Ideology: 'rgb(179,125,125)', // requested
  Royalty:  'rgb(179,179,125)', // requested
  Odyssey:  'rgb(255,255,255)'  // requested
};
const OFFICIAL_FALLBACK = 'rgb(122,160,255)';

// Okabe–Ito palette picks (distinct, color-blind-friendly)
const WORKSHOP_DOT = '#E69F00'; // orange
const DEV_DOT      = '#009E73'; // bluish green
const DEFTYPE_DOT  = '#0072B2'; // blue

// Layer chip colors (align with dots)
export function srcColor(layer) {
  switch (layer) {
    case 'official': return OFFICIAL_FALLBACK; // Core blue baseline
    case 'workshop': return WORKSHOP_DOT;
    case 'dev':      return DEV_DOT;
    default:         return '#9aa7b4';
  }
}

// Mod dot color based on layer/name
export function modColor(layer, modName) {
  if (layer === 'official') return OFFICIAL_COLORS[modName] || OFFICIAL_FALLBACK;
  if (layer === 'workshop') return WORKSHOP_DOT;
  if (layer === 'dev')      return DEV_DOT;
  return '#8fa0b3';
}

// Single dot color for def types
export function defTypeColor() {
  return DEFTYPE_DOT;
}

// Legacy fallback (hash → HSL) if ever needed for arbitrary labels
export function tintForLabel(label) {
  const s = String(label || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}deg 50% 60%)`;
}
