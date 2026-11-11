import React, { useEffect, useRef } from 'react';
import '../comicInkTitle.css';

export default function ComicInkTitle({ title, as: Heading = 'h1', className = '', emblem = null }) {
  const ref = useRef(null);
  // Only explicit subtitles are split; long names wrap naturally at spaces.
  const colon = title.indexOf(':');
  const main = colon > 0 ? title.slice(0, colon).trim() : title;
  const subtitle = colon > 0 ? title.slice(colon + 1).trim() : '';
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const fit = () => {
      if (cancelled || !el.clientWidth) return;
      el.style.removeProperty('--csh-title-size');
      const face = el.querySelector('.csh-title-face');
      let size = parseFloat(getComputedStyle(face).fontSize);
      // Reduce only when a single word cannot fit; never truncate a series name.
      while (face.scrollWidth > el.clientWidth - 10 && size > 18) {
        size--; el.style.setProperty('--csh-title-size', size + 'px');
      }
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; observer?.observe(el);
    window.addEventListener('resize', fit);
    document.fonts?.ready.then(fit); fit();
    return () => { cancelled = true; observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [title]);
  return <Heading className={`csh-title ${className}`} ref={ref} aria-label={title}>
    {emblem}
    <span className="csh-title-face"><span className="csh-title-depth" aria-hidden="true">{main}</span>{main}</span>
    {subtitle && <span className="csh-subtitle">{subtitle}</span>}
  </Heading>;
}

