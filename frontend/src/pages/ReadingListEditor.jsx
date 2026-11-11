// ─── Curated-list editor page ─────────────────────────────────────
// Route wrapper for the shared editor (components/listEditor). One page for
// reading lists and Essentials (kind "list"), Timeline events ("event") and
// Top Shelf runs ("run"); the adapter says how each loads and saves.
// claude/ADMIN_REORG.md step 3. Back goes to the page the editor was opened from.
import React from 'react';
import { useParams, useLocation } from 'react-router-dom';
import ListEditor from '../components/listEditor/ListEditor';
import { ADAPTERS } from '../components/listEditor/adapters';

export default function ReadingListEditor({ kind = 'list' }) {
  const { id } = useParams();
  const location = useLocation();
  const backTo = location.pathname.replace(/\/edit\/?$/, '');
  return <ListEditor key={`${kind}-${id}`} adapter={ADAPTERS[kind]} id={id} backTo={backTo} />;
}
