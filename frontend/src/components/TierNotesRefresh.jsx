import React, { useEffect, useState, useCallback } from 'react';
import Modal from './Modal';
import { AiInfo } from './AiInfo';

// Admin: rewrite the tier notes of every event with the Event Tier Notes task (2026-10-22).
// Runs on the server one event at a time; this window starts it, shows progress and can stop it.
// Events already refreshed are skipped unless "All events again" is chosen.
const CENTS_PER_EVENT = 0.5;

export default function TierNotesRefresh() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => fetch('/api/events/notes/refresh-all').then(r => r.json()).then(setSt).catch(e => setErr(e.message)), []);
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open || !st?.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, st?.running, load]);

  const start = async all => {
    setErr('');
    const r = await fetch('/api/events/notes/refresh-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all }) });
    const d = await r.json();
    if (!r.ok) setErr(d.error || 'Could not start'); else load();
  };
  const stop = () => fetch('/api/events/notes/refresh-all/stop', { method: 'POST' }).then(load);
  const est = n => `about ${n * CENTS_PER_EVENT >= 100 ? `$${(n * CENTS_PER_EVENT / 100).toFixed(2)}` : `${Math.ceil(n * CENTS_PER_EVENT)}¢`}`;

  return <>
    <button className="admin-bar-btn" onClick={() => setOpen(true)} title="Rewrite every event's tier notes from tier reasons, solicits and synopses (Event Tier Notes)">✎ Refresh tier notes</button>
    {open && <Modal title="Refresh tier notes" onClose={() => setOpen(false)} width={480}>
      <div className="rl-modal-body tnr-box">
        <p className="tnr-muted">Writes a one-sentence note for each issue of every event, from the generator’s tier reasons, the issues’ solicits and saved synopses (no web search). New notes replace the old ones; an issue with nothing to write from keeps its old note. Runs on the server, one event at a time; you can close this window.</p>
        {!st ? <p className="tnr-muted">Loading…</p> : st.running ? <>
          <div className="tnr-bar"><span style={{ width: `${st.total ? (st.done / st.total) * 100 : 0}%` }} /></div>
          <p>Event {Math.min(st.done + 1, st.total)} of {st.total}{st.current ? <>: <b>{st.current}</b></> : null}</p>
          <p className="tnr-muted">{st.written} notes written · {st.failed} failed · ~{Math.round(st.cents * 10) / 10}¢ so far{st.stop ? ' · stopping after this event…' : ''}<AiInfo request={st.ai_request} /></p>
          <div className="tnr-foot"><button className="adm-btn" onClick={stop} disabled={st.stop}>Stop</button><button className="adm-btn adm-btn-ghost" onClick={() => setOpen(false)}>Close</button></div>
        </> : <>
          {st.finishedAt && <p className="tnr-done">Last run: {st.done} of {st.total} events, {st.written} notes, {st.failed} failed, ~{st.cents}¢.<AiInfo request={st.ai_request} /></p>}
          {st.errors?.length > 0 && <ul className="tnr-errors">{st.errors.map((e, i) => <li key={i}><b>{e.event}</b>: {e.error}</li>)}</ul>}
          <p>{st.pending ? <>{st.pending} of {st.all} events not refreshed yet ({est(st.pending)}).</> : <>All {st.all} events have been refreshed.</>}</p>
          {err && <p className="tnr-err">{err}</p>}
          <div className="tnr-foot">
            {st.pending > 0 && <button className="adm-btn adm-btn-primary" onClick={() => start(false)}>Refresh {st.pending} event{st.pending === 1 ? '' : 's'}</button>}
            <button className="adm-btn" onClick={() => start(true)} title="Every event, including ones already refreshed">All events again ({est(st.all)})</button>
            <button className="adm-btn adm-btn-ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
        </>}
      </div>
    </Modal>}
    <style>{`
      .tnr-box { gap: 0 !important; }
      .tnr-box p { margin: 8px 0; font-size: 14px; line-height: 1.45; }
      .tnr-muted { color: var(--text-muted, #999); font-size: 13px !important; }
      .tnr-done { color: #4caa60; }
      .tnr-err { color: #e07070; }
      .tnr-errors { max-height: 120px; overflow-y: auto; font-size: 12px; color: #d9a441; padding-left: 18px; }
      .tnr-bar { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; margin: 10px 0; }
      .tnr-bar span { display: block; height: 100%; background: var(--td-yellow); transition: width .3s; }
      .tnr-foot { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    `}</style>
  </>;
}
