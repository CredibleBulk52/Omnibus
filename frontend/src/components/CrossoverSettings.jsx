import React, { useCallback, useEffect, useState } from 'react';

// Settings › AI & Comic Book Guy › Crossover links (2026-11-22, backend/crossovers.js; claude/CROSSOVERS.md).
// Summary links are free and rebuilt nightly. The web check costs a little per new issue, so it is off
// until chosen here: weekly, monthly, or "Check now" (the estimate is shown first).
const money = usd => (usd >= 1 ? `$${usd.toFixed(2)}` : `${Math.max(0.1, Math.round(usd * 1000) / 10)}¢`);
const when = ms => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

export default function CrossoverSettings() {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => fetch('/api/admin/crossovers').then(r => r.json()).then(setSt).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!st?.run?.running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [st?.run?.running, load]);
  const post = async (path, body) => {
    setErr('');
    const r = await fetch(`/api/admin/crossovers${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setErr(d.error || 'Request failed'); else setSt(d.status || d);
  };
  if (!st) return <p className="form-hint">{err || 'Loading…'}</p>;
  const run = st.run || {};
  return (
    <div className="xo-settings">
      <p className="form-hint">Links a story that continues in another series (for example Green Lantern #40 → Green Lantern Corps #22) on the reader's end card and the issue page. Timeline events, reading order and shelves are not changed.</p>
      <p><b>{st.links.summary}</b> links from issue summaries (free, rebuilt nightly) · <b>{st.links.web}</b> from web checks{st.links.waiting ? <> ({st.links.waiting} waiting for an issue you don't have)</> : null}</p>
      <div className="xo-row">
        <label className="form-label" htmlFor="xo-frequency">Web check for new issues</label>
        <select id="xo-frequency" className="form-input" value={st.frequency} disabled={run.running} onChange={e => post('/settings', { frequency: e.target.value })}>
          <option value="off">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select>
      </div>
      <p className="form-hint">One Web Search question per new issue (released in the last {st.lookbackDays} days), about {money(st.perBook)} each; a link is kept only when a source page names both issues. Last check: {when(st.lastRun)}{st.nextRun ? ` · next: ${when(st.nextRun)}` : ''} · {st.checked} issues checked so far, {money(st.spent)} spent.</p>
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
      `}</style>
    </div>
  );
}
