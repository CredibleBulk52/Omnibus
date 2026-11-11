import { useEffect, useState } from 'react';
import { FALLBACK_PALETTE, sampleSeriesPalette } from '../themes/seriesPalette.mjs';

const cache = new Map();

// Reading orders use the same artwork/upper-cover/highlight roles as series.
export default function useCoverPalette(bookId) {
  const [sample, setSample] = useState(null);
  useEffect(() => {
    if (!bookId) return;
    if (cache.has(bookId)) {
      setSample({ id: bookId, palette: cache.get(bookId) });
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 96; canvas.height = 144;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 96, 144);
        const palette = sampleSeriesPalette(context.getImageData(0, 0, 96, 144).data, 96, 144);
        if (cache.size >= 200) cache.delete(cache.keys().next().value);
        cache.set(bookId, palette);
        setSample({ id: bookId, palette });
      } catch { /* Missing or unreadable artwork retains the neutral fallback. */ }
    };
    image.src = `/api/books/${encodeURIComponent(bookId)}/thumbnail`;
    return () => { cancelled = true; image.onload = null; };
  }, [bookId]);
  return bookId && sample?.id === bookId ? sample.palette : FALLBACK_PALETTE;
}
