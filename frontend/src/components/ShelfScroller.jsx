import React, { useEffect, useRef, useState } from 'react';

export default function ShelfScroller({ label, id, count, children, renderHeader, className = '', railClassName = '', cardSelector = '.ts-book', hideWhenFits = false }) {
  const rail = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  useEffect(() => {
    const node = rail.current;
    const update = () => setEdges({
      start: node.scrollLeft <= 2,
      end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 2,
    });
    update();
    node.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    return () => { node.removeEventListener('scroll', update); resize.disconnect(); };
  }, [count]);
  const move = (direction) => {
    const node = rail.current;
    const card = node.querySelector(cardSelector);
    const step = card ? card.getBoundingClientRect().width + parseFloat(getComputedStyle(node).columnGap || 0) : node.clientWidth;
    const distance = Math.max(1, Math.floor((node.clientWidth - 40) / step)) * step;
    node.scrollBy({ left: direction * distance, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const overflow = !(edges.start && edges.end);
  const controls = hideWhenFits && !overflow ? null : (
    <div className="ts-scroll-controls" role="group" aria-label={`${label} navigation`}>
        <button type="button" aria-label={`Previous comics in ${label}`} aria-controls={id} disabled={edges.start} onClick={() => move(-1)}>←</button>
        <button type="button" aria-label={`Next comics in ${label}`} aria-controls={id} disabled={edges.end} onClick={() => move(1)}>→</button>
      </div>
  );
  return (
    <div className={`ts-scroller ${className}`}>
      {renderHeader(controls, overflow)}
      <div className={`ts-books ${railClassName}`} id={id} ref={rail} tabIndex={count ? 0 : undefined} role="region" aria-label={label}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}>
        {children}
      </div>
    </div>
  );
}
