// ─── IssueWindow ──────────────────────────────────────────────────
// One issue in the shared editor: its cover, a library search to change or
// set the match, and (when it is not in the library) a way to get it.
// Clicking a result previews it in the large cover; nothing is saved until
// Confirm match. Matches save at once (they never change the order).
// claude/ADMIN_REORG.md step 3, "Issue window".
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAdmin } from '../../App';

export const coverUrl = id => `/api/books/${id}/thumbnail`;
const label = i => `${i.series_name || 'Issue'}${i.volume_year ? ` (${i.volume_year})` : ''}${i.issue_number != null ? ` #${i.issue_number}` : ''}`;
const DL = { wanted: 'Wanted', snatched: 'downloading', downloaded: 'downloaded', processing: 'being processed', processed: 'in the library', skipped: 'Skipped', failed: 'Failed' };

// "Get this issue": Download Manager status and the one-click actions (admin).
function GetIt({ acquire, issue }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const url = `/api/editor/acquire/${acquire.kind}/${acquire.owner}/${acquire.issue}`;
  useEffect(() => {
    let live = true;
    fetch(url).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => live && setPlan(d)).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [url]);
  const act = async action => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPlan({ ...d.plan, done: action === 'fill' ? 'Added. ' : 'Marked wanted. ' });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  let body;
  if (!plan) body = <span className="le-muted">{err || 'Checking the Download Manager…'}</span>;
  else if (plan.state === 'owned') body = <span className="le-muted">This issue is in the library; find it in the search to match it.</span>;
  else if (plan.state === 'monitored') {
    const st = plan.status;
    body = <>
      <span>{plan.done || ''}{plan.series_name || 'Its series'} is in the Download Manager; this issue is {DL[st] || st}.</span>
      {(st === 'skipped' || st === 'failed') && <button className="btn btn-primary" disabled={busy} onClick={() => act('wanted')}>Mark wanted</button>}
    </>;
  } else if (plan.state === 'fill') body = <>
    <span>{plan.folder} is in your library. Get this issue adds the series to the Download Manager with only this issue wanted.</span>
    <button className="btn btn-primary" disabled={busy} onClick={() => act('fill')}>{busy ? 'Adding…' : 'Get this issue'}</button>
  </>;
  else body = <>
    <span>No issues of this series are in your library. Add the series in the Download Manager.</span>
    <button className="btn btn-secondary" onClick={() => navigate(`/downloads?search=${encodeURIComponent(plan.search || issue.series_name || '')}`)}>Open Download Manager</button>
  </>;
  return <div className="le-iw-get"><div className="le-iw-get-title">Not in the library</div>{body}{err && plan && <div className="le-notice error">{err}</div>}</div>;
}

