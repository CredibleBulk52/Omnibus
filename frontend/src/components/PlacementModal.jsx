import React, { useState } from 'react';
import Modal from './Modal';
import '../readingLists.css';

// ─── Read after… (2026-11-21, claude/SERIES_READING_ORDER.md) ─────────────────────────────────
// An admin's pin for where an annual, special or linked mini goes in a series' Issues grid, for
// every reader. regular: the run's issues in order [{ id, number }]; current: the issue it follows
// now (a book id, or 'first' for before the first issue).
export default function PlacementModal({ label, regular, current, onSave, onClose }) {
  const [pick, setPick] = useState(current || regular[regular.length - 1]?.id || 'first');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave(pick === 'first' ? { mode: 'first' } : { mode: 'after', anchorBookId: pick }); onClose(); }
    catch (e) { setError(e.message || 'That did not work. Try again.'); }
    setBusy(false);
  };
  const first = regular[0]?.number;
  return (
    <Modal title={`Place ${label}`} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !regular.length}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="rl-modal-sub">Where this book goes in the series' Issues, for everyone. Next and Previous follow it.</div>
      <div className="rl-modal-body">
        <label className="rl-field">
          <span className="rl-label">Read after</span>
          <select value={pick} onChange={e => setPick(e.target.value)} autoFocus>
            <option value="first">{first ? `Before #${first} (read first)` : 'Read first'}</option>
            {regular.map(r => <option key={r.id} value={r.id}>#{r.number}</option>)}
          </select>
        </label>
        {error && <div className="rl-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}
