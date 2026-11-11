import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MissingAction } from './MissingCover';
import RequestSeriesDialog from './RequestSeries';
import '../missingCover.css';
import '../boxMissing.css';

// ─── Series a box recommends that the library lacks (2026-11-04) ─────────────
// Placeholders saved with a box Comic Book Guy built (backend/boxMissing.js): dashed
// tiles with the Comic Vine cover once found, his reason, and ⬇ Add (users who may
// download: the Download Manager search) or ✉ Request (the admin). When the library
// gets the series it moves into the box by itself.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();

export default function BoxMissingSeries({ boxId, boxName, canEdit, canDownload, onArrived }) {
  const [rows, setRows] = useState(null);
  const [requested, setRequested] = useState(new Set());
  const [asking, setAsking] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/collections/${encodeURIComponent(boxId)}/missing`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load the missing series.');
      setRows(prev => { if (prev && d.missing.length < prev.length) onArrived?.(); return d.missing; });
    } catch (e) { setError(e.message); setRows(prev => prev || []); }
  }, [boxId, onArrived]);
  const loadRequests = useCallback(async () => {
    if (canDownload) return;
    try {
      const d = await (await fetch('/api/requests/mine')).json();
      setRequested(new Set((d.requests || []).filter(x => x.kind === 'series' && x.status === 'open').map(x => `${norm(x.series_name)}|${x.volume_year || ''}`)));
    } catch { /* the buttons still work */ }
  }, [canDownload]);
  useEffect(() => { setRows(null); load(); loadRequests(); }, [load, loadRequests]);
  // Comic Vine lookups run in the background: check back while some are pending.
  const pending = rows?.some(r => !r.looked_up);
  useEffect(() => {
    if (!pending) return undefined;
    const t = setTimeout(load, 8000);
    return () => clearTimeout(t);
  }, [pending, rows, load]);

  const remove = async row => {
    setError('');
    const r = await fetch(`/api/collections/${encodeURIComponent(boxId)}/missing/${row.id}`, { method: 'DELETE' });
    if (r.ok) setRows(rs => rs.filter(x => x.id !== row.id)); else setError('Could not remove it.');
  };

  if (!rows?.length) return error ? <p role="alert" className="box-missing-error">{error}</p> : null;
  return (
    <section className="box-missing" aria-label="Not in Omnibus yet">
      <h2>Not in Omnibus yet <span>({rows.length})</span></h2>
      <p className="box-missing-intro">{canDownload ? 'Recommended for this box. Add one in Downloads and it moves into the box.' : 'Recommended for this box. Request one and it moves into the box once it arrives.'}</p>
      <div className="box-missing-grid">
        {rows.map(r => {
          const isRequested = requested.has(`${norm(r.name)}|${r.start_year || ''}`);
          const sub = [r.start_year, r.publisher, r.issue_count ? `${r.issue_count} issues` : null].filter(Boolean).join(' · ');
          return (
            <div key={r.id} className="box-missing-card">
              <div className="missing-cover box-missing-cover">
                {r.image_url && <img src={r.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.target.style.display = 'none'; }} />}
                <b className="box-missing-title">{r.name}</b>
                {sub && <span className="missing-cover-sub">{sub}</span>}
                <span className={`missing-cover-state missing-cover-state--${isRequested ? 'requested' : 'missing'}`}>
                  {isRequested ? 'Requested' : r.looked_up ? 'Not in library' : 'Looking it up…'}
                </span>
                {canDownload
                  ? <Link className="missing-cover-action" to={`/downloads?search=${encodeURIComponent(r.cv_name || r.name)}`}>⬇ Add</Link>
                  : !isRequested && <MissingAction onClick={() => setAsking(r)}>✉ Request</MissingAction>}
              </div>
              {r.reason && <p className="box-missing-reason">{r.reason}</p>}
              <div className="box-missing-links">
                {r.cv_volume_id && <a href={`https://comicvine.gamespot.com/volume/4050-${r.cv_volume_id}/`} target="_blank" rel="noopener noreferrer">Comic Vine ↗</a>}
                {canEdit && <button type="button" onClick={() => remove(r)} title="Remove from this box">Remove</button>}
              </div>
            </div>
          );
        })}
      </div>
      {error && <p role="alert" className="box-missing-error">{error}</p>}
      {asking && <RequestSeriesDialog initialName={asking.cv_name || asking.name} initialYear={asking.start_year || ''} initialPublisher={asking.publisher || ''}
        initialNote={`For the box "${boxName}".${asking.reason ? ` ${asking.reason}` : ''}`.slice(0, 1000)}
        onClose={() => setAsking(null)} onSent={loadRequests} />}
    </section>
  );
}
