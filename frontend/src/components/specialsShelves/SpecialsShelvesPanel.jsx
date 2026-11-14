import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSeriesCache } from '../../App';
import { ROLE_LABEL, call, enc } from '../seriesShelf/api';
import { SeriesPickerDialog } from '../seriesShelf/SeriesPickerDialog';
import { setMode } from './shared';
import AiBar from './AiBar';
import AiLine from './AiLine';
import MinisPanel from './MinisPanel';
import './specialsShelves.css';

// Library page › Specials shelves (2026-11-13): every event as one row of covers. The home's cover
// is large; the series on its shelf follow as small covers (✕ takes one off). Events not yet
// checked come first; "Looks right" locks the home, "Change home" picks another. Each row says in
// one line why the rules chose its home and links to the event's reading order. Every action
// can be undone for a few seconds; series taken off a shelf wait on the Removed tab.
// Shelf Sorter (backend/shelfSorter.js): "✦ Ask the AI" saves its view of each event, shown on the
// row in one line; "Apply n sure changes" applies the confident ones (Undo, and later from ⋯).
const STRIP = 14;
const UNDO_MS = 10000;
export default function SeriesGroupingPanel() {
  const navigate = useNavigate();
  const { invalidate } = useSeriesCache();
  const [data, setData] = useState(null);
  const [removed, setRemoved] = useState([]);
  const [minis, setMinis] = useState(null);   // stage B: the AI's answers about minis and one-shots
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [picking, setPicking] = useState(null);
  const [view, setView] = useState('check');
  const [open, setOpen] = useState({});
  const [undo, setUndo] = useState(null);   // { text, run }
  const [pending, setPending] = useState(null);   // an ask waiting for the admin's go: { title, model, options }
  const load = useCallback(() => Promise.all([
    fetch('/api/grouping').then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); }),
    fetch('/api/grouping/removed').then(r => r.ok ? r.json() : { items: [] }).then(d => setRemoved(d.items || [])).catch(() => {}),
  ]).then(() => setError('')).catch(e => setError(e.message)), []);
  const minisOn = !!data && data.enabled !== false && (data.mode || 'all') === 'all';
  // The Minis & one-shots tab only with Events and minis.
  const loadMinis = useCallback(() => fetch('/api/grouping/series').then(r => r.ok ? r.json() : null)
    .then(d => { if (d && Array.isArray(d.suggested)) setMinis(d); }).catch(() => {}), []);
  useEffect(() => { if (minisOn) loadMinis(); else setMinis(null); }, [minisOn, loadMinis, data]);
  useEffect(() => { if (!minisOn && view === 'minis') setView('check'); }, [minisOn, view]);
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
  // Specials shelves are optional (off on a new install): explain them and offer the switch.
  if (data.enabled === false) return (
    <div className="gp gp-off">
      <p><b>Specials shelves are off.</b> Turned on, Omnibus puts an event's tie-ins on the Specials tab of one home series, so the
        series list shows the series you read. Nothing on disk moves, search still finds everything, and every change can be undone.</p>
      <p className="gp-muted"><b>Events only</b> follows your Timeline events: you check one home per event. (An empty Timeline? Load the starter pack there.)
        <br /><b>Events and minis</b> also suggests homes for side minis and one-shots, one at a time for you to accept. Best with an AI key and a Metron token; a large library means a long list.</p>
      {error && <p className="gp-error">{error}</p>}
      <div className="gp-off-actions">
        <button className="adm-btn adm-btn-primary" disabled={!!busy} onClick={() => act('on', () => setMode('events'))}>Turn on: Events only</button>
        <button className="adm-btn" disabled={!!busy} onClick={() => act('on', () => setMode('all'))}>Turn on: Events and minis</button>
      </div>
    </div>
  );
  const manual = data.counts?.manual || { links: 0 };
  const all = Object.values(data.counts || {}).reduce((t, c) => ({ links: t.links + (c.links || 0), hidden: t.hidden + (c.hidden || 0) }), { links: 0, hidden: 0 });
  // To check: events the AI disagrees with come first.
  const aiDiffers = e => !!e.ai && !e.ai.stale && ((e.ai.home.verdict === 'change' && e.ai.home.open) || e.ai.home.verdict === 'none');
  // Only events with something on their shelf: a crossover with no minis or one-shots needs no home.
  const toCheck = data.events.filter(e => !e.confirmed && e.members.length).sort((a, b) => aiDiffers(b) - aiDiffers(a));
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
  const askAi = body => act('ai', () => call('POST', '/api/grouping/ai/ask', body || {}));
  // No AI call runs without the admin's go (2026-11-14): every ask shows what it covers and how many
  // AI calls it takes first. Without an AI key a new ask (Omnibus's own suggestions) costs nothing.
  const prepare = (kinds, scopes, title) => act('est', async () => {
    const est = await call('POST', '/api/grouping/ai/estimate', { kinds, scopes });
    const options = scopes.map(k => ({ key: k, kinds, ...est[k] })).filter(o => o.events + o.series > 0);
    if (!options.length) return { none: true };
    if (options.length === 1 && options[0].local) { await call('POST', '/api/grouping/ai/ask', { kinds, scope: options[0].key }); return {}; }
    setPending({ title, model: options[0].model, options });
    return {};
  }, r => r?.none ? { text: 'Nothing to ask the AI about.', run: null } : null);
  const go = o => { setPending(null); askAi({ kinds: o.kinds, scope: o.key }); };
  const undoAiRun = id => () => call('POST', `/api/grouping/ai/runs/${enc(id)}/undo`);
  const useAdvice = e => act(e.id, () => call('POST', '/api/grouping/ai/apply', { eventIds: [e.id] }), r => r?.applied
    ? { text: `Used the AI's advice for ${e.name}.`, run: undoAiRun(r.runId) } : null);
  const restoreOne = x => act(`r:${x.seriesId}`, () => call('POST', '/api/grouping/restore', { items: [{ seriesId: x.seriesId, homeId: x.homeId }] }), () => ({
    text: `Put ${x.name} back on ${x.homeName}'s shelf.`,
    run: () => call('DELETE', `/api/series/${enc(x.seriesId)}/shelf/${enc(x.shelfHomeId || x.homeId)}`),
  }));
  return (
    <div className="gp">
      <div className="gp-head">
        <span><b>{all.links.toLocaleString()}</b> series on shelves <span className="gp-muted">· {all.hidden} out of the browser{manual.links ? ` · ${manual.links} by hand` : ''}</span></span>
        <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => act('run', () => call('POST', '/api/grouping/run'))}
          title="The rules follow your Timeline reading orders; they also run after scans, new series.json files and every hour">{busy === 'run' ? 'Running…' : '↻ Run the rules'}</button>
      </div>
      <AiBar aiInfo={aiInfo} busy={busy} asking={asking} act={act} prepare={prepare} pending={pending} setPending={setPending} go={go} mode={data.mode || 'all'} />
      <div className="gp-tabs" role="tablist">
        {[['check', 'To check', toCheck.length], ['shelves', 'Events with a shelf', withShelf.length], ['all', 'All events', data.events.length], ...(minisOn ? [['minis', 'Minis & one-shots', minis ? minis.suggested.length + (minis.counts?.rethink || 0) : 0]] : []), ['removed', 'Removed', removed.length]].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>{label} <b>{n}</b></button>))}
        {view === 'check' && toCheck.length > 0 && <button className="adm-btn gp-all" disabled={!!busy} onClick={confirmAll}
          title="Approves and locks every home in this list. Undo is offered afterwards.">✓ All look right</button>}
      </div>
      {error && <p className="gp-error">{error}</p>}
      {view === 'check' && !toCheck.length && <p className="gp-muted">Every event with something on its shelf has been checked.</p>}
      {view === 'minis' && minisOn && <MinisPanel data={minis} busy={!!busy} act={act} />}
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
      {view !== 'removed' && view !== 'minis' && <p className="gp-legend"><span className="gp-dot" /> also in the browser (lead-in, aftermath, main story or landmark) · hover a cover for its name · ✕ takes it off{data.ai?.asked ? ' · red ring: the AI would take it off · blue: keep it visible' : ''}</p>}
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
    </div>
  );
}

