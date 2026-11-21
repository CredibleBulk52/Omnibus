import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import CoverMenu from './CoverMenu';
import AddToListModal from './AddToListModal';
import PlacementModal from './PlacementModal';

// ─── ⋮ on an issue cover (series pages, reading orders, Timeline events, Top Shelf
// runs; 2026-11-04) ───────────────────────────────────────────────────────────
// Mark this issue as read or unread, and add it to a reading order. read: whether the
// reader has finished it (the page already knows). onChanged(completed): the page
// updates its own shelf.
// placement (admins, series pages; 2026-11-21, claude/SERIES_READING_ORDER.md): where an annual,
// special or linked mini goes in the series' Issues, for everyone — { status, pinned, regular,
// current, onSet(body | null) }; body { mode: 'after', anchorBookId } | { mode: 'first' } |
// { mode: 'shelf' }; null goes back to automatic placement.
export default function IssueCardMenu({ bookId, label, read = false, onChanged, placement = null }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [placing, setPlacing] = useState(false);
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
  const place = async (body, close) => {
    setBusy(true); setNote('');
    try { await placement.onSet(body); close(); } catch (e) { setNote(e.message || 'That did not work. Try again.'); }
    setBusy(false);
  };
  return <>
    <CoverMenu label={`More for ${label}`} heading={label} className="scm-toggle--issue" onOpen={() => setNote('')}>
      {close => <>
        {read
          ? <button role="menuitem" disabled={busy} onClick={() => mark(false, close)}>↺ Mark as unread</button>
          : <button role="menuitem" disabled={busy} onClick={() => mark(true, close)}>✓ Mark as read</button>}
        <button role="menuitem" onClick={() => { close(); setAdding(true); }}>+ Add to a reading order</button>
        {placement && <>
          {placement.status && <div className="scm-wait">{placement.status}</div>}
          <button role="menuitem" disabled={busy} onClick={() => { close(); setPlacing(true); }}>↳ Read after…</button>
          {placement.mode !== 'shelf' && <button role="menuitem" disabled={busy} onClick={() => place({ mode: 'shelf' }, close)}>▭ Show on shelf only</button>}
          {placement.pinned && <button role="menuitem" disabled={busy} onClick={() => place(null, close)}>⟲ Automatic placement</button>}
        </>}
        {note && <div className="scm-note" role="alert">{note}</div>}
      </>}
    </CoverMenu>
    {adding && createPortal(<AddToListModal target={{ kind: 'book', bookId, label }} onClose={() => setAdding(false)} />, document.body)}
    {placing && createPortal(<PlacementModal label={label} regular={placement.regular} current={placement.current}
      onSave={placement.onSet} onClose={() => setPlacing(false)} />, document.body)}
  </>;
}
