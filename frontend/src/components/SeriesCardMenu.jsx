import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CoverMenu from './CoverMenu';
import AddToListModal from './AddToListModal';
import { useConfirm } from './Confirm';
import { markSeriesRead } from '../pages/seriesReading.mjs';

// ─── ⋮ on a series cover (Series browser, comic boxes, Search; 2026-11-04) ─────
// Mark as read / unread (whichever applies; both for a partly read series), Add to a
// box, and on your own hand-picked box Remove from this box. Shows on hover, always on
// touch screens.
export default function SeriesCardMenu({ series, title, onRemove = null, className = '' }) {
  const [state, setState] = useState(null);   // { read, unread } once the series' issues are checked
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const check = useRef(0);
  const confirm = useConfirm();

  // Which reading actions apply: one look at the series' issues, each time it opens.
  const onOpen = () => {
    const n = ++check.current;
    setState(null); setNote('');
    fetch(`/api/series/${encodeURIComponent(series.id)}/books?includeAll=true`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => {
        const books = Array.isArray(d.content) ? d.content : [];
        const done = books.filter(b => b.readProgress?.completed).length;
        if (n === check.current) setState({ read: done > 0, unread: done < books.length });
      })
      .catch(() => { if (n === check.current) setState({ read: true, unread: true }); });
  };
  const mark = async (completed, close) => {
    setBusy(true); setNote('');
    try { if ((await markSeriesRead(series.id, title, fetch, confirm, completed)) != null) close(); }
    catch (e) { setNote(e.message); }
    setBusy(false);
  };
  const remove = async close => {
    close();
    if (!(await confirm({ title: 'Remove from this box?', message: `Take "${title}" out of this box? The series stays in your library.`, confirmLabel: 'Remove' }))) return;
    onRemove(series);
  };

  return <>
    <CoverMenu label={`More for ${title}`} heading={title} onOpen={onOpen} className={className}>
      {close => <>
        {!state && <div className="scm-wait">Checking your reading…</div>}
        {state?.unread && <button role="menuitem" disabled={busy} onClick={() => mark(true, close)}>✓ Mark as read</button>}
        {state?.read && <button role="menuitem" disabled={busy} onClick={() => mark(false, close)}>↺ Mark as unread</button>}
        <button role="menuitem" onClick={() => { close(); setAdding(true); }}>+ Add to a box</button>
        {onRemove && <button role="menuitem" className="scm-danger" onClick={() => remove(close)}>Remove from this box</button>}
        {note && <div className="scm-note" role="alert">{note}</div>}
      </>}
    </CoverMenu>
    {/* On the page body: a card transformed on hover would trap a fixed dialog inside it. */}
    {adding && createPortal(<AddToListModal target={{ kind: 'series', seriesId: series.id, label: title }} withBoxes onClose={() => setAdding(false)} />, document.body)}
  </>;
}
