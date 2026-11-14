import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSeriesCache, isAdmin } from '../../App';
import { ROLE_LABEL, call } from './api';
import './seriesShelf.css';

// A band under the tab rail (2026-11-14): the home's cover, "On the Specials shelf of Flashpoint (2011)"
// and its role; admins get "Take it off" with Undo. It sits outside .series-body: the issues shelf
// there is pulled up over the body's padding and covered the old line (its ✕ could not be clicked).
export function ShelfHomes({ seriesId, homes, onChanged }) {
  const navigate = useNavigate();
  const { invalidate } = useSeriesCache();
  const [note, setNote] = useState(null);   // { text, run } after a change, or { error }
  useEffect(() => { if (!note) return undefined; const t = setTimeout(() => setNote(null), 10000); return () => clearTimeout(t); }, [note]);
  const done = () => { invalidate(null); onChanged?.(); };
  const remove = async h => {
    try {
      const r = await call('DELETE', `/api/series/${encodeURIComponent(seriesId)}/shelf/${encodeURIComponent(h.id)}`);
      done();
      setNote({ text: `Taken off ${h.name}'s shelf: back in the series list.`, run: () => (r?.source === 'manual'
        ? call('POST', `/api/series/${encodeURIComponent(seriesId)}/shelf`, { homeId: h.id })
        : call('POST', '/api/grouping/restore', { items: [{ seriesId, homeId: h.id }] })) });
    } catch (e) { setNote({ error: e.message }); }
  };
  const undo = async () => { const n = note; setNote(null); try { await n.run(); done(); } catch (e) { setNote({ error: e.message }); } };
  if (!homes?.length && !note) return null;
  const enc = encodeURIComponent;
  return (
    <div className="series-shelf-homes">
      {(homes || []).map(h => (
        <span key={h.id} className="series-shelf-home">
          <button type="button" className="series-shelf-home-link" onClick={() => navigate(`/series/${enc(h.id)}?tab=specials`)} title={`Open ${h.name}'s Specials tab`}>
            <img src={`/api/series/${enc(h.id)}/thumbnail`} alt="" loading="lazy" onError={e => { e.target.style.display = 'none'; }} />
            <span>On the Specials shelf of <b>{h.name}</b>{h.role && h.role !== 'special' ? <span className="series-shelf-role"> · {ROLE_LABEL[h.role] || h.role}</span> : null}</span>
          </button>
          {isAdmin() && <button type="button" className="series-shelf-off" title="Takes it off this shelf: it shows in the series list again. Undo is offered."
            onClick={() => remove(h)}>Take it off</button>}
        </span>))}
      {note && (note.error
        ? <span className="series-shelf-note series-shelf-error">{note.error}</span>
        : <span className="series-shelf-note">{note.text}{note.run && <> <button type="button" className="series-shelf-off" onClick={undo}>Undo</button></>}</span>)}
    </div>
  );
}
