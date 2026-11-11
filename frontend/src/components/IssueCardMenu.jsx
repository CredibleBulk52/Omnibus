import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import CoverMenu from './CoverMenu';
import AddToListModal from './AddToListModal';

// ─── ⋮ on an issue cover (series pages, reading orders, Timeline events, Top Shelf
// runs; 2026-11-04) ───────────────────────────────────────────────────────────
// Mark this issue as read or unread, and add it to a reading order. read: whether the
// reader has finished it (the page already knows). onChanged(completed): the page
// updates its own shelf.
export default function IssueCardMenu({ bookId, label, read = false, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const mark = async (completed, close) => {
    setBusy(true); setNote('');
    try {
      const r = await fetch('/api/books/batch/mark-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookIds: [bookId], completed }) });
      if (!r.ok) throw new Error('The update failed. Please try again.');
      close();
      onChanged?.(completed);
    } catch (e) { setNote(e.message); }
    setBusy(false);
  };
  return <>
    <CoverMenu label={`More for ${label}`} heading={label} className="scm-toggle--issue" onOpen={() => setNote('')}>
      {close => <>
        {read
          ? <button role="menuitem" disabled={busy} onClick={() => mark(false, close)}>↺ Mark as unread</button>
          : <button role="menuitem" disabled={busy} onClick={() => mark(true, close)}>✓ Mark as read</button>}
        <button role="menuitem" onClick={() => { close(); setAdding(true); }}>+ Add to a reading order</button>
        {note && <div className="scm-note" role="alert">{note}</div>}
      </>}
    </CoverMenu>
    {adding && createPortal(<AddToListModal target={{ kind: 'book', bookId, label }} onClose={() => setAdding(false)} />, document.body)}
  </>;
}
