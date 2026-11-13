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
// checked come first; "Looks right" locks the home, "Change home" picks another. Each row says in
// one line why the rules chose its home and links to the event's reading order. Every action
// can be undone for a few seconds; series taken off a shelf wait on the Removed tab.
// Shelf Sorter (backend/shelfSorter.js): "✦ Ask the AI" saves its view of each event, shown on the
// row in one line; "Apply n sure changes" applies the confident ones (Undo, and later from ⋯).
const STRIP = 14;
const CONF_LABEL = { sure: 'sure', likely: 'likely', unsure: 'unsure' };
const UNDO_MS = 10000;
const enc = encodeURIComponent;
export function SeriesGroupingPanel() {
  const navigate = useNavigate();
  const { invalidate } = useSeriesCache();
  const [data, setData] = useState(null);
  const [removed, setRemoved] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [picking, setPicking] = useState(null);
  const [view, setView] = useState('check');
  const [open, setOpen] = useState({});
  const [undo, setUndo] = useState(null);   // { text, run }
  const load = useCallback(() => Promise.all([
    fetch('/api/grouping').then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); }),
    fetch('/api/grouping/removed').then(r => r.ok ? r.json() : { items: [] }).then(d => setRemoved(d.items || [])).catch(() => {}),
  ]).then(() => setError('')).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const asking = !!data?.ai?.running;
  useEffect(() => { if (!asking) return undefined; const t = setInterval(load, 3000); return () => clearInterval(t); }, [asking, load]);
  useEffect(() => { if (!undo) return undefined; const t = setTimeout(() => setUndo(null), UNDO_MS); return () => clearTimeout(t); }, [undo]);
  // act(key, fn, undoOf): run fn; undoOf(result) → { text, run } offers Undo.
  const act = async (key, fn, undoOf) => {
    setBusy(key); setError('');
    try {
      const r = await fn(); invalidate(null); await load();
      setUndo(undoOf ? undoOf(r) : null);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const runUndo = () => { const u = undo; setUndo(null); if (u) act('undo', u.run); };
  if (!data) return <p className="a-muted">{error || 'Loading…'}</p>;
  const rule = data.counts?.rule || { links: 0, hidden: 0 }, manual = data.counts?.manual || { links: 0 };
  // To check: events the AI disagrees with come first.
  const aiDiffers = e => !!e.ai && !e.ai.stale && ((e.ai.home.verdict === 'change' && e.ai.home.open) || e.ai.home.verdict === 'none');
  const toCheck = data.events.filter(e => !e.confirmed && (e.home || e.members.length)).sort((a, b) => aiDiffers(b) - aiDiffers(a));
  const aiInfo = data.ai || {};
  const withShelf = data.events.filter(e => e.members.length);
  const list = view === 'check' ? toCheck : view === 'shelves' ? withShelf : view === 'all' ? data.events : [];
  const restoreEvent = (e, previous) => () => call('POST', `/api/grouping/events/${enc(e.id)}`, { restore: previous });
  const setEvent = (e, body, text) => act(e.id, () => call('POST', `/api/grouping/events/${enc(e.id)}`, body),
    r => r?.previous ? { text, run: restoreEvent(e, r.previous) } : null);
  const takeOff = (e, m) => act(m.id, () => call('DELETE', `/api/series/${enc(m.id)}/shelf/${enc(e.home)}`), r => ({
    text: `Took ${m.name} off ${e.homeName}'s shelf.`,
    run: () => r?.source === 'manual' ? call('POST', `/api/series/${enc(m.id)}/shelf`, { homeId: e.home })
      : call('POST', '/api/grouping/restore', { items: [{ seriesId: m.id, homeId: e.home, eventId: e.id }] }),
  }));
  const emptyShelf = e => act(e.id, () => call('POST', `/api/grouping/events/${enc(e.id)}/empty`), r => ({
    text: `Took ${r?.removed?.length || 0} series off ${e.homeName}'s shelf.`,
    run: () => call('POST', '/api/grouping/restore', { items: r?.removed || [] }),
  }));
  const confirmAll = () => act('all', () => call('POST', '/api/grouping/events/confirm-all'), r => ({
    text: `Approved ${r?.confirmed || 0} event homes.`,
    run: () => call('POST', '/api/grouping/events/restore', { states: r?.previous || [] }),
  }));
  const askAi = force => act('ai', () => call('POST', '/api/grouping/ai/ask', force ? { force: true } : {}));
  const undoAiRun = id => () => call('POST', `/api/grouping/ai/runs/${enc(id)}/undo`);
  const applyAi = () => act('ai', () => call('POST', '/api/grouping/ai/apply'), r => r?.applied
    ? { text: `Applied ${r.applied} change${r.applied === 1 ? '' : 's'} from the AI.`, run: undoAiRun(r.runId) } : { text: 'Nothing new to apply.', run: null });
  const useAdvice = e => act(e.id, () => call('POST', '/api/grouping/ai/apply', { eventIds: [e.id] }), r => r?.applied
    ? { text: `Used the AI's advice for ${e.name}.`, run: undoAiRun(r.runId) } : null);
  const closeMenu = ev => { const d = ev.currentTarget.closest('details'); if (d) d.open = false; };
  const restoreOne = x => act(`r:${x.seriesId}`, () => call('POST', '/api/grouping/restore', { items: [{ seriesId: x.seriesId, homeId: x.homeId }] }), () => ({
    text: `Put ${x.name} back on ${x.homeName}'s shelf.`,
    run: () => call('DELETE', `/api/series/${enc(x.seriesId)}/shelf/${enc(x.shelfHomeId || x.homeId)}`),
  }));
  return (
    <div className="gp">
      <div className="gp-head">
        <span><b>{(rule.links + (manual.links || 0)).toLocaleString()}</b> series on shelves <span className="gp-muted">· {rule.hidden} out of the browser{manual.links ? ` · ${manual.links} by hand` : ''}</span></span>
        <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => act('run', () => call('POST', '/api/grouping/run'))}
          title="The rules follow your Timeline reading orders; they also run after scans, new series.json files and every hour">{busy === 'run' ? 'Running…' : '↻ Run the rules'}</button>
      </div>
      <div className="gp-ai">
        {asking
          ? <><span className="gp-ai-progress"><span style={{ width: `${Math.round(100 * aiInfo.running.done / Math.max(1, aiInfo.running.total))}%` }} /></span>
              <span>✦ Asking the AI… {aiInfo.running.done} of {aiInfo.running.total} events</span>
              <button type="button" className="gp-link" onClick={() => act('ai', () => call('POST', '/api/grouping/ai/stop'))}>Stop</button></>
          : <><button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => askAi(false)}
              title="The AI checks each event's home and shelf against its reading order. It only answers; nothing changes until you apply.">✦ Ask the AI</button>
              {aiInfo.ready > 0 && <button className="adm-btn" disabled={!!busy} onClick={applyAi} title="Applies the answers the AI is sure of. Undo is offered afterwards.">✓ Apply {aiInfo.ready} sure change{aiInfo.ready === 1 ? '' : 's'}</button>}
              <span className="gp-muted gp-ai-line" title={aiInfo.lastAsk?.error || ''}>
                {aiInfo.lastAsk?.error && !aiInfo.lastAsk.asked ? `Last try failed: ${aiInfo.lastAsk.error}` : aiInfo.asked ? `Asked about ${aiInfo.asked} events` : 'Not asked yet'}
                {aiInfo.model ? ` · ${aiInfo.model}` : ''}{aiInfo.auto ? ' · applies sure answers on its own' : ''}
              </span></>}
        <details className="gp-menu gp-ai-menu">
          <summary aria-label="AI options">⋯</summary>
          <div className="gp-menu-items">
            <label className="gp-menu-check" title="Each hour the AI checks new or changed events and applies the answers it is sure of. Each run can be undone.">
              <input type="checkbox" checked={!!aiInfo.auto} disabled={!!busy} onChange={ev => act('ai', () => call('POST', '/api/grouping/ai/auto', { on: ev.target.checked }))} /> Apply sure answers on its own
            </label>
            {aiInfo.lastApplied && <button type="button" disabled={!!busy} onClick={ev => { closeMenu(ev); act('ai', undoAiRun(aiInfo.lastApplied.id), () => ({ text: 'Undid the AI\'s last changes.', run: null })); }}>
              Undo the AI's last changes ({aiInfo.lastApplied.applied})</button>}
            <button type="button" disabled={!!busy || asking} onClick={ev => { closeMenu(ev); askAi(true); }} title="Asks about every event again, also the ones that have not changed">Ask again about every event</button>
            <button type="button" onClick={ev => { closeMenu(ev); navigate('/settings?tab=ai'); }}>Choose the AI model…</button>
          </div>
        </details>
      </div>
      <div className="gp-tabs" role="tablist">
        {[['check', 'To check', toCheck.length], ['shelves', 'Events with a shelf', withShelf.length], ['all', 'All events', data.events.length], ['removed', 'Removed', removed.length]].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>{label} <b>{n}</b></button>))}
        {view === 'check' && toCheck.length > 0 && <button className="adm-btn gp-all" disabled={!!busy} onClick={confirmAll}
          title="Approves and locks every home in this list. Undo is offered afterwards.">✓ All look right</button>}
      </div>
      {error && <p className="gp-error">{error}</p>}
      {view === 'check' && !toCheck.length && <p className="gp-muted">Every event's home has been checked.</p>}
      {view === 'removed' && (removed.length
        ? <div className="gp-removed">{removed.map(x => (
            <div key={`${x.seriesId}|${x.homeId}`} className="gp-rm" title={`${x.name} · taken off ${x.homeName}'s shelf`}>
              <img src={`/api/series/${enc(x.seriesId)}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
              <span className="gp-rm-name">{x.name}</span>
              <span className="gp-muted gp-rm-from">from {x.homeName}</span>
              <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => restoreOne(x)}>↺ Restore</button>
            </div>))}</div>
        : <p className="gp-muted">Nothing has been taken off a shelf.</p>)}
      <div className="gp-rows">
        {list.map(e => {
          const shown = open[e.id] ? e.members : e.members.slice(0, STRIP);
          return (
            <div key={e.id} className={`gp-row${e.confirmed ? ' gp-done' : ''}`}>
              <div className="gp-home" title={e.homeName || 'No home'}>
                {e.home ? <img src={`/api/series/${enc(e.home)}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} /> : <span className="gp-nohome">No home</span>}
              </div>
              <div className="gp-body">
                <div className="gp-title">
                  <span className="gp-event">{e.name}{e.year ? ` · ${e.year}` : ''}{e.initiative ? <em> · initiative</em> : null}{e.confirmed ? <em> · ✓ {e.source === 'ai' ? 'approved by the AI' : 'approved'}</em> : null}</span>
                  <b>{e.homeName || (e.initiative ? 'Series stay in the browser' : 'No home series')}</b>
                  {e.home && !e.chosen && e.how === 'essential' && <small className="gp-guess" title="No series has the event's name; this one has the most main-story issues in its reading order">guessed</small>}
                </div>
                <div className="gp-why" title={e.why || ''}>
                  <span>{e.why}</span>
                  <button type="button" className="gp-link" onClick={() => navigate(`/events/${enc(e.id)}`)}>Reading order ›</button>
                </div>
                {e.ai && <AiLine e={e} busy={!!busy} onUse={() => useAdvice(e)} />}
                {e.suggest && <div className="gp-suggest">The rules now suggest <b>{e.suggest.name}</b>
                  <button type="button" className="gp-link" disabled={!!busy} onClick={() => setEvent(e, { homeSeriesId: e.suggest.id }, `${e.name}'s home is now ${e.suggest.name}.`)}>Use it</button></div>}
                <div className="gp-strip">
                  {shown.map(m => {
                    const adv = e.ai && !e.ai.stale ? e.ai.members.find(x => x.seriesId === m.id) : null;
                    return (
                    <span key={m.id} className={`gp-cover${m.hidden ? '' : ' gp-visible'}${adv ? ` gp-ai-${adv.action === 'remove' ? 'remove' : 'keep'}` : ''}`}
                      title={`${m.name} · ${ROLE_LABEL[m.role] || m.role}${m.hidden ? '' : ' · also in the browser'}${adv ? `\nAI (${adv.confidence}): ${adv.action === 'remove' ? 'take it off' : 'keep it visible'}. ${adv.why}` : ''}`}>
                      <img src={`/api/series/${enc(m.id)}/thumbnail`} alt={m.name} loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                      <button type="button" className="gp-x" aria-label={`Take ${m.name} off this shelf`} disabled={!!busy} onClick={() => takeOff(e, m)}>✕</button>
                    </span>);
                  })}
                  {e.members.length > STRIP && <button type="button" className="gp-more" onClick={() => setOpen(o => ({ ...o, [e.id]: !o[e.id] }))}>{open[e.id] ? 'less' : `+${e.members.length - STRIP}`}</button>}
                  {!e.members.length && <span className="gp-muted gp-empty">Nothing on its shelf</span>}
                </div>
              </div>
              <div className="gp-actions">
                {!e.confirmed && e.home && <button className="adm-btn" disabled={!!busy} onClick={() => setEvent(e, { confirm: true }, `Approved ${e.homeName} for ${e.name}.`)}>✓ Looks right</button>}
                {e.confirmed && <button className="adm-btn adm-btn-ghost" disabled={!!busy} title="Back to the rule's guess, in To check"
                  onClick={() => setEvent(e, { reset: true }, `${e.name} is back in To check.`)}>↺ Not right</button>}
                <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => setPicking(e)}>Change home</button>
                <details className="gp-menu">
                  <summary aria-label="More">⋯</summary>
                  <div className="gp-menu-items">
                    <button type="button" disabled={!!busy} onClick={ev => { ev.currentTarget.closest('details').open = false; setEvent(e, { initiative: !e.initiative }, e.initiative ? `${e.name} is no longer an initiative.` : `${e.name} is now an initiative.`); }}
                      title="An initiative's series stay in the browser and get no home unless you choose one">{e.initiative ? 'Not an initiative' : 'Mark as an initiative'}</button>
                    {e.members.length > 0 && <button type="button" disabled={!!busy} onClick={ev => { ev.currentTarget.closest('details').open = false; emptyShelf(e); }}
                      title="Takes every series off this shelf. They wait on the Removed tab.">Empty this shelf</button>}
                  </div>
                </details>
              </div>
            </div>
          );
        })}
      </div>
      {view !== 'removed' && <p className="gp-legend"><span className="gp-dot" /> also in the browser (lead-in, aftermath, main story or landmark) · hover a cover for its name · ✕ takes it off{data.ai?.asked ? ' · red ring: the AI would take it off · blue: keep it visible' : ''}</p>}
      {undo && <div className="gp-undo" role="status"><span>{undo.text}</span>{undo.run && <button type="button" className="gp-link" disabled={!!busy} onClick={runUndo}>Undo</button>}
        <button type="button" className="gp-undo-x" aria-label="Dismiss" onClick={() => setUndo(null)}>✕</button></div>}
      {picking && <SeriesPickerDialog title={`Home for ${picking.name}`} onClose={() => setPicking(null)}
        intro={<>Its minis and one-shots go on this series' Specials tab.
          {picking.chosen && picking.proposed && picking.proposed !== picking.chosen && <> <button type="button" className="gp-link" onClick={() => {
            const e = picking; setPicking(null);
            setEvent(e, { homeSeriesId: null }, `${e.name} is back to the rule's choice.`);
          }}>Use the rule's choice ({picking.proposedName})</button></>}</>}
        onPick={async s => {
          const e = picking;
          const r = await call('POST', `/api/grouping/events/${enc(e.id)}`, { homeSeriesId: s.id });
          invalidate(null); await load();
          if (r?.previous) setUndo({ text: `${e.name}'s home is now ${s.displayTitle || s.name}.`, run: restoreEvent(e, r.previous) });
        }} />}
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
        .gp-why { display: flex; gap: 10px; align-items: baseline; min-width: 0; font-size: 0.8rem; color: var(--text-muted); }
        .gp-why span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .gp-link { background: none; border: 0; padding: 0; color: var(--td-yellow, var(--color-primary)); cursor: pointer; font: inherit; font-size: 0.8rem; white-space: nowrap; }
        .gp-link:hover:not(:disabled) { text-decoration: underline; }
        .gp-suggest { font-size: 0.8rem; color: var(--text-primary); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
        .gp-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .gp-cover { position: relative; width: 40px; aspect-ratio: 2 / 3; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--bg-card) 70%, black); }
        .gp-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .gp-visible::after { content: ''; position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 50%; background: var(--td-yellow, var(--color-primary)); box-shadow: 0 0 0 1px #000; }
        .gp-x { position: absolute; inset: 0; border: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 1rem; opacity: 0; cursor: pointer; }
        .gp-cover:hover .gp-x, .gp-x:focus-visible { opacity: 1; }
        .gp-more { height: 60px; padding: 0 8px; border: 1px dashed var(--border-subtle); border-radius: 3px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; font-size: 0.8rem; }
        .gp-empty { font-size: 0.8rem; }
        .gp-actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
        .gp-menu { position: relative; align-self: center; }
        .gp-menu summary { list-style: none; cursor: pointer; padding: 2px 10px; border-radius: 6px; color: var(--text-muted); font-size: 1.1rem; line-height: 1; }
        .gp-menu summary::-webkit-details-marker { display: none; }
        .gp-menu[open] summary { color: var(--text-primary); }
        .gp-menu-items { position: absolute; right: 0; top: 100%; z-index: 5; display: flex; flex-direction: column; min-width: 180px; padding: 4px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-card); box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
        .gp-menu-items button { text-align: left; background: none; border: 0; padding: 7px 10px; border-radius: 5px; color: var(--text-primary); cursor: pointer; font: inherit; font-size: 0.85rem; }
        .gp-menu-items button:hover:not(:disabled) { background: color-mix(in srgb, var(--td-yellow, #fc0) 12%, transparent); }
        .gp-removed { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 14px; }
        .gp-rm { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .gp-rm img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; background: var(--bg-card); opacity: 0.7; }
        .gp-rm-name { font-weight: 700; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gp-rm-from { font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gp-undo { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 50; display: flex; gap: 14px; align-items: center; max-width: calc(100vw - 32px);
          padding: 10px 14px; border-radius: 10px; background: var(--bg-card); border: 1px solid var(--border-subtle); box-shadow: 0 8px 28px rgba(0,0,0,0.45); font-size: 0.88rem; }
        .gp-undo span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gp-undo .gp-link { font-size: 0.88rem; font-weight: 700; }
        .gp-undo-x { background: none; border: 0; color: var(--text-muted); cursor: pointer; }
        .gp-ai { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; font-size: 0.85rem; }
        .gp-ai-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 200px; }
        .gp-ai-progress { width: 120px; height: 6px; border-radius: 3px; background: var(--border-subtle); overflow: hidden; }
        .gp-ai-progress span { display: block; height: 100%; background: var(--td-yellow, var(--color-primary)); transition: width .4s; }
        .gp-ai-menu { margin-left: auto; }
        .gp-menu-check { display: flex; gap: 8px; align-items: center; padding: 7px 10px; font-size: 0.85rem; cursor: pointer; }
        .gp-airow { display: flex; gap: 8px; align-items: baseline; min-width: 0; font-size: 0.8rem; }
        .gp-airow > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gp-airow .gp-star { color: var(--td-yellow, var(--color-primary)); }
        .gp-airow.gp-ai-differs > span { color: var(--text-primary); }
        .gp-conf { font-size: 0.7rem; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-subtle); color: var(--text-muted); white-space: nowrap; }
        .gp-conf-sure { border-color: var(--td-yellow, var(--color-primary)); color: var(--td-yellow, var(--color-primary)); }
        .gp-ai-remove { outline: 2px solid var(--td-red, #e55); outline-offset: -2px; }
        .gp-ai-keep { outline: 2px solid #5aa9e6; outline-offset: -2px; }
        .gp-legend { font-size: 0.78rem; color: var(--text-muted); margin-top: 12px; }
        .gp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--td-yellow, var(--color-primary)); margin-right: 4px; }
        @media (max-width: 640px) { .gp-row { grid-template-columns: 56px 1fr; } .gp-home { width: 56px; } .gp-actions { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; } }
      `}</style>
    </div>
  );
}

// One line under an event: what the Shelf Sorter thinks. Detail on hover.
function AiLine({ e, busy, onUse }) {
  const a = e.ai, h = a.home;
  const changes = a.stale ? [] : a.members;       // the advice that would still change something
  const homeOpen = !a.stale && h.open && h.verdict === 'change';
  const text = h.verdict === 'change' && h.seriesId === e.home ? <>AI agrees</>
    : h.verdict === 'change' ? (homeOpen ? <>AI suggests <b>{h.name}</b></> : <>AI suggested {h.name}</>)
    : h.verdict === 'none' ? <>AI: no series in your library should hold this shelf</>
    : <>AI agrees</>;
  const rm = changes.filter(m => m.action === 'remove').length, kv = changes.length - rm;
  const more = [rm && `take off ${rm}`, kv && `keep ${kv} visible`].filter(Boolean).join(', ');
  const detail = [h.why, ...a.members.map(m => `${m.name}: ${m.action === 'remove' ? 'take off' : 'keep visible'} (${m.confidence}) ${m.why}`),
    a.stale ? 'Asked before this event or its shelf changed.' : '', a.undone ? 'Its changes here were undone, so they are only advice now.' : '', a.model ? `Model: ${a.model}` : ''].filter(Boolean).join('\n');
  const differs = homeOpen || h.verdict === 'none';
  return (
    <div className={`gp-airow${differs ? ' gp-ai-differs' : ''}`} title={detail}>
      <span><span className="gp-star">✦</span> {text}{more ? ` · ${more}` : ''}{a.stale ? ' · out of date' : ''}</span>
      <small className={`gp-conf gp-conf-${h.confidence}`}>{CONF_LABEL[h.confidence] || h.confidence}</small>
      {homeOpen || changes.length ? <button type="button" className="gp-link" disabled={busy} onClick={onUse}>Use the AI's advice</button> : null}
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
