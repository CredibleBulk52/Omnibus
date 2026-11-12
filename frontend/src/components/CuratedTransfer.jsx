import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Export and import of curated reading orders (2026-11-12) ─────
// Essentials, Timeline events and Top Shelf runs travel between Omnibus installs as small JSON
// files (backend/curatedTransfer.js). Export downloads one from Manage ⌄; Import, in the admin bar
// of each curated page, reads one and opens the result in the editor as a draft.

export async function exportCurated(kind, id) {
  const r = await fetch(`/api/curated/${kind}/${encodeURIComponent(id)}/export`);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `Export failed (${r.status})`);
  }
  const blob = await r.blob();
  const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || `omnibus-${kind}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A Manage ⌄ menu item: ⇩ Export. Reports a failure in place of the label.
export function ExportMenuItem({ kind, id, onDone }) {
  const [state, setState] = useState(null);
  const run = async () => {
    setState('busy');
    try { await exportCurated(kind, id); setState(null); onDone && onDone(); }
    catch (e) { setState(e.message); }
  };
  return <button onClick={run} disabled={state === 'busy'} title="Save this reading order as a file another Omnibus install can import (no comics or covers)">
    {state === 'busy' ? 'Exporting…' : state ? `Export failed: ${state}` : '⇩ Export'}</button>;
}

// Admin bar button: ⇧ Import. Reads an Omnibus export file and opens the draft in the editor.
export function ImportButton() {
  const input = useRef(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    if (file.size > 5 * 1024 * 1024) { setError('That file is too large to be an Omnibus export.'); return; }
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { setError('That file is not an Omnibus export (it is not JSON).'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/curated/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Import failed (${r.status})`);
      navigate(d.editUrl, { state: { imported: d.summary || null } });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="admin-bar-btn" onClick={() => input.current && input.current.click()} disabled={busy}
      title="Import an Essential, Timeline event or Top Shelf run exported from Omnibus. It opens in the editor as a draft that readers cannot see until you publish it.">
      {busy ? 'Importing…' : '⇧ Import'}</button>
    <input ref={input} type="file" accept=".json,application/json" hidden onChange={pick} />
    {error && <span className="admin-bar-error" role="alert">{error}</span>}
  </>;
}
