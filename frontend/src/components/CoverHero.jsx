import React, { useEffect, useState } from 'react';
import '../coverHero.css';
import { useAppearance } from './appearance';

const palettes = new Map();
const FALLBACK = '155, 170, 190';

// Group colourful pixels by hue so black ink and cream paper cannot dominate.
export function coverAccent(pixels) {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, rgb: [0, 0, 0] }));
  for (let i = 0; i < pixels.length; i += 4) {
    const rgb = Array.from(pixels.slice(i, i + 3));
    const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
    if (pixels[i + 3] < 128 || max < 65 || delta < 40 || delta / max < 0.3) continue;
    let hue = max === rgb[0] ? (rgb[1] - rgb[2]) / delta : max === rgb[1] ? 2 + (rgb[2] - rgb[0]) / delta : 4 + (rgb[0] - rgb[1]) / delta;
    hue = (hue * 60 + 360) % 360;
    const bin = bins[Math.floor(hue / 15)];
    const weight = delta / 255;
    bin.weight += weight;
    rgb.forEach((v, k) => { bin.rgb[k] += v * weight; });
  }
  const best = bins.reduce((a, b) => b.weight > a.weight ? b : a);
  if (!best.weight) return FALLBACK;
  const rgb = best.rgb.map(v => v / best.weight);
  // Lift the accent for dark backgrounds while retaining its hue.
  const lift = Math.max(0, (175 - Math.max(...rgb)) / (255 - Math.max(...rgb)));
  const bright = rgb.map(v => v + (255 - v) * lift);
  const luminance = values => values.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, k) => sum + v * [0.2126, 0.7152, 0.0722][k], 0);
  while (luminance(bright) < 0.3) bright.forEach((v, k) => { bright[k] = v + (255 - v) * 0.05; });
  return bright.map(Math.round).join(', ');
}

export function CoverStack({ bookIds = [], emptyText = 'Nothing owned yet' }) {
  const [failed, setFailed] = useState([]);
  const covers = [...new Set(bookIds.filter(Boolean))].slice(0, 3).filter(id => !failed.includes(id)).reverse();
  return <div className={`cover-stack cover-stack-${covers.length}`} aria-label="Cover artwork">
    {covers.length ? covers.map(id => <img key={id} src={`/api/books/${id}/thumbnail`} alt="" onError={() => setFailed(prev => [...prev, id])} />) : <span className="cover-stack-empty">{emptyText}</span>}
  </div>;
}

export function useCoverAccent(bookId) {
  const [palette, setPalette] = useState(null);
  useEffect(() => {
    if (!bookId) return;
    if (palettes.has(bookId)) { setPalette({ id: bookId, rgb: palettes.get(bookId) }); return; }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 48;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 48, 48);
        const rgb = coverAccent(context.getImageData(0, 0, 48, 48).data);
        if (palettes.size >= 200) palettes.delete(palettes.keys().next().value);
        palettes.set(bookId, rgb);
        setPalette({ id: bookId, rgb });
      } catch { /* Unavailable artwork keeps the neutral palette. */ }
    };
    image.src = `/api/books/${bookId}/thumbnail`;
    return () => { cancelled = true; image.onload = null; };
  }, [bookId]);
  return palette && palette.id === bookId ? palette.rgb : FALLBACK;
}

export default function CoverHero({ bookId, className = '', style, children, inheritPalette = false }) {
  const { pageColors, colors } = useAppearance();
  const sampled = useCoverAccent(inheritPalette || !pageColors ? null : bookId);
  // Page colours off: the hero takes the user's highlight instead of the cover's colour.
  const rgb = pageColors ? sampled : [1, 3, 5].map(i => parseInt((colors?.highlight || '#f5c518').slice(i, i + 2), 16)).join(', ');
  return <div className={`cover-coloured-hero ${className}`} style={{ ...style, ...(!inheritPalette ? {'--cover-rgb': rgb} : {}) }}>{children}</div>;
}
