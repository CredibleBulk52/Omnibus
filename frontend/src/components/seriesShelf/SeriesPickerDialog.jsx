import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../Modal';
import { useSeriesCache } from '../../App';
import { call } from './api';
import './seriesShelf.css';

// Admin: pick a series from the library (search by title).
export function SeriesPickerDialog({ title, intro, excludeId = null, onPick, onClose }) {
  const { fetchSeries } = useSeriesCache();
  const [all, setAll] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { fetchSeries(null).then(d => setAll(d || [])).catch(() => {}); }, [fetchSeries]);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return all.filter(s => s.id !== excludeId && String(s.displayTitle || s.name || '').toLowerCase().includes(t)).slice(0, 30);
  }, [all, q, excludeId]);
  const pick = async s => {
    setBusy(s.id); setError('');
    try { await onPick(s); onClose(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  return (
    <Modal title={title} onClose={onClose} width={520} closeOnBackdrop={false}>
      {intro && <p className="a-muted a-fs-13" style={{ marginTop: 0 }}>{intro}</p>}
      <input className="input" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search your series…" style={{ width: '100%' }} />
      {error && <p className="a-fs-13" style={{ color: 'var(--td-red, #e55)' }}>{error}</p>}
      <div className="put-shelf-results">
        {hits.map(s => (
          <button key={s.id} type="button" className="put-shelf-hit" disabled={!!busy} onClick={() => pick(s)}>
            <span>{s.displayTitle || s.name}{s.displayYear && !String(s.displayTitle || '').includes(`(${s.displayYear})`) ? ` (${s.displayYear})` : ''}</span>
            <small>{s.book_count || 0} issues{busy === s.id ? ' · saving…' : ''}</small>
          </button>
        ))}
        {q.trim().length >= 2 && !hits.length && <p className="a-muted a-fs-13">No series match.</p>}
      </div>
    </Modal>
  );
}

// Admin: put this series on another series' Specials shelf.
export function PutOnShelfDialog({ seriesId, seriesName, onClose, onDone }) {
  const { invalidate } = useSeriesCache();
  return <SeriesPickerDialog title="Put on a Specials shelf" excludeId={seriesId} onClose={onClose}
    intro={<>Choose the series whose Specials tab {seriesName ? <b>{seriesName}</b> : 'this series'} belongs on. It then leaves the series browser (the "On a Specials shelf" filter still shows it). Nothing on disk changes.</>}
    onPick={async s => { await call('POST', `/api/series/${encodeURIComponent(seriesId)}/shelf`, { homeId: s.id }); invalidate(null); onDone?.(); }} />;
}
