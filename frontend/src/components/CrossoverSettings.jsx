import React, { useCallback, useEffect, useState } from 'react';

// Library > Crossover links.
// Summary links are free and rebuilt nightly. The web check costs a little per new issue, so it is off
// until chosen here: weekly, monthly, or "Check now" (the estimate is shown first).
const money = usd => (usd >= 1 ? `$${usd.toFixed(2)}` : `${Math.max(0.1, Math.round(usd * 1000) / 10)}¢`);
const when = ms => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

export default function CrossoverSettings() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [startingRefresh, setStartingRefresh] = useState(false);
  const load = useCallback(() => fetch('/api/admin/crossovers').then(r => r.json()).then(setSt).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!st?.run?.running && !st?.wiki?.running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st?.run?.running, st?.wiki?.running, load]);
  const post = async (path, body) => {
    setErr('');
    try {
      const r = await fetch(`/api/admin/crossovers${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json();
      if (!r.ok) setErr(d.error || 'Request failed'); else setSt(d.status || d);
    } catch (e) { setErr(e.message); }
  };
  const refresh = async () => {
    setStartingRefresh(true);
    try { await post('/refresh', { wiki: true }); } finally { setStartingRefresh(false); }
  };
  if (!st) return <p className="form-hint">{err || 'Loading…'}</p>;
  const run = st.run || {};
  return (
    <div className="xo-settings">
      <p className="form-hint">Links a story that continues in another series (for example Green Lantern #40 → Green Lantern Corps #22): the reader's end card, the issue page, and the series page's Reading order view. Two ways to find them; each switch also hides the links it found (they are kept for when it is switched back on).</p>
      <label className="xo-switch"><input type="checkbox" checked={st.code} onChange={e => post('/switches', { code: e.target.checked })} /> Free sources: issue text and fan wikis</label>
      <p className="form-hint xo-indent">Summaries that name the other issue ("Continued in Superman #50"), story titles with part numbers in two series ("First Light, Part 1" / "Part Two"), and the DC and Marvel fan wikis' "continues from / in" notes (read from Fandom, about 1,500 pages a night until the library is done, then only new issues). Rebuilt every night.
        {st.code && <> <b>{st.links.summary + st.links.title + st.links.wiki}</b> links ({st.links.summary} from summaries, {st.links.title} from titles, {st.links.wiki} from wikis{st.wiki ? `; ${st.wiki.read} issues read on the wikis${st.wiki.running ? ', reading now…' : ''}` : ''}).</>}</p>
      {st.code && <div className="xo-row xo-indent">
        <button type="button" className="adm-btn" onClick={refresh} disabled={startingRefresh || st.wiki?.running}>Refresh free crossover links</button>
        <span role="status" className="form-hint">{startingRefresh ? 'Starting refresh…' : st.wiki?.running
          ? `Refreshing wiki links · ${st.wiki.books} issues checked`
          : st.wiki?.finishedAt && (st.wiki.error ? `Wiki refresh stopped: ${st.wiki.error}` : `Last wiki refresh: ${st.wiki.books} issues checked.`)}</span>
      </div>}
      <label className="xo-switch"><input type="checkbox" checked={st.ai} disabled={run.running && !st.ai} onChange={e => post('/switches', { ai: e.target.checked })} /> AI web check (paid, needs an AI key)</label>
      {!st.ai ? <p className="form-hint xo-indent">One Web Search question per new issue, about {money(st.perBook)} each. Off: no AI spending{st.links.web ? `; the ${st.links.web} links found earlier are hidden` : ''}.</p> : <div className="xo-indent">
      <p><b>{st.links.web}</b> links from web checks{st.links.waiting ? <> ({st.links.waiting} waiting for an issue you don't have)</> : null}</p>
      <div className="xo-row">
        <label className="form-label" htmlFor="xo-frequency">Check new issues</label>
        <select id="xo-frequency" className="form-input" value={st.frequency} disabled={run.running} onChange={e => post('/settings', { frequency: e.target.value })}>
          <option value="off">Only when I click Check now</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select>
      </div>
      <p className="form-hint">One Web Search question per new issue once it is tagged (released in the last {st.lookbackDays} days), once per issue however often it runs (daily costs the same as weekly, just sooner), about {money(st.perBook)} each (Gemini's Google searches are free up to 5,000 a month); a link is kept only when a source page names both issues. Last check: {when(st.lastRun)}{st.nextRun ? ` · next: ${when(st.nextRun)}` : ''} · {st.checked} issues checked so far, {money(st.spent)} spent.</p>
      {run.running ? <>
        <div className="xo-bar"><span style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%` }} /></div>
        <p>Issue {Math.min(run.done + 1, run.total)} of {run.total}{run.current ? <>: <b>{run.current}</b></> : null}</p>
        <p className="form-hint">{run.found} links found · {money(run.cost)} so far{run.stop ? ' · stopping…' : ''}</p>
        <button className="adm-btn" onClick={() => post('/stop')} disabled={run.stop}>Stop</button>
      </> : <>
        {run.finishedAt && <p className="form-hint">Last run: {run.done} of {run.total} issues, {run.found} links, {money(run.cost)}.</p>}
        {run.errors?.length > 0 && <ul className="xo-errors">{run.errors.map((e, i) => <li key={i}>{e.book ? <b>{e.book}: </b> : null}{e.error}</li>)}</ul>}
        <div className="xo-row">
          <span>{st.pending ? <>{st.pending} new issue{st.pending === 1 ? '' : 's'} not checked yet · about <b>{money(st.estimate)}</b></> : 'Every new issue has been checked.'}</span>
          <button className="adm-btn adm-btn-primary" disabled={!st.pending} onClick={() => post('/run')}>Check now</button>
        </div>
      </>}
      </div>}
      {!st.code && !st.ai && <p className="form-hint">Both off: readers see no crossover links.</p>}
      {err && <p role="alert" className="xo-err">{err}</p>}
      <style>{`
        .xo-settings p { margin: 8px 0; font-size: 14px; line-height: 1.45; }
        .xo-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; margin: 10px 0; }
        .xo-row .form-label { margin: 0; }
        .xo-row select { width: auto; min-width: 130px; }
        .xo-bar { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; margin: 10px 0; }
        .xo-bar span { display: block; height: 100%; background: var(--td-yellow); transition: width .3s; }
        .xo-errors { max-height: 120px; overflow-y: auto; font-size: 12px; color: #d9a441; padding-left: 18px; }
        .xo-err { color: #e07070; }
        .xo-switch { display: flex; align-items: center; gap: 8px; font-weight: 700; margin: 14px 0 2px; cursor: pointer; }
        .xo-indent { margin-left: 26px !important; }
      `}</style>
    </div>
  );
}
