import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { ErrorNote } from './StateMessage';
import '../requestsReports.css';

// ─── Request a series (2026-10-28) ──────────────────────────────────────────
// For users who may not download: ask the admin for a series that is not in the
// library. Users who may download add it themselves in the Download Manager.
export default function RequestSeriesDialog({ initialName = '', initialYear = '', initialPublisher = '', initialNote = '', onClose, onSent }) {
  const [form, setForm] = useState({ name: initialName, year: initialYear ? String(initialYear) : '', publisher: initialPublisher || '', note: initialNote || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/requests/series', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not send the request');
      setDone(true); onSent?.();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const footer = done
    ? <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
    : <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !form.name.trim()}>{busy ? 'Sending…' : 'Send request'}</button>
      </>;
  return (
    <Modal title="✉ Request a series" onClose={onClose} closeOnBackdrop={false} width={520} footer={footer}>
      <div className="rl-modal-body rr-dialog">
        {done ? (
          <p className="rr-done">Sent. The admin will see your request; follow it on <Link to="/my-requests" onClick={onClose}>My requests</Link>.</p>
        ) : (
          <>
            <label className="rr-field">
              <span className="rr-label">Series</span>
              <input className="rr-input" autoFocus value={form.name} onChange={set('name')} placeholder="e.g. Saga" maxLength={200} />
            </label>
            <div className="rr-row">
              <label className="rr-field">
                <span className="rr-label">Started (year)</span>
                <input className="rr-input" inputMode="numeric" value={form.year} onChange={set('year')} placeholder="optional" maxLength={4} />
              </label>
              <label className="rr-field">
                <span className="rr-label">Publisher</span>
                <input className="rr-input" value={form.publisher} onChange={set('publisher')} placeholder="optional" maxLength={100} />
              </label>
            </div>
            <label className="rr-field">
              <span className="rr-label">Note</span>
              <textarea className="rr-input" rows={3} value={form.note} onChange={set('note')} maxLength={1000}
                placeholder="Which run, or why (optional)" />
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
          </>
        )}
      </div>
    </Modal>
  );
}
