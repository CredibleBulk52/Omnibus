import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../manageMenu.css';

// ─── Shared "Manage ⌄" menu (Series, Comic box, reading orders) ───
// One look and one behaviour for every page (user 2026-10-26: the Comic box
// style). The caller owns `open` so items can close it after acting. Clicking
// outside or pressing Escape closes it; Escape returns focus to the button.
// The panel is drawn on the page body, fixed under the button (2026-11-05): inside
// the reading-order hero (overflow hidden) it was cut off and could not be seen.
// It takes the page palette (--rl-theme-*) from the button, since it no longer
// sits inside the themed page, and keeps the caller's class for its styles.
const THEME_VARS = ['--rl-theme-accent', '--rl-theme-panel', '--rl-theme-text', '--rl-theme-muted', '--rl-theme-on-accent', '--rl-theme-banner', '--rl-theme-banner-accent'];
const GAP = 8, EDGE = 8;

export default function ManageMenu({ id, open, setOpen, width, label = 'Manage', className = '', children }) {
  const wrap = useRef(null), trigger = useRef(null), panel = useRef(null);
  const [place, setPlace] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const measure = () => {
      const btn = trigger.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const css = getComputedStyle(btn);
      const vars = {};
      for (const v of THEME_VARS) { const val = css.getPropertyValue(v); if (val) vars[v] = val.trim(); }
      const top = r.bottom + GAP;
      setPlace({
        top, right: Math.max(EDGE, window.innerWidth - r.right),
        maxHeight: Math.max(160, window.innerHeight - top - EDGE), vars,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (event.target.closest?.('.rl-modal-overlay')) return;
      if (!wrap.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => { if (event.key === 'Escape' && !document.querySelector('.rl-modal-overlay')) { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, setOpen]);

  const style = place && { ...place.vars, top: place.top, right: place.right, maxHeight: place.maxHeight, ...(width ? { width } : null) };
  return (
    <div className={`manage-menu${className ? ` ${className}` : ''}`} ref={wrap}>
      <button type="button" className="btn btn-secondary manage-menu-toggle" ref={trigger}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{label} ⌄</button>
      {open && createPortal(
        <div className={`manage-menu-layer${className ? ` ${className}` : ''}`}>
          <div className="manage-menu-panel" id={id} ref={panel} style={style || { visibility: 'hidden' }}>{children}</div>
        </div>, document.body)}
    </div>
  );
}
