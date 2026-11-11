import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Top-bar search with suggestions as you type (2026-10-22): the best hits across series, issues
// ("Batman 497" jumps to the issue), Timeline events, Top Shelf runs and reading lists.
// ↑/↓ choose, Enter opens the chosen hit (or the full search page), Escape closes.
const TYPE = { issue: 'Issue', book: 'Issue', series: 'Series', event: 'Event', run: 'Top Shelf', list: 'List' };

export default function TopbarSearch({ query, setQuery, inputRef, libraryId, onClose, onDone, icon }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const box = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setItems([]); return undefined; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      fetch(`/api/search/suggest?q=${encodeURIComponent(q)}${libraryId ? `&libraryId=${encodeURIComponent(libraryId)}` : ''}`)
        .then(r => (r.ok ? r.json() : { results: [] }))
        .then(d => { if (n === seq.current) { setItems(d.results || []); setHi(-1); } })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [query, libraryId]);

  useEffect(() => {
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const go = url => { setOpen(false); setItems([]); setQuery(''); navigate(url); onDone && onDone(); inputRef.current?.blur(); };
  const submit = e => {
    e.preventDefault();
    if (open && hi >= 0 && items[hi]) return go(items[hi].url);
    if (query.trim()) { setOpen(false); navigate(`/search?q=${encodeURIComponent(query.trim())}`); onDone && onDone(); inputRef.current?.blur(); }
  };
  const key = e => {
    if (e.key === 'Escape') { if (open && items.length) { setOpen(false); return; } onClose && onClose(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(items.length - 1, h + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(-1, h - 1)); }
  };
  const show = open && items.length > 0 && query.trim().length >= 2;

  return (
    <form role="search" className="topbar-search tbs" ref={box} onSubmit={submit}>
      {icon}
      <input ref={inputRef} aria-label="Search library" placeholder="Search comics, series, events…" value={query}
        role="combobox" aria-expanded={show} aria-controls="tbs-list" aria-autocomplete="list"
        aria-activedescendant={show && hi >= 0 ? `tbs-${hi}` : undefined}
        onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={key} />
      <button type="submit" className="search-hint">Search</button>
      <button type="button" className="search-close" aria-label="Close search" onClick={onClose}>✕</button>
      {show && <ul id="tbs-list" className="tbs-list" role="listbox">
        {items.map((it, i) => (
          <li key={`${it.type}-${it.id}`} id={`tbs-${i}`} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''}
            onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); go(it.url); }}>
            <span className="tbs-thumb">{it.thumb ? <img src={it.thumb} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : null}</span>
            <span className="tbs-text"><b>{it.label}</b>{it.sub ? <small>{it.sub}</small> : null}</span>
            <span className={`tbs-type t-${it.type}`}>{TYPE[it.type] || it.type}</span>
          </li>))}
        <li className="tbs-all" role="option" aria-selected={false} onMouseDown={e => { e.preventDefault(); setOpen(false); navigate(`/search?q=${encodeURIComponent(query.trim())}`); onDone && onDone(); }}>
          All results for “{query.trim()}” ↵</li>
      </ul>}
      <style>{`
        .tbs { position: relative; }
        .tbs-list { position: absolute; top: calc(100% + 6px); left: 0; z-index: 1200; width: max(100%, 380px); max-width: calc(100vw - 24px); margin: 0; padding: 4px 0; list-style: none;
          background: var(--bg-card, #111118); border: 1px solid var(--border-active, #444); border-radius: 8px; box-shadow: 0 10px 28px rgba(0,0,0,.55); max-height: 70vh; overflow-y: auto; }
        .tbs-list li { display: flex; align-items: center; gap: 10px; padding: 6px 10px; cursor: pointer; }
        .tbs-list li.on { background: rgba(255,255,255,.07); }
        .tbs-thumb { width: 28px; height: 40px; flex-shrink: 0; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,.05); }
        .tbs-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .tbs-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .tbs-text b { font-weight: 600; font-size: .86rem; color: var(--text-primary, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tbs-text small { font-size: .74rem; color: var(--text-muted, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tbs-type { flex-shrink: 0; font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted, #999); border: 1px solid rgba(255,255,255,.15); border-radius: 8px; padding: 1px 6px; }
        .tbs-type.t-issue { color: #f5c518; border-color: color-mix(in srgb, var(--td-yellow) 40%, transparent); }
        .tbs-list .tbs-all { justify-content: flex-end; font-size: .78rem; color: var(--text-muted, #999); border-top: 1px solid rgba(255,255,255,.08); margin-top: 2px; }
      `}</style>
    </form>
  );
}
