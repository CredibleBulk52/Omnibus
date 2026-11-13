import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import { useSeriesCache, isAdmin } from '../App';

// ─── Specials shelf: series grouped under a home (2026-11-13) ─────
// backend/seriesGrouping.js. A series on another's shelf is listed on that series' Specials tab
// (beside the special issues in its own folder); a tie-in is also kept out of the series browser.
// Admins put a series on a shelf by hand, or take it off (a rule's link then stays off).

export const ROLE_LABEL = { 'tie-in': 'Tie-in', core: 'Main story', prelude: 'Lead-in', epilogue: 'Aftermath', initiative: 'Initiative', special: 'Special' };

export function useSeriesGrouping(id) {
  const [data, setData] = useState({ homes: [], members: [], keepVisible: false });
  const load = useCallback(() => fetch(`/api/series/${encodeURIComponent(id)}/grouping`).then(r => r.ok ? r.json() : null)
    .then(d => { if (d) setData(d); }).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// "On the Specials shelf of Flashpoint (2011)" under the tab rail, with ✕ for admins.
export function ShelfHomes({ seriesId, homes, onChanged }) {
  const navigate = useNavigate();
  const { invalidate } = useSeriesCache();
  if (!homes?.length) return null;
  const remove = async h => {
    try { await call('DELETE', `/api/series/${encodeURIComponent(seriesId)}/shelf/${encodeURIComponent(h.id)}`); invalidate(null); onChanged?.(); } catch {}
  };
  return (
    <div className="series-shelf-homes">
      On the Specials shelf of{' '}
      {homes.map((h, i) => <span key={h.id}>{i ? ', ' : ''}
        <button type="button" className="series-shelf-home-link" onClick={() => navigate(`/series/${encodeURIComponent(h.id)}?tab=specials`)}>{h.name}</button>
        {h.role && h.role !== 'special' && <span className="series-shelf-role"> · {ROLE_LABEL[h.role] || h.role}</span>}
        {isAdmin() && <button type="button" className="series-shelf-x" title="Take it off this shelf" aria-label={`Take it off ${h.name}'s shelf`} onClick={() => remove(h)}>✕</button>}
      </span>)}
    </div>
  );
}

// The linked series on a home's Specials tab.
export function LinkedSeriesShelf({ homeId, members, onChanged }) {
  const navigate = useNavigate();
  const { invalidate } = useSeriesCache();
  if (!members?.length) return null;
  const remove = async m => {
    try { await call('DELETE', `/api/series/${encodeURIComponent(m.id)}/shelf/${encodeURIComponent(homeId)}`); invalidate(null); onChanged?.(); } catch {}
  };
  return (
    <div className="linked-shelf">
      <div className="linked-shelf-head">Series on this shelf · {members.length}</div>
      <div className="linked-shelf-grid">
        {members.map(m => (
          <div key={m.id} className="linked-shelf-card">
            <button type="button" className="linked-shelf-open" onClick={() => navigate(`/series/${encodeURIComponent(m.id)}`)} title={m.reason || ''}>
              <img src={`/api/series/${encodeURIComponent(m.id)}/thumbnail`} alt="" loading="lazy" onError={e => { e.target.style.visibility = 'hidden'; }} />
              <span className="linked-shelf-name">{m.name}{m.year ? ` (${m.year})` : ''}</span>
              <span className="linked-shelf-meta">{ROLE_LABEL[m.role] || m.role} · {m.issues} issue{m.issues === 1 ? '' : 's'}{m.hidden ? '' : ' · also in the browser'}</span>
            </button>
            {isAdmin() && <button type="button" className="linked-shelf-remove" onClick={() => remove(m)} title="Take it off this shelf">Remove</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Admin: pick a series from the library (search by title).
export function SeriesPickerDialog({ title, intro, excludeId = null, onPick, onClose }) {
  const { fetchSeries } = useSeriesCache();
  const [all, setAll] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { fetchSeries(null).then(d => setAll(d || [])).catch(() => {}); }, [fetchSeries]);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return all.filter(s => s.id !== excludeId && String(s.displayTitle || s.name || '').toLowerCase().includes(t)).slice(0, 30);
  }, [all, q, excludeId]);
  const pick = async s => {
    setBusy(s.id); setError('');
    try { await onPick(s); onClose(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  return (
    <Modal title={title} onClose={onClose} width={520} closeOnBackdrop={false}>
      {intro && <p className="a-muted a-fs-13" style={{ marginTop: 0 }}>{intro}</p>}
      <input className="input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search your series…" style={{ width: '100%' }} />
      {error && <p className="a-fs-13" style={{ color: 'var(--td-red, #e55)' }}>{error}</p>}
      <div className="put-shelf-results">
        {hits.map(s => (
          <button key={s.id} type="button" className="put-shelf-hit" disabled={!!busy} onClick={() => pick(s)}>
            <span>{s.displayTitle || s.name}{s.displayYear && !String(s.displayTitle || '').includes(`(${s.displayYear})`) ? ` (${s.displayYear})` : ''}</span>
            <small>{s.book_count || 0} issues{busy === s.id ? ' · saving…' : ''}</small>
          </button>
        ))}
        {q.trim().length >= 2 && !hits.length && <p className="a-muted a-fs-13">No series match.</p>}
      </div>
      <SeriesShelfStyles />
    </Modal>
  );
}

// Admin: put this series on another series' Specials shelf.
export function PutOnShelfDialog({ seriesId, seriesName, onClose, onDone }) {
  const { invalidate } = useSeriesCache();
  return <SeriesPickerDialog title="Put on a Specials shelf" excludeId={seriesId} onClose={onClose}
    intro={<>Choose the series whose Specials tab {seriesName ? <b>{seriesName}</b> : 'this series'} belongs on. It then leaves the series browser (the "On a Specials shelf" filter still shows it). Nothing on disk changes.</>}
    onPick={async s => { await call('POST', `/api/series/${encodeURIComponent(seriesId)}/shelf`, { homeId: s.id }); invalidate(null); onDone?.(); }} />;
}

// Library page: the grouping rules' results, the event homes to confirm, and recent shelving.
export function SeriesGroupingPanel() {
  const { invalidate } = useSeriesCache();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [picking, setPicking] = useState(null);   // event whose home is being changed
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => fetch('/api/grouping').then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); setError(''); })
    .catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (key, fn) => { setBusy(key); try { await fn(); invalidate(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  if (!data) return <p className="a-muted">{error || 'Loading…'}</p>;
  const rule = data.counts?.rule || { links: 0, hidden: 0 }, manual = data.counts?.manual || { links: 0 };
  const toConfirm = data.events.filter(e => !e.confirmed && e.home);
  const events = showAll ? data.events : toConfirm;
  const byHome = new Map();
  for (const r of data.recent) { if (!byHome.has(r.home)) byHome.set(r.home, []); byHome.get(r.home).push(r); }
  return (
    <div className="grouping-panel">
      <p className="grouping-lead">
        <b>{rule.links}</b> series are on an event's Specials shelf by rule ({rule.hidden} kept out of the series browser as tie-ins){manual.links ? <>, and <b>{manual.links}</b> by hand</> : null}.
        {' '}<span className="a-muted">Rules follow your Timeline reading orders and run after scans and every hour.</span>
      </p>
      <div className="grouping-bar">
        <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => act('run', () => call('POST', '/api/grouping/run'))}>{busy === 'run' ? 'Running…' : '↻ Run the rules now'}</button>
        {error && <span className="a-fs-13" style={{ color: 'var(--td-red, #e55)' }}>{error}</span>}
      </div>

      <h4>Event homes {toConfirm.length ? <span className="a-muted">· {toConfirm.length} to check</span> : <span className="a-muted">· all checked</span>}</h4>
      <p className="a-muted a-fs-13">Each event's minis and one-shots go on its home series' Specials tab. Homes were picked from the event's name or, failing that, the series with the most essential issues in its reading order. An initiative (DC Rebirth, Infinite Frontier…) has no home unless you choose one, and its series stay in the browser.</p>
      <div className="grouping-bar">
        {toConfirm.length > 0 && <button className="adm-btn" disabled={!!busy} onClick={() => act('all', () => call('POST', '/api/grouping/events/confirm-all'))}>✓ These homes are fine</button>}
        <button className="adm-btn adm-btn-ghost" onClick={() => setShowAll(v => !v)}>{showAll ? 'Show only the ones to check' : `Show all ${data.events.length} events`}</button>
      </div>
      <div className="grouping-events">
        {events.map(e => (
          <div key={e.id} className="grouping-event">
            <span className="grouping-event-name">{e.name}{e.year ? ` (${e.year})` : ''}</span>
            <span className="grouping-event-home">→ {e.homeName || <i>no home</i>}{e.chosen ? '' : e.how === 'essential' ? ' · from its reading order' : e.how === 'name' ? ' · same name' : ''}{e.members ? ` · ${e.members} on its shelf` : ''}</span>
            <span className="grouping-event-actions">
              <label title="An initiative's series stay in the browser"><input type="checkbox" checked={e.initiative} disabled={!!busy}
                onChange={ev => act(e.id, () => call('POST', `/api/grouping/events/${encodeURIComponent(e.id)}`, { initiative: ev.target.checked }))} /> Initiative</label>
              <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => setPicking(e)}>Change…</button>
              {!e.confirmed && e.home && <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => act(e.id, () => call('POST', `/api/grouping/events/${encodeURIComponent(e.id)}`, { confirm: true }))}>✓</button>}
            </span>
          </div>
        ))}
      </div>

      <h4>Shelved in the last 7 days <span className="a-muted">· {data.recent.length}</span></h4>
      {[...byHome].map(([home, rows]) => (
        <details key={home} className="grouping-recent">
          <summary>{home} <span className="a-muted">· {rows.length}</span></summary>
          {rows.map(r => (
            <div key={r.seriesId + r.homeId} className="grouping-recent-row">
              <span>{r.series}</span>
              <span className="a-muted a-fs-12">{ROLE_LABEL[r.role] || r.role}{r.hidden ? ' · out of the browser' : ''}</span>
              <button className="adm-btn adm-btn-ghost" disabled={!!busy} title="Take it off this shelf; the rules won't put it back"
                onClick={() => act(r.seriesId, () => call('DELETE', `/api/series/${encodeURIComponent(r.seriesId)}/shelf/${encodeURIComponent(r.homeId)}`))}>Undo</button>
            </div>
          ))}
        </details>
      ))}
      {picking && <SeriesPickerDialog title={`Home for ${picking.name}`} onClose={() => setPicking(null)}
        intro="Its minis and one-shots will go on this series' Specials tab."
        onPick={async s => { await call('POST', `/api/grouping/events/${encodeURIComponent(picking.id)}`, { homeSeriesId: s.id }); invalidate(null); await load(); }} />}
      <style>{`
        .grouping-lead { margin: 0 0 10px; line-height: 1.5; }
        .grouping-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0 12px; }
        .grouping-panel h4 { margin: 18px 0 6px; }
        .grouping-events { display: flex; flex-direction: column; gap: 4px; }
        .grouping-event { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(160px, 1.4fr) auto; gap: 10px; align-items: center; padding: 6px 8px; border: 1px solid var(--border-subtle); border-radius: 6px; }
        .grouping-event-name { font-weight: 700; overflow-wrap: anywhere; }
        .grouping-event-home { color: var(--text-muted); font-size: 0.85rem; overflow-wrap: anywhere; }
        .grouping-event-actions { display: flex; gap: 6px; align-items: center; font-size: 0.8rem; flex-wrap: wrap; }
        @media (max-width: 640px) { .grouping-event { grid-template-columns: 1fr; } }
        .grouping-recent { border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; }
        .grouping-recent summary { cursor: pointer; }
        .grouping-recent-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 4px 0; border-top: 1px solid var(--border-subtle); }
      `}</style>
    </div>
  );
}

export function SeriesShelfStyles() {
  return <style>{`
    .series-shelf-homes { font-size: 0.85rem; color: var(--text-muted); padding: 8px 0 0; }
    .series-shelf-home-link { background: none; border: 0; padding: 0; color: var(--td-yellow, var(--color-primary)); cursor: pointer; font: inherit; }
    .series-shelf-home-link:hover { text-decoration: underline; }
    .series-shelf-x { background: none; border: 0; color: var(--text-muted); cursor: pointer; margin-left: 4px; font-size: 0.8rem; }
    .linked-shelf { margin: 8px 0 20px; }
    .linked-shelf-head { font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }
    .linked-shelf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 14px; }
    .linked-shelf-card { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .linked-shelf-open { display: flex; flex-direction: column; gap: 4px; background: none; border: 0; padding: 0; text-align: left; color: var(--text-primary); cursor: pointer; font: inherit; min-width: 0; }
    .linked-shelf-open img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; background: var(--bg-card); }
    .linked-shelf-name { font-weight: 700; font-size: 0.85rem; overflow-wrap: anywhere; }
    .linked-shelf-meta { font-size: 0.75rem; color: var(--text-muted); }
    .linked-shelf-remove { align-self: flex-start; background: none; border: 1px solid var(--border-subtle); border-radius: 4px; color: var(--text-muted); font-size: 0.72rem; padding: 2px 8px; cursor: pointer; }
    .put-shelf-results { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; max-height: 50vh; overflow: auto; }
    .put-shelf-hit { display: flex; justify-content: space-between; gap: 10px; text-align: left; padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-card); color: var(--text-primary); cursor: pointer; font: inherit; }
    .put-shelf-hit:hover:not(:disabled) { border-color: var(--td-yellow, var(--color-primary)); }
    .put-shelf-hit small { color: var(--text-muted); white-space: nowrap; }
  `}</style>;
}
