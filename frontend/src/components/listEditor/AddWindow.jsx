// ─── AddWindow ────────────────────────────────────────────────────
// Add issues to the list being edited (claude/ADMIN_REORG.md step 3, part 2;
// user 2026-10-17). One search box ("Wonder Woman 2016 1-10"); volumes in
// the library first, then Comic Vine; for reading lists also Timeline events
// and Top Shelf runs. Pick a volume, tick issues (covers shown), choose the
// position (and tier, or one entry vs separate issues), Add. Adds go into the
// draft like every other change; the window stays open for more.
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { coverUrl } from './IssueWindow';

let seq = 0;
const nk = () => 'a' + Date.now().toString(36) + (++seq);
const numF = n => { const f = parseFloat(n); return Number.isFinite(f) ? f : null; };
const sameNum = (a, b) => String(a) === String(b) || (numF(a) != null && numF(a) === numF(b));
const label = (name, year, num) => `${name || 'Unknown'}${year ? ` (${year})` : ''}${num != null ? ` #${num}` : ''}`;
// Annuals and specials filed in a volume carry the name and year they were published under
// (user 2026-10-26); everything else uses the volume's.
const nameOf = (v, i) => (i.group ? i.series_name : v.name);
const yearOf = (v, i) => (i.group ? i.volume_year : v.year);
// Issues the Issues box ticks: the focused annual/special group, else the regular issues.
const inFocus = (focus, i) => (focus ? !!i.group && i.series_name === focus.name && (focus.year == null || i.volume_year === focus.year) : !i.extra && !i.group);

