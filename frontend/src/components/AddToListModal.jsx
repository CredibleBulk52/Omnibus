// ─── AddToListModal ───────────────────────────────────────────────
// "Add to reading list" dialog, used from Series, Timeline, Top Shelf,
// the reader and issue popups.
//
// target (one of):
//   { kind: 'book',      bookId, label }               one owned issue
//   { kind: 'books',     bookIds: [...], label }       several owned issues (select mode)
//   { kind: 'series',    seriesId, label }             whole series or a run of issues
//   { kind: 'event',     refId, label }                Timeline event (linked)
//   { kind: 'canon_run', refId, label }                Top Shelf run (linked)
//
// "Add to a box" (2026-11-03, claude/BOXES_UNIFIED_PLAN.md stage 1): users see one action.
// Reading lists are shown as "reading orders". With withBoxes (a series), the user's
// hand-picked series boxes are offered too (admins also see the library's); a series box
// takes the series, a reading order takes its issues. Issues, events and runs only go in
// reading orders. My Pull Box has its own + Pull and is not listed.
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { rlApi, prefs, Modal, VISIBILITY_LABEL } from './ReadingListBits';
import { isAdmin, getUser } from '../App';

const KIND_SUB = {
  book: 'Add this issue to a reading order.',
  books: 'Add the selected issues to a reading order.',
  series: 'Add this series to a box.',
  event: 'Add this Timeline event to a reading order. It shows the essential issues (you can switch to all), and it stays linked, so updates to the event show up.',
  canon_run: 'Add this Top Shelf run to a reading order. It stays linked, so updates to the run show up.',
};
const isBoxPick = p => typeof p === 'string' && p.startsWith('box:');
const boxIdOf = p => p.slice(4);

// Series boxes the user may add a series to: hand-picked, not My Pull Box; their own,
// plus the library's for an admin (the server enforces the same rule).
export function addableSeriesBoxes(cols, { admin = false, userId = null } = {}) {
  return (Array.isArray(cols) ? cols : [])
    .filter(c => (c.collection_type || c.collectionType || 'manual') !== 'auto' && c.purpose !== 'pull' && (c.owner_id ? c.owner_id === userId : admin))
    .sort((a, b) => Number(!a.owner_id) - Number(!b.owner_id) || String(a.name).localeCompare(String(b.name)));
}

