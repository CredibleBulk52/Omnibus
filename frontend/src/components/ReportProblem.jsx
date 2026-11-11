import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { ErrorNote } from './StateMessage';
import '../requestsReports.css';

// ─── Report a problem (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ────────────
// Any user can tell the admin about a problem. Call reportProblem(target) from
// anywhere; <ReportProblemHost/> (mounted in the app shell and the reader)
// shows the dialog. target: { type: book|series|event|run|list|page, id, label,
// kinds: which kinds to offer (default all) }. The report lands in the admin's
// Problem reports page (account menu, /admin/reports); the user follows it on My requests.
export const REPORT_KINDS = [
  { id: 'file', label: 'Problem with the file', hint: 'Bad scan, missing or out-of-order pages, or it will not open' },
  { id: 'metadata', label: 'Wrong information', hint: 'Wrong title, issue number, cover, date or series' },
  { id: 'order', label: 'Reading order problem', hint: 'Wrong order, or a wrong or missing issue' },
  { id: 'other', label: 'Something else', hint: 'Anything else: describe it below' },
];
const EVENT = 'omnibus:report-problem';
export function reportProblem(target = {}) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: target }));
}

export function ReportProblemHost() {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    const open = e => setTarget({ type: 'page', ...(e.detail || {}) });
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);
  if (!target) return null;
  return <ReportProblemDialog target={target} onClose={() => setTarget(null)} />;
}

function ReportProblemDialog({ target, onClose }) {
  const kinds = REPORT_KINDS.filter(k => !target.kinds || target.kinds.includes(k.id));
  const [kind, setKind] = useState(kinds.length === 1 ? kinds[0].id : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const needsNote = kind === 'other';
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, target_type: target.type || 'page', target_id: target.id != null ? String(target.id) : null,
          target_label: target.label || null, page_url: window.location.pathname + window.location.search, note }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not send the report');
      setDone(true);
      window.dispatchEvent(new Event('omnibus:report-sent'));
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const footer = done
    ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
    : <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !kind || (needsNote && !note.trim())}>
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </>;
  return (
    <Modal title="⚑ Report a problem" onClose={onClose} closeOnBackdrop={!note.trim()} width={520} footer={footer}>
      <div className="rl-modal-body rr-dialog">
        {target.label && <div className="rr-about">About: <strong>{target.label}</strong></div>}
        {done ? (
          <p className="rr-done">Thanks, the admin has your report. You can follow it on <Link to="/my-requests" onClick={onClose}>My requests</Link>.</p>
        ) : (
          <>
            <fieldset className="rr-kinds">
              <legend className="rr-label">What is wrong?</legend>
              {kinds.map(k => (
                <label key={k.id} className={`rr-kind${kind === k.id ? ' on' : ''}`}>
                  <input type="radio" name="report-kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
                  <span><b>{k.label}</b><small>{k.hint}</small></span>
                </label>
              ))}
            </fieldset>
            <label className="rr-field">
              <span className="rr-label">{needsNote ? 'Describe the problem' : 'Details (optional)'}</span>
              <textarea className="rr-input" rows={4} maxLength={2000} value={note} onChange={e => setNote(e.target.value)}
                placeholder={kind === 'file' ? 'e.g. pages 12 and 13 are missing' : kind === 'order' ? 'e.g. #5 should come before the tie-in' : ''} />
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    </Modal>
  );
}

// A small button that opens the dialog for a target.
export function ReportButton({ target, className = 'rr-report-btn', children = '⚑ Report a problem' }) {
  return <button type="button" className={className} onClick={() => reportProblem(target)}>{children}</button>;
}
