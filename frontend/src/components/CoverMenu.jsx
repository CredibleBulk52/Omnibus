import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../seriesCardMenu.css';

// ─── ⋮ on a cover: the button and its panel (2026-11-04) ─────────────────────
// Shared by the series menu (SeriesCardMenu) and the issue menu (IssueCardMenu).
// The panel is drawn on the page body, placed under the button, so a shelf never
// clips it; it closes on a click outside, Escape, scrolling or resizing.
// children(close): the menu items. onOpen(): called each time it opens.
export default function CoverMenu({ label, heading, onOpen, className = '', children }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const toggle = useRef(null), panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const r = toggle.current?.getBoundingClientRect();
    if (r) setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 200), left: Math.max(8, Math.min(r.left, window.innerWidth - 218)) });
    const outside = e => { if (!panel.current?.contains(e.target) && !toggle.current?.contains(e.target)) setOpen(false); };
    const escape = e => { if (e.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    onOpen?.();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const stop = e => { e.stopPropagation(); e.preventDefault(); };
  return <>
    <button type="button" ref={toggle} className={`scm-toggle${className ? ` ${className}` : ''}${open ? ' is-open' : ''}`} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} onClick={e => { stop(e); setOpen(o => !o); }}>
      <span aria-hidden="true">⋮</span>
    </button>
    {open && pos && createPortal(
      <div className="scm-panel" role="menu" ref={panel} style={{ top: pos.top, left: pos.left }} onClick={e => e.stopPropagation()}>
        {heading && <div className="scm-title">{heading}</div>}
        {children(() => setOpen(false))}
      </div>, document.body)}
  </>;
}