// "Wonder Woman (2016) 1-10", "Wonder Woman 2016 #3", "100 Bullets 1, 3, 5-7" → { title, year, nums }
export function parseQuery(s) {
  let t = ` ${String(s || '')} `, year = '', nums = '';
  const py = t.match(/\((1[89]\d\d|20\d\d)\)/);
  if (py) { year = py[1]; t = t.replace(py[0], ' '); }
  const spec = t.match(/\s(#?\s*\d+(?:\.\d+)?(?:\s*[-–]\s*#?\d+(?:\.\d+)?)?(?:\s*,\s*#?\d+(?:\.\d+)?(?:\s*[-–]\s*#?\d+(?:\.\d+)?)?)*)\s*$/);
  if (spec) {
    const raw = spec[1].trim(), single = /^\d+$/.test(raw);
    const looksYear = single && /^(1[89]\d\d|20\d\d)$/.test(raw) && !year;
    if (!looksYear) { const rest = t.slice(0, spec.index); if (rest.trim()) { nums = raw.replace(/#/g, '').replace(/\s+/g, ''); t = rest; } }
  }
  const ty = !year && t.match(/\s(1[89]\d\d|20\d\d)\s*$/);
  if (ty && t.slice(0, ty.index).trim()) { year = ty[1]; t = t.slice(0, ty.index); }
  return { title: t.replace(/\s+/g, ' ').trim(), year, nums };
}
// "1-10, 12" → a test for an issue number
export function numsTest(spec) {
  const parts = String(spec || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return n => parts.some(p => {
    const m = p.match(/^#?(\S+?)\s*[-–]\s*#?(\S+)$/);
    if (m) { const a = numF(m[1]), z = numF(m[2]), v = numF(n); return a != null && z != null && v != null && v >= Math.min(a, z) && v <= Math.max(a, z); }
    return sameNum(p.replace(/^#/, ''), n);
  });
}

// Editor rows for what was picked. sel: { volume, issues } | { event } | { run }.
export function makeAddRows(kind, sel, opts) {
  if (sel.event) return [{ key: nk(), id: null, isNew: true, type: 'event', linked: true, label: label(sel.event.name, sel.event.year), note: '',
    tier: opts.listTier || 'essential', owned: 0, total: sel.event.issues || 0, children: null, add: { type: 'event', refId: sel.event.id } }];
  if (sel.run) return [{ key: nk(), id: null, isNew: true, type: 'canon_run', linked: true, label: sel.run.name, note: '', owned: 0, total: sel.run.issues || 0,
    children: null, add: { type: 'canon_run', refId: sel.run.id } }];
  const v = sel.volume, picked = sel.issues;
  const single = i => ({ id: null, owned: !!i.book_id, book_id: i.book_id || null, series_name: nameOf(v, i), issue_number: i.number, volume_year: yearOf(v, i), title: i.title || null });
  const issueAdd = i => ({ series_name: nameOf(v, i), issue_number: String(i.number), volume_year: yearOf(v, i), issue_title: i.title || null, cv_issue_id: i.cv_issue_id || null, scanned_book_id: i.book_id || null });
  const listIssueAdd = i => (i.book_id ? { type: 'issue', bookId: i.book_id }
    : { type: 'issue', seriesName: nameOf(v, i), issueNumber: String(i.number), volumeYear: yearOf(v, i), cvIssueId: i.cv_issue_id || undefined, issueTitle: i.title || undefined });
  const issueRow = i => ({ key: nk(), id: null, isNew: true, type: 'issue', label: label(nameOf(v, i), yearOf(v, i), i.number), note: '', tier: kind === 'event' ? opts.tier : null,
    owned: i.book_id ? 1 : 0, total: 1, single: single(i), children: null, add: kind === 'list' ? listIssueAdd(i) : issueAdd(i) });
  if (kind !== 'list' || opts.mode !== 'entry' || picked.length < 2) return picked.map(issueRow);
  // One entry: a range when the picks are consecutive in the volume, else a set of picked issues.
  const idx = picked.map(i => sel.all.indexOf(i)).sort((a, b) => a - b);
  // A range is by number in the volume, so never for annuals or specials.
  const consecutive = !picked.some(i => i.group) && idx.every((x, k) => k === 0 || x === idx[k - 1] + 1);
  const first = picked[0], last = picked[picked.length - 1];
  const children = picked.map(i => ({ key: nk(), liId: null, label: label(nameOf(v, i), yearOf(v, i), i.number), owned: !!i.book_id, bookId: i.book_id || null, issue: single(i) }));
  const base = { key: nk(), id: null, isNew: true, note: '', owned: children.filter(c => c.owned).length, total: children.length, children, childrenOrig: null, childrenEditable: false };
  // The picked issues go with a range too, so it shows them straight after saving.
  const pickedAdd = picked.map(i => (i.book_id ? { bookId: i.book_id } : { seriesName: nameOf(v, i), issueNumber: String(i.number), volumeYear: yearOf(v, i), cvIssueId: i.cv_issue_id || undefined }));
  if (consecutive) {
    const add = v.source === 'library' ? { type: 'range', seriesId: v.id, cvVolumeId: v.cv_volume_id || undefined, issueStart: String(first.number), issueEnd: String(last.number), issues: pickedAdd }
      : { type: 'range', cvVolumeId: v.id, issueStart: String(first.number), issueEnd: String(last.number), issues: pickedAdd };
    return [{ ...base, type: 'range', label: `${label(v.name, v.year)} #${first.number}–${last.number}`, add }];
  }
  const nums = picked.map(i => i.number).join(', ');
  const one = picked.every(i => nameOf(v, i) === nameOf(v, first) && yearOf(v, i) === yearOf(v, first));
  return [{ ...base, type: 'story', label: (one ? `${label(nameOf(v, first), yearOf(v, first))} #${nums}` : children.map(c => c.label).join(', ')).slice(0, 300),
    add: { type: 'story', issues: pickedAdd } }];
}

const getJson = async url => { const r = await fetch(url); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; };
const LIST_TIERS = [['essential', 'Essential only'], ['recommended', 'Essential + recommended'], ['all', 'Every tie-in']];

export default function AddWindow({ kind, tiers, count, defaultPos, defaultTier, existing, onAdd, onClose }) {
  const [box, setBox] = useState('');
  const [year, setYear] = useState('');
  const [nums, setNums] = useState('');
  const [res, setRes] = useState(null);          // search results
  const [cvOn, setCvOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(null);          // { volume } | { event } | { run }
  const [vol, setVol] = useState(null);          // { volume, issues, cvError }
  const [ticked, setTicked] = useState(() => new Set());
  const [pos, setPos] = useState(defaultPos);
  const [tier, setTier] = useState(defaultTier || (tiers ? tiers[1]?.[0] || tiers[0][0] : null));
  const [listTier, setListTier] = useState('essential');
  const [mode, setMode] = useState('entry');
  const [done, setDone] = useState('');
  const lastTick = useRef(null);
  const boxRef = useRef(null);
  useEffect(() => { boxRef.current && boxRef.current.focus(); }, []);
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const typed = v => { setBox(v); const p = parseQuery(v); setYear(p.year); setNums(p.nums); };
  const title = parseQuery(box).title;
  const search = async (withCv = cvOn) => {
    if (!title) return;
    setBusy(true); setErr(''); setDone('');
    try {
      const qs = new URLSearchParams({ q: title, ...(year ? { year } : {}), ...(kind === 'list' ? { lists: '1' } : {}), ...(withCv ? { cv: '1' } : {}) });
      const d = await getJson(`/api/editor/add/search?${qs}`);
      // Nothing in the library: ask Comic Vine straight away.
      if (!withCv && !d.volumes.length && !(d.events || []).length && !(d.runs || []).length) { setCvOn(true); setBusy(false); return search(true); }
      setRes(d);
      const only = d.volumes.length === 1 && !(d.cv || []).length && !(d.events || []).length && !(d.runs || []).length;
      if (only) pick({ volume: d.volumes[0] });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const pick = async s => {
    setSel(s); setVol(null); setTicked(new Set()); setDone('');
    if (!s.volume) return;
    try {
      const v = s.volume;
      const url = v.source === 'library' ? `/api/editor/add/volume?library=${encodeURIComponent(v.id)}`
        : `/api/editor/add/volume?${new URLSearchParams({ cv: v.id, name: v.name || '', year: v.year || '', publisher: v.publisher || '' })}`;
      const d = await getJson(url);
      setVol(d);
      const t = numsTest(nums);
      if (t) setTicked(new Set(d.issues.filter(i => inFocus(v.focus, i) && t(i.number)).map(i => d.issues.indexOf(i))));
    } catch (e) { setErr(e.message); }
  };
  // Re-tick when the issue numbers change while a volume is open.
  useEffect(() => { if (!vol) return; const t = numsTest(nums), f = sel && sel.volume && sel.volume.focus; if (t) setTicked(new Set(vol.issues.filter(i => inFocus(f, i) && t(i.number)).map(i => vol.issues.indexOf(i)))); }, [nums]); // re-tick from the Issues box

  const tick = (e, k) => {
    const prev = lastTick.current, shift = e.shiftKey;
    setTicked(s => {
      const n = new Set(s);
      if (shift && prev != null) { for (let x = Math.min(prev, k); x <= Math.max(prev, k); x++) n.add(x); }
      else if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
    lastTick.current = k;
  };
  const issues = vol ? vol.issues : [];
  const picked = [...ticked].sort((a, b) => a - b).map(k => issues[k]).filter(Boolean);
  const isHere = i => (i.cv_issue_id && existing.cv.has(String(i.cv_issue_id))) || (i.book_id && existing.books.has(String(i.book_id)));
  const nAdd = sel && (sel.event || sel.run) ? 1 : picked.length;
  const doAdd = () => {
    if (!nAdd) return;
    const s = sel.volume ? { volume: vol.volume, issues: picked, all: issues } : sel;
    const rows = makeAddRows(kind, s, { tier, mode, listTier });
    onAdd(rows, Math.max(1, Math.min(Number(pos) || count + 1, count + 1)));
    setDone(`Added ${sel.volume ? `${picked.length} issue${picked.length === 1 ? '' : 's'}` : `“${(sel.event || sel.run).name}”`} at position ${pos}.`);
    setPos(p => (Number(p) || count + 1) + rows.length);
    setTicked(new Set());
  };
  const owned = issues.filter(i => i.book_id).length;
  const group = (name, list, render) => (list && list.length ? <div className="le-aw-group"><div className="le-aw-group-name">{name}</div>{list.map(render)}</div> : null);
  const volBtn = v => (
    <button key={v.source + v.id} className={`le-aw-res${sel && sel.volume && sel.volume.id === v.id && sel.volume.source === v.source ? ' on' : ''}`} onClick={() => pick({ volume: v })}>
      {v.image ? <img src={v.image} alt="" loading="lazy" /> : null}
      <span><b>{v.name}</b>{v.year ? ` (${v.year})` : ''}
        {v.focus && <small className="le-aw-focus">has {v.focus.name}{v.focus.year ? ` (${v.focus.year})` : ''}</small>}
        <small>{[v.publisher, v.source === 'library' ? `${v.owned} in library` : null, v.total ? `${v.total} issues` : null, v.in_library ? 'in library' : null].filter(Boolean).join(' · ')}</small></span>
    </button>);

  return (
    <div className="le-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="le-aw" role="dialog" aria-label="Add">
        <div className="le-dialog-head"><b>Add</b><span className="le-muted">Series and issues, e.g. “Wonder Woman 2016 1-10”{kind === 'list' ? ', or a Timeline event or Top Shelf run' : ''}</span>
          <button className="le-x" onClick={onClose} aria-label="Close">×</button></div>
        <form className="le-aw-search" onSubmit={e => { e.preventDefault(); search(); }}>
          <input ref={boxRef} className="le-input" value={box} onChange={e => typed(e.target.value)} placeholder="Search" aria-label="Search" />
          <input className="le-input year" value={year} onChange={e => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Year" aria-label="Year" />
          <input className="le-input nums" value={nums} onChange={e => setNums(e.target.value)} placeholder="Issues, e.g. 1-10" aria-label="Issues" />
          <button className="btn btn-secondary" type="submit" disabled={busy || !title}>{busy ? 'Searching…' : 'Search'}</button>
        </form>
        {err && <div className="le-notice error">{err}</div>}
        <div className="le-aw-body">
          <div className="le-aw-left">
            {!res && <div className="le-muted pad">Search to see volumes{kind === 'list' ? ', Timeline events and Top Shelf runs' : ''}.</div>}
            {res && <>
              {res.yearMatch === 'near' && <div className="le-muted le-aw-note">Nothing from {year}; showing the year either side.</div>}
              {group('In your library', res.volumes, volBtn)}
              {group('Timeline events', res.events, e => (
                <button key={'e' + e.id} className={`le-aw-res${sel && sel.event && sel.event.id === e.id ? ' on' : ''}`} onClick={() => pick({ event: e })}>
                  <span><b>{e.name}</b>{e.year ? ` (${e.year})` : ''}<small>Timeline event · {e.issues} issues</small></span></button>))}
              {group('Top Shelf runs', res.runs, r => (
                <button key={'r' + r.id} className={`le-aw-res${sel && sel.run && sel.run.id === r.id ? ' on' : ''}`} onClick={() => pick({ run: r })}>
                  <span><b>{r.name}</b><small>{['Top Shelf run', r.sub, `${r.issues} issues`, r.status !== 'approved' ? r.status : null].filter(Boolean).join(' · ')}</small></span></button>))}
              {cvOn ? group('Comic Vine', res.cv, volBtn) : null}
              {res.cvError && <div className="le-notice error">{res.cvError}</div>}
              {cvOn && res.cv && !res.cv.length && <div className="le-muted pad">Comic Vine has nothing for that{year ? ` in ${year}` : ''}.</div>}
              {!cvOn && <button className="le-link le-aw-cv" onClick={() => { setCvOn(true); search(true); }}>Search Comic Vine too</button>}
              {!res.volumes.length && !(res.events || []).length && !(res.runs || []).length && cvOn && !(res.cv || []).length && !res.cvError
                ? <div className="le-muted pad">Nothing found. Try fewer words or another year.</div> : null}
            </>}
          </div>
          <div className="le-aw-right">
            {!sel && <div className="le-muted pad">Pick a volume to see its issues.</div>}
            {sel && (sel.event || sel.run) && <div className="le-aw-entry">
              <b>{(sel.event || sel.run).name}</b>
              <p className="le-muted">{sel.event ? 'Added as one entry that follows the Timeline event: changes to the event show up in your list.' : 'Added as one entry that follows the Top Shelf run.'}</p>
              {sel.event && <label className="le-aw-inline">Tie-ins <select className="le-input" value={listTier} onChange={e => setListTier(e.target.value)}>{LIST_TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
            </div>}
            {sel && sel.volume && <>
              <div className="le-aw-volhead">
                <b>{(vol && vol.volume.name) || sel.volume.name}</b>{(vol && vol.volume.year) || sel.volume.year ? ` (${(vol && vol.volume.year) || sel.volume.year})` : ''}
                <span className="le-muted">{vol ? ` · ${issues.length} issues · ${owned} in your library` : ' · loading…'}</span>
                {vol && <span className="le-aw-quick">
                  <button className="le-link" onClick={() => setTicked(new Set(issues.map((_, k) => k)))}>All</button>
                  <button className="le-link" onClick={() => setTicked(new Set(issues.map((i, k) => (i.book_id ? k : -1)).filter(k => k >= 0)))}>Owned</button>
                  <button className="le-link" onClick={() => setTicked(new Set())}>None</button>
                </span>}
              </div>
              {vol && vol.cvError && <div className="le-notice warn">Comic Vine did not answer ({vol.cvError}); showing only the issues in your library.</div>}
              {vol && (() => {
                const one = (i, k) => {
                  const on = ticked.has(k), here = isHere(i);
                  return (
                    <button key={k} className={`le-aw-issue${on ? ' on' : ''}${i.book_id ? '' : ' missing'}`} onClick={e => tick(e, k)}
                      title={`${label(nameOf(vol.volume, i), yearOf(vol.volume, i), i.number)}${i.title ? ` — ${i.title}` : ''}${i.book_id ? '' : ' · not in your library'}${here ? ' · already in this list' : ''}`}>
                      <span className="le-aw-cover">
                        {i.book_id ? <img src={coverUrl(i.book_id)} alt="" loading="lazy" /> : i.image ? <img src={i.image} alt="" loading="lazy" /> : <span>?</span>}
                        {on && <i className="le-aw-check">✓</i>}
                        {here && <i className="le-aw-here">in list</i>}
                      </span>
                      <span className="le-aw-num">#{i.number}{i.extra ? '*' : ''}</span>
                    </button>);
                };
                // Regular issues, then each annual/special group under its published name;
                // the group the search named comes first.
                const regular = [], groups = new Map(), f = sel.volume.focus;
                issues.forEach((i, k) => { if (!i.group) regular.push(k); else { if (!groups.has(i.group)) groups.set(i.group, { focus: inFocus(f, i), ks: [] }); groups.get(i.group).ks.push(k); } });
                const gl = [...groups.entries()].sort((a, b) => (b[1].focus ? 1 : 0) - (a[1].focus ? 1 : 0));
                const block = ([name, g]) => (<div key={name} className="le-aw-sub"><div className="le-aw-subhead">{name}</div><div className="le-aw-grid">{g.ks.map(k => one(issues[k], k))}</div></div>);
                return <>
                  {gl.filter(([, g]) => g.focus).map(block)}
                  {regular.length > 0 && <div className="le-aw-grid">{regular.map(k => one(issues[k], k))}</div>}
                  {gl.filter(([, g]) => !g.focus).map(block)}
                </>;
              })()}
              {vol && issues.some(i => i.extra) && <div className="le-muted le-aw-note">* In your library but not in Comic Vine's list for this volume.</div>}
            </>}
          </div>
        </div>
        <div className="le-aw-foot">
          <label className="le-aw-inline">Position <input className="le-input pos" type="number" min={1} max={count + 1} value={pos} onChange={e => setPos(e.target.value)} />
            <span className="le-muted">of {count + 1}</span></label>
          {kind === 'event' && tiers && sel && sel.volume && <label className="le-aw-inline">Tier <select className="le-input" value={tier} onChange={e => setTier(e.target.value)}>{tiers.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
          {kind === 'list' && sel && sel.volume && picked.length > 1 && <span className="le-aw-mode">
            <label><input type="radio" checked={mode === 'entry'} onChange={() => setMode('entry')} /> As one entry</label>
            <label><input type="radio" checked={mode === 'separate'} onChange={() => setMode('separate')} /> As separate issues</label>
          </span>}
          <span className="le-spacer" />
          {done && <span className="le-aw-done">{done}</span>}
          <button className="btn btn-primary" disabled={!nAdd || (sel && sel.volume && !vol)} onClick={doAdd}>
            {sel && (sel.event || sel.run) ? 'Add entry' : `Add ${picked.length || ''} issue${picked.length === 1 ? '' : 's'}`.replace('  ', ' ')}
          </button>
        </div>
      </div>
    </div>
  );
}

export const addWindowCss = `
  .le-aw { width: min(1100px, 95vw); height: min(780px, 90vh); display: flex; flex-direction: column; background: var(--bg-card, #1b1b1b); border: 1px solid var(--border-subtle); border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
  .le-aw .le-dialog-head .le-muted { font-size: 0.78rem; }
  .le-aw-search { display: flex; gap: 8px; padding: 4px 16px 10px; }
  .le-aw-search .le-input.year { flex: 0 0 74px; } .le-aw-search .le-input.nums { flex: 0 0 150px; }
  .le-aw > .le-notice { margin: 0 16px 8px; }
  .le-aw-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 320px minmax(0, 1fr); border-top: 1px solid var(--border-subtle); }
  .le-aw-left { overflow-y: auto; border-right: 1px solid var(--border-subtle); padding: 6px 0; }
  .le-aw-right { overflow-y: auto; padding: 10px 14px; }
  .le-aw-group { margin-bottom: 8px; }
  .le-aw-group-name { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); padding: 6px 14px 4px; }
  .le-aw-res { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; background: none; border: 0; color: var(--text-primary); font: inherit; font-size: 0.86rem; padding: 6px 14px; cursor: pointer; }
  .le-aw-res:hover { background: var(--bg-hover); }
  .le-aw-res.on { background: color-mix(in srgb, var(--td-yellow) 12%, transparent); box-shadow: inset 3px 0 0 var(--td-yellow, #f5c518); }
  .le-aw-res img { width: 26px; height: 39px; object-fit: cover; border-radius: 2px; flex: none; }
  .le-aw-res small { display: block; color: var(--text-muted); font-size: 0.74rem; margin-top: 1px; }
  .le-aw-cv { margin: 6px 14px; }
  .le-aw-note { font-size: 0.76rem; padding: 4px 14px; }
  .le-aw-volhead { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; font-size: 0.9rem; }
  .le-aw-quick { margin-left: auto; display: inline-flex; gap: 12px; }
  .le-aw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); gap: 10px 8px; }
  .le-aw-issue { background: none; border: 0; padding: 0; cursor: pointer; color: var(--text-secondary, var(--text-muted)); font: inherit; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .le-aw-cover { position: relative; width: 66px; height: 99px; border-radius: 3px; overflow: hidden; background: var(--bg-surface, #222); display: grid; place-items: center; outline: 2px solid transparent; outline-offset: 1px; }
  .le-aw-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .le-aw-issue.missing .le-aw-cover { border: 1px dashed var(--border-subtle); }
  .le-aw-issue.missing .le-aw-cover img { opacity: 0.45; filter: grayscale(0.6); }
  .le-aw-issue.on .le-aw-cover { outline-color: var(--td-yellow, #f5c518); }
  .le-aw-check { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--td-yellow, #f5c518); color: #111; font-style: normal; font-size: 0.7rem; display: grid; place-items: center; }
  .le-aw-here { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); color: #fff; font-style: normal; font-size: 0.62rem; text-align: center; padding: 1px 0; }
  .le-aw-num { font-size: 0.74rem; }
  .le-aw-sub { margin: 14px 0 6px; }
  .le-aw-sub:first-child { margin-top: 0; }
  .le-aw-subhead { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border-subtle); }
  .le-aw-res small.le-aw-focus { color: var(--td-yellow, #f5c518); }
  .le-aw-entry { padding: 6px 2px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .le-aw-foot { display: flex; align-items: center; gap: 18px; padding: 10px 16px; border-top: 1px solid var(--border-subtle); flex-wrap: wrap; }
  .le-aw-inline { display: inline-flex; align-items: center; gap: 8px; font-size: 0.85rem; }
  .le-aw-inline .le-input { flex: none; }
  .le-input.pos { width: 64px; }
  .le-aw-mode { display: inline-flex; gap: 14px; font-size: 0.85rem; }
  .le-aw-mode label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .le-aw-done { color: #7fc48f; font-size: 0.82rem; }
`;
