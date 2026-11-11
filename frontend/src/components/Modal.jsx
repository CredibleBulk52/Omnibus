import React, { useEffect, useRef } from 'react';
import '../modal.css';

const open = [];   // dialogs currently open, newest last: Escape closes only the top one
let pageOverflow = '';

// ─── Shared dialog (2026-10-26) ───────────────────────────────────
// The reading lists' Comic dialog, now used everywhere: red title band, black
// ink frame, footer for buttons. Escape or a click on the backdrop closes it;
// focus moves into the dialog and returns to where it was on close; the page
// (closeOnBackdrop={false} for dialogs holding work in progress, e.g. a search)
// behind does not scroll while it is open.
export default function Modal({ title, onClose, children, footer, width = 520, initialFocus, closeOnBackdrop = true, className = '' }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;   // callers often pass a new function each render
  const focusFirst = useRef(initialFocus);
  useEffect(() => {
    const before = document.activeElement;
    const me = {};
    open.push(me);
    const onKey = e => { if (e.key === 'Escape' && open[open.length - 1] === me) { e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', onKey);
    if (open.length === 1) { pageOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    const target = (focusFirst.current && box.current?.querySelector(focusFirst.current)) || box.current;
    // A field that took focus itself (autoFocus) keeps it.
    if (!box.current?.contains(document.activeElement)) target?.focus?.();
    return () => {
      open.splice(open.indexOf(me), 1);
      window.removeEventListener('keydown', onKey);
      if (!open.length) document.body.style.overflow = pageOverflow;
      if (before && before.focus && document.contains(before)) before.focus();
    };
  }, []);   // once per opening: callbacks are read through refs
  return (
    <div className="rl-modal-overlay" onMouseDown={e => closeOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div className={`rl-modal ${className}`} style={{ width }} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        ref={box} tabIndex={-1} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
        <div className="rl-modal-head">
          <div className="rl-modal-title">{title}</div>
          <button type="button" className="rl-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
        {footer && <div className="rl-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