export default function IssueWindow({ issue, target, acquire, onClose, onDone }) {
  const current = issue.book_id || null;
  const [q, setQ] = useState(issue.series_name || '');
  const [num, setNum] = useState(issue.issue_number != null ? String(issue.issue_number) : '');
  const [year, setYear] = useState(issue.volume_year ? String(issue.volume_year) : '');
  const [yearMatch, setYearMatch] = useState(null);   // exact | near | none (from the server)
  const [results, setResults] = useState(null);
  const [preview, setPreview] = useState(null);   // { book } | { clear: true }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const search = async (yearOverride) => {
    if (!q.trim()) return;
    setErr(''); setResults(null);
    const y = String(yearOverride ?? year).trim();
    try {
      const r = await fetch(`/api/events/book-search?q=${encodeURIComponent(q.trim())}${num.trim() ? `&issue=${encodeURIComponent(num.trim())}` : ''}${y ? `&year=${encodeURIComponent(y)}` : ''}`);
      const d = await r.json().catch(() => []);
      setYearMatch(y ? r.headers.get('X-Year-Match') : null);
      setResults(Array.isArray(d) ? d : []);
    } catch (e) { setErr(e.message); setResults([]); }
  };
  useEffect(() => { search(); }, []); // first search on open
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); if (preview) setPreview(null); else onClose(); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [onClose, preview]);
  const confirm = async () => {
    const book = preview.clear ? null : preview.book;
    setBusy(true); setErr('');
    try {
      const r = await fetch(target.url, { method: target.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target.body(book ? book.id : null)) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
      onDone(book); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const shown = preview ? (preview.clear ? null : preview.book.id) : current;
  // Refresh cover (admin): the cached cover can be an older file's (a comic replaced on disk).
  const [coverV, setCoverV] = useState(0);
  const refreshCover = async () => {
    try { await fetch(`/api/books/${current}/thumbnail/cache`, { method: 'DELETE' }); } catch {}
    setCoverV(Date.now());
  };
  return (
    <div className="le-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="le-iw" role="dialog" aria-label={label(issue)}>
        <div className="le-dialog-head">
          <b>{label(issue)}</b>
          <button className="le-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="le-iw-body">
          <div className="le-iw-left">
            <div className={`le-iw-cover${shown ? '' : ' none'}${preview ? ' preview' : ''}`}>
              {shown ? <img key={`${shown}-${coverV}`} src={coverUrl(shown) + (coverV && shown === current ? `?v=${coverV}` : '')} alt="" /> : <span>No match</span>}
            </div>
            <div className="le-iw-caption">
              {preview ? (preview.clear ? 'The match will be cleared.' : <><b>New match</b> · not saved yet<br /><span className="le-muted">{preview.book.filename}</span></>)
                : current ? 'Current match' : 'Not matched to a comic in your library'}
            </div>
            {preview && <div className="le-iw-confirm">
              <button className="btn btn-primary" onClick={confirm} disabled={busy}>{busy ? 'Saving…' : preview.clear ? 'Clear match' : 'Confirm match'}</button>
              <button className="le-link" onClick={() => setPreview(null)} disabled={busy}>Keep current</button>
            </div>}
            {!preview && current && isAdmin() && <button className="le-link" onClick={refreshCover} title="Make the cover again from the comic's file (if it shows an old or wrong cover)">Refresh cover</button>}
            {!preview && current && <button className="le-link danger" onClick={() => setPreview({ clear: true })}>Clear the match…</button>}
            {!preview && !current && acquire && isAdmin() && <GetIt acquire={acquire} issue={issue} />}
          </div>
          <div className="le-iw-right">
            <form className="le-dialog-search" onSubmit={e => { e.preventDefault(); search(); }}>
              <input className="le-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Series name" autoFocus />
              <input className="le-input num" value={num} onChange={e => setNum(e.target.value)} placeholder="#" aria-label="Issue number" />
              <input className="le-input year" value={year} onChange={e => setYear(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} placeholder="Year" aria-label="Volume year"
                title="The volume's start year (the series folder's year). Leave empty to search every volume." />
              <button className="btn btn-secondary" type="submit">Search</button>
            </form>
            {yearMatch === 'near' && <div className="le-muted le-iw-yearnote">Nothing from {year}; showing volumes from the year either side.</div>}
            {err && <div className="le-notice error">{err}</div>}
            <div className="le-results">
              {results == null ? <div className="le-muted pad">Searching…</div>
                : !results.length ? <div className="le-muted pad">{yearMatch === 'none'
                  ? <>Nothing from {year} or the year either side. <button className="le-link" onClick={() => { setYear(''); search(''); }}>Search every year</button></>
                  : 'Nothing in the library matches. Try fewer words or clear the issue number.'}</div>
                : results.map(b => (
                  <button key={b.id} className={`le-result${preview && preview.book && preview.book.id === b.id ? ' on' : ''}${b.id === current ? ' cur' : ''}`} disabled={busy}
                    onClick={() => setPreview(b.id === current ? null : { book: b })}>
                    <img src={coverUrl(b.id)} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
                    <span className="le-result-text">
                      <span>{b.series_name}{b.series_year ? ` (${b.series_year})` : ''} #{b.issue_number}{b.id === current ? <em> · current</em> : null}</span>
                      <span className="le-muted">{b.filename}</span>
                    </span>
                  </button>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const issueWindowCss = `
  .le-iw { width: min(900px, 94vw); max-height: 86vh; display: flex; flex-direction: column; background: var(--bg-card, #1b1b1b); border: 1px solid var(--border-subtle); border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
  .le-iw-body { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 18px; padding: 6px 16px 16px; min-height: 0; flex: 1; }
  .le-iw-left { display: flex; flex-direction: column; gap: 10px; }
  .le-iw-cover { width: 250px; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: var(--bg-surface, #222); display: grid; place-items: center; box-shadow: 0 6px 18px rgba(0,0,0,0.35); }
  .le-iw-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .le-iw-cover.none { border: 1px dashed var(--border-subtle); box-shadow: none; color: var(--text-muted); font-size: 0.9rem; }
  .le-iw-cover.preview { outline: 2px solid var(--td-yellow, #f5c518); outline-offset: 3px; }
  .le-iw-caption { font-size: 0.82rem; color: var(--text-secondary, var(--text-muted)); word-break: break-word; }
  .le-iw-confirm { display: flex; align-items: center; gap: 14px; }
  .le-iw-get { border-top: 1px solid var(--border-subtle); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; font-size: 0.84rem; }
  .le-iw-get-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .le-iw-right { display: flex; flex-direction: column; min-height: 0; }
  .le-iw-right .le-dialog-search { padding: 0 0 10px; }
  .le-dialog-search .le-input.year { flex: 0 0 74px; }
  .le-iw-yearnote { margin: -4px 0 8px; font-size: 0.78rem; }
  .le-iw-right .le-results { flex: 1; min-height: 200px; max-height: calc(86vh - 120px); border: 1px solid var(--border-subtle); border-radius: 8px; }
  .le-result { flex-direction: row !important; align-items: center !important; gap: 12px !important; }
  .le-result img { width: 34px; height: 51px; object-fit: cover; border-radius: 2px; flex: none; background: var(--bg-surface, #222); }
  .le-result-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .le-result-text .le-muted { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .le-result.on { background: color-mix(in srgb, var(--td-yellow) 12%, transparent); box-shadow: inset 3px 0 0 var(--td-yellow, #f5c518); }
  .le-result em { font-style: normal; color: var(--text-muted); font-size: 0.78rem; }
  .le-thumb { width: 26px; height: 39px; padding: 0; border: 0; border-radius: 2px; overflow: hidden; background: var(--bg-surface, #222); cursor: pointer; display: grid; place-items: center; flex: none; }
  .le-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .le-thumb.none { border: 1px dashed var(--border-subtle); background: transparent; color: var(--text-muted); font-size: 0.7rem; }
  .le-thumb:hover:not(:disabled) { outline: 1px solid var(--td-yellow, #f5c518); outline-offset: 1px; }
  .le-thumb:disabled { cursor: default; }
`;
