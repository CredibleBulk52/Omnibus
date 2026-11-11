export const FALLBACK_PALETTE = { main: '#617b91', secondary: '#435568', highlight: '#e8e9dc' };
const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? 0 : ((max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d) * 60 + 360) % 360;
  return [h, max ? d / max : 0, max / 255];
}
function clusters(pixels, width, height, topOnly) {
  const bins = new Map();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Central upper region reduces publisher/price labels in the corners.
    if (topOnly && (y < height * .02 || y >= height * .30 || x < width * .17 || x >= width * .95)) continue;
    const i = (y * width + x) * 4;
    if (pixels[i + 3] < 128) continue;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]], [h, s, v] = hsv(rgb);
    const key = `${Math.floor(h / 20)}:${Math.floor(s * 5)}:${Math.floor(v * 6)}`;
    const bin = bins.get(key) || { count: 0, sum: [0, 0, 0] };
    bin.count++; rgb.forEach((c, k) => { bin.sum[k] += c; }); bins.set(key, bin);
  }
  return [...bins.values()].map(b => { const rgb = b.sum.map(v => v / b.count); return { count: b.count, rgb, hsv: hsv(rgb) }; });
}
const best = (items, score) => items.reduce((a, b) => !a || score(b) > score(a) ? b : a, null);
const strength = b => b.count * b.hsv[1] * b.hsv[2];
const distance = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 360 - d); };

// Three independent roles: artwork, contrasting upper-cover color, light highlight.
// This is a regional color heuristic, not OCR or logo detection.
export function sampleSeriesPalette(pixels, width, height) {
  if (!width || !height || pixels.length !== width * height * 4) return { ...FALLBACK_PALETTE };
  const full = clusters(pixels, width, height, false), top = clusters(pixels, width, height, true);
  const main = best(full.filter(b => b.hsv[1] > .18 && b.hsv[2] > .25 && b.hsv[2] < .92), strength);
  if (!main) return { ...FALLBACK_PALETTE };
  const contrasting = items => items.filter(b => b.count >= width * height * .002 && b.hsv[1] > .22 && b.hsv[2] > .30 && distance(b.hsv[0], main.hsv[0]) > 35);
  const secondary = best(contrasting(top), strength) || best(contrasting(full), strength);
  const light = best(full.filter(b => b.hsv[2] > .82 && b.hsv[1] < .18), b => b.count * (.1 + b.hsv[1]));
  return {
    main: hex(main.rgb),
    secondary: secondary ? hex(secondary.rgb) : hex(main.rgb.map(v => v * .65)),
    highlight: light ? hex(light.rgb) : '#f0edda',
  };
}
