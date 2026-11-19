// ─── Specials shelf: series grouped under a home (2026-11-13) ─────
// backend/seriesGrouping.js. A series on another's shelf is listed on that series' Specials tab
// (beside the special issues in its own folder); a tie-in is also kept out of the series browser.
// Admins put a series on a shelf by hand, or take it off (a rule's link then stays off).
// Split out of components/SeriesShelf.jsx (2026-11-14): this folder holds the series-page pieces;
// the Library › Specials shelves panel is in components/specialsShelves/.
import { useCallback, useEffect, useRef, useState } from 'react';

export const ROLE_LABEL = { 'tie-in': 'Tie-in', core: 'Main story', prelude: 'Lead-in', epilogue: 'Aftermath', initiative: 'Initiative', special: 'Special' };

export const enc = encodeURIComponent;

const NO_GROUPING = { homes: [], members: [], keepVisible: false };

// The series' shelf homes and members. Another series opened on the same page starts empty, and an
// answer for a series no longer shown is dropped (2026-11-19).
export function useSeriesGrouping(id) {
  const [state, setState] = useState({ id, data: NO_GROUPING });
  const current = useRef(id);
  current.current = id;
  const load = useCallback(() => fetch(`/api/series/${encodeURIComponent(id)}/grouping`).then(r => r.ok ? r.json() : null)
    .then(d => { if (d && current.current === id) setState({ id, data: d }); }).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);
  return [state.id === id ? state.data : NO_GROUPING, load];
}

export async function call(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
