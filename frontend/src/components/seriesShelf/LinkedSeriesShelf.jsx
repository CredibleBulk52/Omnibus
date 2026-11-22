import React, { useState } from 'react';
import PlacementModal from '../PlacementModal';
import { useNavigate } from 'react-router-dom';
import { useSeriesCache, isAdmin } from '../../App';
import { ROLE_LABEL, call } from './api';
import './seriesShelf.css';

// The linked series on a home's Specials tab.
export function LinkedSeriesShelf({ homeId, members, onChanged, regular, onPlaced }) {
  const navigate = useNavigate();
  const [placing, setPlacing] = useState(null);
  const { invalidate } = useSeriesCache();
  if (!members?.length) return null;
  const remove = async m => {
    try { await call('DELETE', `/api/series/${encodeURIComponent(m.id)}/shelf/${encodeURIComponent(homeId)}`); invalidate(null); onChanged?.(); } catch {}
  };
  return (
    <div className="linked-shelf">
      <div className="linked-shelf-head">Series on this shelf · {members.length}</div>
      <div className="linked-shelf-grid">
        {members.map(m => (
          <div key={m.id} className="linked-shelf-card">
            <button type="button" className="linked-shelf-open" onClick={() => navigate(`/series/${encodeURIComponent(m.id)}`)} title={m.reason || ''}>
              <img src={`/api/series/${encodeURIComponent(m.id)}/thumbnail`} alt="" loading="lazy" onError={e => { e.target.style.visibility = 'hidden'; }} />
              <span className="linked-shelf-name">{m.name}{m.year ? ` (${m.year})` : ''}</span>
              <span className="linked-shelf-meta">{ROLE_LABEL[m.role] || m.role} · {m.issues} issue{m.issues === 1 ? '' : 's'}{m.hidden ? '' : ' · also in the browser'}</span>
            </button>
            {isAdmin() && regular?.length > 0 && <button type="button" className="linked-shelf-remove" onClick={() => setPlacing(m)}>Place in reading order</button>}
            {isAdmin() && <button type="button" className="linked-shelf-remove" onClick={() => remove(m)} title="Take it off this shelf">Remove</button>}
          </div>
        ))}
      </div>
      {placing && <PlacementModal label={placing.name} regular={regular} onClose={() => setPlacing(null)}
        description="Place all owned issues together in series order. This replaces their individual placements in this reading order."
        onSave={async pin => {
          await call('PUT', `/api/series/${encodeURIComponent(homeId)}/placement/linked/${encodeURIComponent(placing.id)}`, pin);
          await onPlaced?.();
        }} />}
    </div>
  );
}
