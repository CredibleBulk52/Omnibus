import { useConfirm } from './Confirm';
import React, { useState } from 'react';

// Select mode for a series shelf (series library, comic boxes): a Select
// toggle, a shift+click hint, and Mark read / Mark unread for every issue,
// special and annual in the selected series. ShelfView itself adds the
// "N selected · Add to Collection · Clear" controls.
export default function SeriesSelectControls({ selectable, setSelectable, selected, setSelected }) {
  const confirm = useConfirm();
  const [marking, setMarking] = useState(false);
  const [note, setNote] = useState('');

  const mark = async completed => {
    if (!selected.length) return;
    const verb = completed ? 'read' : 'unread';
    if (!(await confirm({ title: `Mark as ${verb}?`, message: `Mark every issue, special and annual in ${selected.length} series as ${verb}?`, confirmLabel: `Mark ${verb}` }))) return;
    setMarking(true); setNote('');
    try {
      const r = await fetch('/api/series/batch/mark-read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesIds: selected, completed }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      setNote(`Marked ${d.count} book${d.count === 1 ? '' : 's'} as ${verb}.`);
      setSelected([]);
    } catch (e) { setNote(`Could not mark ${verb}: ${e.message}`); }
    finally { setMarking(false); }
  };

  return <>
    {selectable && selected.length > 0 && (<>
      <button className="btn btn-secondary" disabled={marking} onClick={() => mark(true)}
        title="Every issue, special and annual in the selected series">✓ Mark read</button>
      <button className="btn btn-ghost" disabled={marking} onClick={() => mark(false)}>Mark unread</button>
    </>)}
    {selectable && !selected.length && <span className="form-hint" style={{ margin: 0 }}>Shift+click to select a range</span>}
    {note && <span className="form-hint" style={{ margin: 0 }}>{note}</span>}
    <button className={`btn ${selectable ? 'btn-secondary' : 'btn-ghost'}`}
      onClick={() => { setSelectable(!selectable); setSelected([]); setNote(''); }}>
      {selectable ? '✕ Cancel' : '☐ Select'}
    </button>
  </>;
}
