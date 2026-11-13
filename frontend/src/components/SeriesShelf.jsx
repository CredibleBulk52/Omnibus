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

// Library page › Specials shelves (2026-11-13): every event as one row of covers. The home's cover
// is large; the series on its shelf follow as small covers (✕ takes one off). Events not yet
// checked come first; "Looks right" or "Change home" settles each.
const STRIP = 14;
export function SeriesGroupingPanel() {
  const { invalidate } = useSeriesCache();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [picking, setPicking] = useState(null);
  const [view, setView] = useState('check');
  const [open, setOpen] = useState({});
  const load = useCallback(() => fetch('/api/grouping').then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); setError(''); })
    .catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (key, fn) => { setBusy(key); setError(''); try { await fn(); invalidate(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  if (!data) return <p className="a-muted">{error || 'Loading…'}</p>;
  const rule = data.counts?.rule || { links: 0, hidden: 0 }, manual = data.counts?.manual || { links: 0 };
  const toCheck = data.events.filter(e => !e.confirmed && (e.home || e.members.length));
  const withShelf = data.events.filter(e => e.members.length);
  const list = view === 'check' ? toCheck : view === 'shelves' ? withShelf : data.events;
  const setEvent = (e, body) => act(e.id, () => call('POST', `/api/grouping/events/${encodeURIComponent(e.id)}`, body));
  return (
    <div className="gp">
      <div className="gp-head">
        <span><b>{(rule.links + (manual.links || 0)).toLocaleString()}</b> series on shelves <span className="gp-muted">· {rule.hidden} out of the browser{manual.links ? ` · ${manual.links} by hand` : ''}</span></span>
        <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => act('run', () => call('POST', '/api/grouping/run'))}
          title="The rules follow your Timeline reading orders; they also run after scans, new series.json files and every hour">{busy === 'run' ? 'Running…' : '↻ Run the rules'}</button>
      </div>
      <div className="gp-tabs" role="tablist">
        {[['check', 'To check', toCheck.length], ['shelves', 'Events with a shelf', withShelf.length], ['all', 'All events', data.events.length]].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>{label} <b>{n}</b></button>))}
        {view === 'check' && toCheck.length > 0 && <button className="adm-btn gp-all" disabled={!!busy} onClick={() => act('all', () => call('POST', '/api/grouping/events/confirm-all'))}>✓ All look right</button>}
      </div>
      {error && <p className="gp-error">{error}</p>}
      {view === 'check' && !toCheck.length && <p className="gp-muted">Every event's home has been checked.</p>}
      <div className="gp-rows">
        {list.map(e => {
          const shown = open[e.id] ? e.members : e.members.slice(0, STRIP);
          return (
            <div key={e.id} className={`gp-row${e.confirmed ? ' gp-done' : ''}`}>
              <div className="gp-home" title={e.homeName || 'No home'}>
                {e.home ? <img src={`/api/series/${encodeURIComponent(e.home)}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} /> : <span className="gp-nohome">No home</span>}
              </div>
              <div className="gp-body">
                <div className="gp-title">
                  <span className="gp-event">{e.name}{e.year ? ` · ${e.year}` : ''}{e.initiative ? <em> · initiative</em> : null}</span>
                  <b>{e.homeName || (e.initiative ? 'Series stay in the browser' : 'No home series')}</b>
                  {e.home && !e.chosen && e.how === 'essential' && <small className="gp-guess" title="No series has the event's name; this one has the most essential issues in its reading order">guessed</small>}
                </div>
                <div className="gp-strip">
                  {shown.map(m => (
                    <span key={m.id} className={`gp-cover${m.hidden ? '' : ' gp-visible'}`} title={`${m.name} · ${ROLE_LABEL[m.role] || m.role}${m.hidden ? '' : ' · also in the browser'}`}>
                      <img src={`/api/series/${encodeURIComponent(m.id)}/thumbnail`} alt={m.name} loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                      <button type="button" className="gp-x" aria-label={`Take ${m.name} off this shelf`} disabled={!!busy}
                        onClick={() => act(m.id, () => call('DELETE', `/api/series/${encodeURIComponent(m.id)}/shelf/${encodeURIComponent(e.home)}`))}>✕</button>
                    </span>))}
                  {e.members.length > STRIP && <button type="button" className="gp-more" onClick={() => setOpen(o => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'less' : `+${e.members.length - STRIP}`}</button>}
                  {!e.members.length && <span className="gp-muted gp-empty">Nothing on its shelf</span>}
                </div>
              </div>
              <div className="gp-actions">
                {!e.confirmed && e.home && <button className="adm-btn" disabled={!!busy} onClick={() => setEvent(e, { confirm: true })}>✓ Looks right</button>}
                <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => setPicking(e)}>Change home</button>
                <label className="gp-switch" title="An initiative's series stay in the browser"><input type="checkbox" checked={e.initiative} disabled={!!busy} onChange={ev => setEvent(e, { initiative: ev.target.checked })} /> Initiative</label>
              </div>
            </div>
          );
        })}
      </div>
      <p className="gp-legend"><span className="gp-dot" /> also in the browser (lead-in, aftermath, main story or landmark) · hover a cover for its name · ✕ takes it off</p>
      {picking && <SeriesPickerDialog title={`Home for ${picking.name}`} onClose={() => setPicking(null)}
        intro="Its minis and one-shots go on this series' Specials tab."
        onPick={async s => { await call('POST', `/api/grouping/events/${encodeURIComponent(picking.id)}`, { homeSeriesId: s.id }); invalidate(null); await load(); }} />}
      <style>{`
        .gp-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
        .gp-muted { color: var(--text-muted); font-size: 0.85rem; font-weight: 400; }
        .gp-error { color: var(--td-red, #e55); }
        .gp-tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
        .gp-tabs [role=tab] { padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border-subtle); background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; font-size: 0.85rem; }
        .gp-tabs [role=tab][aria-selected=true] { border-color: var(--td-yellow, var(--color-primary)); color: var(--text-primary); }
        .gp-tabs [role=tab] b { color: var(--text-primary); margin-left: 4px; }
        .gp-all { margin-left: auto; }
        .gp-rows { display: flex; flex-direction: column; gap: 10px; }
        .gp-row { display: grid; grid-template-columns: 72px 1fr auto; gap: 14px; align-items: center; padding: 10px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-card); }
        .gp-done { opacity: 0.85; }
        .gp-home { width: 72px; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; outline: 2px solid var(--td-yellow, var(--color-primary)); background: color-mix(in srgb, var(--bg-card) 70%, black); display: flex; align-items: center; justify-content: center; }
        .gp-home img { width: 100%; height: 100%; object-fit: cover; }
        .gp-nohome { font-size: 0.7rem; color: var(--text-muted); text-align: center; }
        .gp-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .gp-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
        .gp-event { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); width: 100%; }
        .gp-event em { font-style: normal; color: var(--td-yellow, var(--color-primary)); }
        .gp-guess { font-size: 0.7rem; padding: 1px 6px; border-radius: 999px; border: 1px dashed var(--text-muted); color: var(--text-muted); cursor: help; }
        .gp-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .gp-cover { position: relative; width: 40px; aspect-ratio: 2 / 3; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--bg-card) 70%, black); }
        .gp-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .gp-visible::after { content: ''; position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--td-yellow, var(--color-primary)); box-shadow: 0 0 0 1px #000; }
        .gp-x { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 1rem; opacity: 0; cursor: pointer; }
        .gp-cover:hover .gp-x, .gp-x:focus-visible { opacity: 1; }
        .gp-more { height: 60px; padding: 0 8px; border: 1px dashed var(--border-subtle); border-radius: 3px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; font-size: 0.8rem; }
        .gp-empty { font-size: 0.8rem; }
        .gp-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
        .gp-switch { font-size: 0.78rem; color: var(--text-muted); display: flex; gap: 6px; align-items: center; justify-content: center; }
        .gp-legend { font-size: 0.78rem; color: var(--text-muted); margin-top: 12px; }
        .gp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--td-yellow, var(--color-primary)); margin-right: 4px; }
        @media (max-width: 640px) { .gp-row { grid-template-columns: 56px 1fr; } .gp-home { width: 56px; } .gp-actions { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; } }
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
