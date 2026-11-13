import React, { useEffect, useState, useRef } from 'react';
import '../coverSize.css';

const KEY = 'omnibus.cover-size';
const EVENT = 'omnibus:cover-size';
export const COVER_WIDTHS = { small:110, medium:150, large:210 };
let current;
function read() {
  try { const value = localStorage.getItem(KEY); return Object.hasOwn(COVER_WIDTHS,value) ? value : 'medium'; }
  catch { return 'medium'; }
}
current = read();
export function useCoverSize() {
  const [size, setSize] = useState(() => current);
  useEffect(() => {
    const sync = () => setSize(current);
    const storage = e => { if(e.key === KEY || e.key === null) { current = read(); window.dispatchEvent(new Event(EVENT)); } };
    window.addEventListener(EVENT,sync); window.addEventListener('storage',storage); sync();
    return () => { window.removeEventListener(EVENT,sync); window.removeEventListener('storage',storage); };
  }, []);
  const change = value => {
    if (!Object.hasOwn(COVER_WIDTHS,value)) return;
    current = value;
    try { localStorage.setItem(KEY,value); } catch { /* Keep preference for this session. */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return { size, width:COVER_WIDTHS[size], setSize:change };
}
export default function CoverSizeControl() {
  const {size,setSize} = useCoverSize();
  const ref = useRef(null);
  useEffect(() => {
    const outside = e => { if(!ref.current?.contains(e.target)) ref.current?.removeAttribute('open'); };
    document.addEventListener('pointerdown',outside);
    return () => document.removeEventListener('pointerdown',outside);
  }, []);
  return <details ref={ref} className="cover-size-control" onKeyDown={e => { if(e.key === 'Escape') { ref.current.removeAttribute('open'); ref.current.querySelector('summary').focus(); e.stopPropagation(); } }}>
    <summary title={`Cover size: ${size}`} aria-label={`Cover size: ${size}`}><span aria-hidden="true">▯</span><span className="cover-size-label">Cover size</span></summary>
    <div className="cover-size-options" role="group" aria-label="Cover size">
      {Object.keys(COVER_WIDTHS).map((value,i) => <button key={value} type="button" aria-pressed={size === value} onClick={() => { setSize(value); ref.current.removeAttribute('open'); ref.current.querySelector('summary').focus(); }}><span className="cover-size-icon" aria-hidden="true" style={{width:12+i*5,height:18+i*7}} />{value[0].toUpperCase()+value.slice(1)}</button>)}
    </div>
  </details>;
}

// The three size buttons on their own, for a toolbar's "⋯" menu (2026-11-13).
export function CoverSizeChoices({ onPicked }) {
  const { size, setSize } = useCoverSize();
  return <div className="cover-size-choices" role="group" aria-label="Cover size">
    {Object.keys(COVER_WIDTHS).map((value, i) => <button key={value} type="button" aria-pressed={size === value} onClick={() => { setSize(value); onPicked?.(); }}>
      <span className="cover-size-icon" aria-hidden="true" style={{ width: 10 + i * 4, height: 15 + i * 6 }} />{value[0].toUpperCase() + value.slice(1)}</button>)}
  </div>;
}
