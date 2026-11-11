import React from 'react';
import '../missingCover.css';

// ─── An issue that is not in the library (2026-10-28) ─────────────────────────
// One placeholder everywhere a missing issue sits on a shelf: series pages,
// reading lists, Timeline events, Top Shelf runs. Dashed frame, the issue
// number, a state line and an optional action (⬇ Get / ✉ Request / ⚲ Find).
// image: a Comic Vine cover thumbnail when known (shown dark and grey).
// tone: missing | wanted | requested (colours the state line).
export default function MissingCover({ number, label = 'Not in library', tone = 'missing', image = null, sub = null, actions = null }) {
  return (
    <div className="missing-cover">
      {image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.target.style.display = 'none'; }} />}
      <b>#{number ?? '?'}</b>
      {sub && <span className="missing-cover-sub">{sub}</span>}
      <span className={`missing-cover-state missing-cover-state--${tone}`}>{label}</span>
      {actions}
    </div>
  );
}

// The action button style used on the placeholder.
export function MissingAction({ onClick, disabled, children, title }) {
  return <button type="button" className="missing-cover-action" disabled={disabled} title={title}
    onClick={e => { e.stopPropagation(); onClick(); }}>{children}</button>;
}

// The state line for a request status (shared by every page).
export const REQUEST_LABEL = { open: 'Requested', added: 'Request accepted', dismissed: 'Request declined' };
