// ─── Timeline event strip on an issue cover (2026-11-19) ─────────────
// A slim band across the bottom of the cover naming the Timeline event the issue belongs to; the
// event where it matters most comes first (backend/eventMarkers.js). "+N" reveals the others.
// Hover shows the issue's role in the event; a click opens the event at this issue
// (EventDetail ?book=). claude/SERIES_READING_ORDER.md: event markers.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../eventStrip.css';

const ROLE = { essential: 'essential', recommended: 'recommended', 'tie-in': 'tie-in', aftermath: 'aftermath' };

export default function EventStrip({ bookId, events, hidden = false }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (hidden || !Array.isArray(events) || !events.length) return null;
  const shown = open ? events : events.slice(0, 1);
  const role = e => (ROLE[e.tier] ? ` · ${ROLE[e.tier]}` : '');
  const others = events.slice(1).map(e => e.name).join(', ');
  return (
    <div className={`issue-event-strip${open ? ' is-open' : ''}`} onClick={e => e.stopPropagation()}>
      {shown.map((e, i) => (
        <div className="ies-row" key={e.id}>
          <button type="button" className="ies-link" title={`${e.name}${role(e)} — open in the Timeline`}
            onClick={() => navigate(`/events/${encodeURIComponent(e.id)}?book=${encodeURIComponent(bookId)}`)}>
            <span className="ies-mark" aria-hidden="true">◆</span>
            <span className="ies-name">{e.name}</span>
          </button>
          {i === 0 && events.length > 1 && (
            <button type="button" className="ies-more" aria-expanded={open}
              title={open ? 'Show one event' : `Also in ${others}`}
              aria-label={open ? 'Show one event' : `Also in ${others}`}
              onClick={() => setOpen(o => !o)}>
              {open ? '−' : `+${events.length - 1}`}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