export default function AddToListModal({ target, onClose, withBoxes = false }) {
  const boxesToo = withBoxes && target.kind === 'series';
  const [boxes, setBoxes] = useState(boxesToo ? null : []);
  const navigate = useNavigate();
  const [lists, setLists] = useState(null);
  const [containing, setContaining] = useState(new Set());
  const [pick, setPick] = useState(null);           // list id or 'new'
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState('series');        // series | range (series target only)
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);            // { id, name, note }

  useEffect(() => {
    let alive = true;
    const boxesReady = boxesToo
      ? fetch('/api/collections').then(r => r.json()).then(cols => addableSeriesBoxes(cols, { admin: isAdmin(), userId: getUser()?.id })).catch(() => [])
      : Promise.resolve([]);
    Promise.all([rlApi('GET', '/api/reading-lists?scope=mine&lite=1&includeEssential=1'), boxesReady]).then(([d, bx]) => {
      if (!alive) return;
      const ls = d.lists || [];
      setLists(ls); setBoxes(bx);
      const lastBox = String(prefs.get('lastBox', ''));
      const last = Number(prefs.get('lastList', ''));
      setPick(boxesToo && bx.find(b => `box:${b.id}` === lastBox) ? lastBox
        : ls.find(l => l.id === last) ? last
        : boxesToo && bx[0] ? `box:${bx[0].id}` : (ls[0]?.id ?? 'new'));
    }).catch(e => alive && setError(e.message));
    if (target.kind === 'book') {
      rlApi('GET', `/api/reading-lists/containing/${encodeURIComponent(target.bookId)}`)
        .then(d => alive && setContaining(new Set((d.lists || []).map(l => l.id)))).catch(() => {});
    }
    return () => { alive = false; };
  }, [target, boxesToo]);

  const entriesFor = () => {
    switch (target.kind) {
      case 'book':      return [{ type: 'issue', bookId: target.bookId }];
      case 'books':     return target.bookIds.map(bookId => ({ type: 'issue', bookId }));
      case 'series':    return mode === 'range'
        ? [{ type: 'range', seriesId: target.seriesId, issueStart: start.trim() || undefined, issueEnd: end.trim() || undefined }]
        : [{ type: 'series', seriesId: target.seriesId }];
      case 'event':     return [{ type: 'event', refId: target.refId }];
      case 'canon_run': return [{ type: 'canon_run', refId: target.refId }];
      default:          return [];
    }
  };

  const addToSeriesBox = async () => {
    let boxId = pick === 'newbox' ? null : boxIdOf(pick), boxName = boxes.find(b => String(b.id) === String(boxId))?.name;
    if (pick === 'newbox') {
      const r = await fetch('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), personal: true, collectionType: 'manual', rules: [] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) throw new Error(d.error || 'Could not create the box.');
      boxId = d.id; boxName = newName.trim();
    }
    const r = await fetch(`/api/collections/${boxId}/series`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesId: target.seriesId }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not add it to the box.'); }
    prefs.set('lastBox', `box:${boxId}`);
    setDone({ id: boxId, name: boxName, note: '', box: true });
  };

  const submit = async () => {
    setError('');
    if ((pick === 'new' || pick === 'newbox') && !newName.trim()) { setError(pick === 'newbox' ? 'Name the new box.' : 'Name the new reading order.'); return; }
    if (pick === 'newbox' || isBoxPick(pick)) {
      setBusy(true);
      try { await addToSeriesBox(); } catch (e) { setError(e.message); }
      setBusy(false);
      return;
    }
    if (target.kind === 'series' && mode === 'range' && !start.trim() && !end.trim()) { setError('Enter the first issue, the last issue, or both.'); return; }
    setBusy(true);
    try {
      let listId = pick, listName = lists.find(l => l.id === pick)?.name;
      if (pick === 'new') {
        const d = await rlApi('POST', '/api/reading-lists', { name: newName.trim() });
        listId = d.id; listName = newName.trim();
      }
      let dupes = 0, pending = false;
      for (const body of entriesFor()) {
        const r = await rlApi('POST', `/api/reading-lists/${listId}/entries`, body);
        if (r.duplicate) dupes++;
        if (r.pending) pending = true;
      }
      prefs.set('lastList', listId);
      if (boxesToo) prefs.set('lastBox', '');
      const note = [
        pending ? 'Omnibus is gathering the full issue list now.' : null,
        dupes ? (dupes === 1 ? 'It was already on this list, so it now appears twice. You can remove one on the list page.' : `${dupes} were already on this list.`) : null,
      ].filter(Boolean).join(' ');
      setDone({ id: listId, name: listName, note });
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const title = target.label ? `Add ${target.label} to a box` : 'Add to a box';
  const orderPicked = !(pick === 'newbox' || isBoxPick(pick));

  if (done) {
    return (
      <Modal title={title} onClose={onClose}
        footer={<>
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
          <button className="btn btn-primary" onClick={() => { onClose(); navigate(done.box ? `/collections/${done.id}` : `/reading-lists/${done.id}`); }}>{done.box ? 'View box →' : 'View reading order →'}</button>
        </>}>
        <div className="rl-modal-body">
          <div className="rl-done">
            <div className="rl-done-burst">Added!</div>
            <div className="rl-done-text">Now on <b style={{ color: 'var(--td-yellow)' }}>{done.name}</b>.{done.note ? ` ${done.note}` : ''}</div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || lists === null || boxes === null}>{busy ? 'Adding…' : 'Add'}</button>
      </>}>
      <div className="rl-modal-sub">
        {target.kind === 'books' ? `Add ${target.bookIds.length} selected issue${target.bookIds.length === 1 ? '' : 's'}` : KIND_SUB[target.kind]}
      </div>
      <div className="rl-modal-body">
        {boxesToo && (
          <div className="rl-field">
            <span className="rl-label">Series boxes</span>
            {boxes === null && !error && <div className="rl-status"><span className="rl-spin" /> Loading your boxes…</div>}
            {boxes !== null && (
              <div className="rl-picklist" role="radiogroup" aria-label="Series boxes">
                {boxes.map(b => (
                  <button key={b.id} type="button" role="radio" aria-checked={pick === `box:${b.id}`}
                    className={`rl-pick ${pick === `box:${b.id}` ? 'on' : ''}`} onClick={() => setPick(`box:${b.id}`)}>
                    <span className="rl-pick-dot" />
                    <span className="rl-pick-name">{b.name}</span>
                    <span className="rl-pick-tag">{b.owner_id ? `${b.seriesCount ?? 0} series` : 'Library box'}</span>
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={pick === 'newbox'}
                  className={`rl-pick rl-pick--new ${pick === 'newbox' ? 'on' : ''}`} onClick={() => setPick('newbox')}>
                  <span className="rl-pick-dot" />
                  <span className="rl-pick-name">+ New series box</span>
                </button>
              </div>
            )}
            {pick === 'newbox' && (
              <input className="rl-input" autoFocus placeholder="Name your new series box" value={newName} maxLength={200}
                onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
            )}
          </div>
        )}
        <div className="rl-field">
          <span className="rl-label">Reading orders</span>
          {lists === null && !error && <div className="rl-status"><span className="rl-spin" /> Loading your reading orders…</div>}
          {lists !== null && (
            <div className="rl-picklist" role="radiogroup" aria-label="Reading orders">
              {lists.map(l => (
                <button key={l.id} type="button" role="radio" aria-checked={pick === l.id}
                  className={`rl-pick ${pick === l.id ? 'on' : ''}`} onClick={() => setPick(l.id)}>
                  <span className="rl-pick-dot" />
                  <span className="rl-pick-name">{l.name}</span>
                  {containing.has(l.id) && <span className="rl-pick-tag" style={{ color: 'var(--td-yellow)' }}>✓ Already in</span>}
                  <span className="rl-pick-tag">{VISIBILITY_LABEL[l.visibility]}</span>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={pick === 'new'}
                className={`rl-pick rl-pick--new ${pick === 'new' ? 'on' : ''}`} onClick={() => setPick('new')}>
                <span className="rl-pick-dot" />
                <span className="rl-pick-name">+ New reading order</span>
              </button>
            </div>
          )}
          {pick === 'new' && (
            <input className="rl-input" autoFocus placeholder="Name your new reading order" value={newName} maxLength={200}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
          )}
        </div>
        {target.kind === 'series' && orderPicked && (
          <div className="rl-field">
            <span className="rl-label">What to add</span>
            <div className="rl-seg">
              <button type="button" className={mode === 'series' ? 'on' : ''} onClick={() => setMode('series')}>Whole series</button>
              <button type="button" className={mode === 'range' ? 'on' : ''} onClick={() => setMode('range')}>A run of issues</button>
            </div>
            {mode === 'series'
              ? <div className="rl-seg-hint">Every issue, including ones you don't own yet. New issues are added automatically.</div>
              : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="rl-input" style={{ width: 110 }} placeholder="From #" value={start} onChange={e => setStart(e.target.value)} />
                  <span className="rl-stat-line">to</span>
                  <input className="rl-input" style={{ width: 110 }} placeholder="To #" value={end} onChange={e => setEnd(e.target.value)} />
                  <span className="rl-seg-hint" style={{ flexBasis: '100%' }}>Leave "To" empty to run to the latest issue.</span>
                </div>
              )}
          </div>
        )}

        {error && <div className="rl-error">{error}</div>}
      </div>
    </Modal>
  );
}
