import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import '../missingCover.css';

// ─── A missing issue: get it, or ask the admin (2026-10-28) ───────────────────
// One box for every place a missing issue shows: reading lists, Timeline events,
// Top Shelf runs, series pages. `base` is the issue's request address:
//   /api/reading-lists/:list/issues/:issue          (lists, with their visibility rules)
//   /api/requests/:event|run|series/:owner/issues/:issue
// GET {base}/acquire → { mode: download|request, plan, monitored, search, request }
// POST {base}/request (users who may not download).
// Users who may download (plan): owned | monitored (Mark wanted) | fill (Get it
// into the series' library folder) | add (Add Series in the Download Manager).
const DL_STATUS = { wanted: 'wanted', processed: 'downloaded', downloaded: 'downloaded', skipped: 'skipped', failed: 'failed', snatched: 'downloading' };

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export default function AcquireBox({ base, issue, onChange }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true; setInfo(null); setError('');
    call('GET', `${base}/acquire`).then(d => { if (live) setInfo(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [base]);
  const run = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } setBusy(false); };
  const update = next => { setInfo(next); onChange?.(next); };

  if (error && !info) return <div className="rl-acquire"><span className="a-err">{error}</span></div>;
  if (!info) return <div className="rl-acquire"><span>Checking…</span></div>;
  const openAdd = () => navigate(`/downloads?search=${encodeURIComponent(info.search || issue?.series_name || '')}`);
  const plan = info.plan || (info.monitored ? { state: 'monitored', ...info.monitored } : { state: 'add' });
  let body;
  if (info.mode === 'download') {
    if (plan.state === 'owned') body = <span>This issue is in the library.</span>;
    else if (plan.state === 'monitored' && ['skipped', 'failed'].includes(plan.status)) {
      body = <>
        <span>{plan.series_name || 'This series'} is in the Download Manager, but this issue is {plan.status}.</span>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => {
          await call('POST', `/api/monitor/series/${plan.series_id}/bulk-status`, { issueIds: [plan.issue_id], status: 'wanted' });
          update({ ...info, plan: { ...plan, status: 'wanted' } });
        })}>Mark wanted</button>
      </>;
    } else if (plan.state === 'monitored') {
      body = <>
        <span>{plan.series_name || 'This series'} is in the Download Manager; this issue is {DL_STATUS[plan.status] || plan.status}.</span>
        <button className="btn btn-ghost" onClick={() => navigate('/downloads')}>Open Download Manager</button>
      </>;
    } else if (plan.state === 'fill') {
      body = <>
        <span>Your library has {plan.folder || 'this series'}; get this issue into that folder.</span>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => {
          await call('POST', `/api/series/${plan.scanned_id}/gaps/get`, { issueIds: [String(plan.cv_issue_id)] });
          update({ ...info, plan: { state: 'monitored', series_name: plan.series_name, status: 'wanted' } });
        })}>⬇ Get this issue</button>
      </>;
    } else {
      body = <>
        <span>This series is not in the Download Manager.</span>
        <button className="btn btn-primary" onClick={openAdd}>Add in Download Manager</button>
      </>;
    }
  } else {
    const r = info.request;
    const ask = () => run(async () => { const d = await call('POST', `${base}/request`); update({ ...info, request: d }); });
    if (r?.owned) body = <span>This issue is now in the library.</span>;
    else if (r?.status === 'open') body = <><span>You asked the admin for this issue.</span><button className="btn btn-ghost" disabled>✓ Requested</button></>;
    else if (r?.status === 'added') body = <span>The admin added this to downloads. It will appear when it arrives.</span>;
    else if (r?.status === 'dismissed') body = <><span>The admin declined your request.</span><button className="btn btn-ghost" disabled={busy} onClick={ask}>Request again</button></>;
    else body = <><span>Ask the admin to download this issue.</span><button className="btn btn-primary" disabled={busy} onClick={ask}>✉ Request from admin</button></>;
  }
  return (
    <div className="rl-acquire">
      {body}
      {error && <span className="a-err">{error}</span>}
    </div>
  );
}

// The box in a small dialog, for shelves (runs, lists, events).
export function AcquireDialog({ base, issue, title, onClose, onChange }) {
  return (
    <Modal title={title || `${issue?.series_name || 'Issue'} #${issue?.issue_number ?? '?'}`} onClose={onClose} width={520}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <div className="rl-modal-body">
        <AcquireBox base={base} issue={issue} onChange={onChange} />
      </div>
    </Modal>
  );
}
