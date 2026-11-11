import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import './coverPeek.css';

// ─── Cover thumbnail that enlarges (2026-10-28) ──────────────────
// Comic Vine search results show 34×48 covers. With a mouse, hovering shows a
// larger cover beside the thumbnail; on a phone, tapping it shows the cover
// full screen until the next tap (Escape also closes it, without closing the
// dialog underneath). `image` is a Comic Vine image object.
const PEEK_W = 240, PEEK_H = 360, GAP = 12, EDGE = 8;

export default function CoverPeek({ image, width = 34, height = 48, className = '' }) {
  const thumb = image?.thumb_url || image?.small_url;
  const big = image?.medium_url || image?.super_url || image?.small_url || thumb;
  const [peek, setPeek] = useState(null);   // { mode: 'hover', rect } | { mode: 'tap' }
  const ref = useRef(null);
  const pointer = useRef(null);   // type of the last press on the thumbnail

  useEffect(() => {
    if (peek?.mode !== 'tap') return undefined;
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setPeek(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek?.mode]);

  if (!thumb) return <div className={`cover-peek-blank ${className}`} style={{ width, height }} />;

  const show = () => ref.current && setPeek({ mode: 'hover', rect: ref.current.getBoundingClientRect() });
  let layer = null;
  if (peek?.mode === 'hover') {
    const r = peek.rect, vw = window.innerWidth, vh = window.innerHeight;
    const left = r.right + GAP + PEEK_W + EDGE <= vw ? r.right + GAP : Math.max(EDGE, r.left - GAP - PEEK_W);
    const top = Math.min(Math.max(EDGE, r.top + r.height / 2 - PEEK_H / 2), vh - PEEK_H - EDGE);
    layer = (
      <div className="cover-peek-float" style={{ left, top, width: PEEK_W, height: PEEK_H, backgroundImage: `url("${thumb}")` }} aria-hidden="true">
        <img src={big} alt="" />
      </div>
    );
  } else if (peek?.mode === 'tap') {
    layer = (
      <div className="cover-peek-full" role="presentation"
        onClick={e => { e.stopPropagation(); setPeek(null); }}
        onMouseDown={e => e.stopPropagation()}>
        <img src={big} alt="Cover, enlarged" />
      </div>
    );
  }

  return (
    <>
      <img ref={ref} src={thumb} alt="" className={`cover-peek-thumb ${className}`} style={{ width, height }}
        onPointerEnter={e => { if (e.pointerType === 'mouse') show(); }}
        onPointerLeave={e => { if (e.pointerType === 'mouse') setPeek(p => (p?.mode === 'hover' ? null : p)); }}
        onPointerDown={e => { pointer.current = e.pointerType; }}
        // Opened on click, not pointer-up: the tap's own click would otherwise
        // land on the new full-screen cover and close it at once.
        onClick={() => { if (pointer.current && pointer.current !== 'mouse') setPeek({ mode: 'tap' }); }} />
      {layer && ReactDOM.createPortal(layer, document.body)}
    </>
  );
}
