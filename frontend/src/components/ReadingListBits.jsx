// ─── ReadingListBits ──────────────────────────────────────────────
// Shared pieces for the reading list pages and the Add-to-list dialog:
// API helper, cover fan, chips, progress bars, and the list settings
// modal (create / edit / delete). Styles: ../readingLists.css.
import React, { useState } from 'react';
import Modal from './Modal';
import { isAdmin } from '../App';
import '../readingLists.css';

export async function rlApi(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

// Per-viewer preferences (remembered list, view mode). Never required.
export const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem(`omnibus.rl.${key}`); return v == null ? fallback : v; } catch { return fallback; } },
  set(key, value)    { try { localStorage.setItem(`omnibus.rl.${key}`, String(value)); } catch {} },
};

// 'public' is shown as Shared (2026-11-03): any box can be shared and followed.
export const VISIBILITY_LABEL = { private: 'Private', public: 'Shared', essential: 'Essential' };
export const TYPE_LABEL = { issue: 'Issue', range: 'Run', series: 'Series', event: 'Timeline', canon_run: 'Top Shelf', story: 'Crossover' };
const TYPE_ICON = { issue: '◆', range: '▤', series: '▥', event: '⚡', canon_run: '★', story: '⇄' };

export function VisibilityChip({ visibility }) {
  return (
    <span className={`rl-chip rl-chip--${visibility}`}>
      {visibility === 'private' ? '🔒' : visibility === 'essential' ? '★' : '◉'} {VISIBILITY_LABEL[visibility] || visibility}
    </span>
  );
}
export function TypeChip({ type }) {
  return <span className={`rl-chip rl-chip--${type}`}>{TYPE_ICON[type]} {TYPE_LABEL[type] || type}</span>;
}

// Covers fanned like a pull stack. bookIds: up to 4.
export function CoverFan({ bookIds = [], emptyText = 'Empty list' }) {
  const ids = bookIds.slice(0, 4);
  if (!ids.length) {
    return (
      <div className="rl-art-empty">
        <div className="rl-art-empty-icon">◈</div>
        <div className="rl-art-empty-text">{emptyText}</div>
      </div>
    );
  }
  return (
    <div className={`rl-fan rl-fan--n${ids.length}`}>
      {ids.map(id => (
        <div key={id} className="rl-fan-cover">
          <img src={`/api/books/${id}/thumbnail`} alt="" loading="lazy" draggable={false}
            onError={e => { e.target.style.visibility = 'hidden'; }} />
        </div>
      ))}
    </div>
  );
}

// Owned (pale) under read (red). progress: { total, owned, read }
export function ProgressBars({ progress, compact = false }) {
  const total = progress?.total || 0;
  const pctOwned = total ? (progress.owned / total) * 100 : 0;
  const pctRead  = total ? (progress.read / total) * 100 : 0;
  return (
    <div className="rl-progress" title={`${progress?.read || 0} read · ${progress?.owned || 0} owned · ${total} issues`}>
      <div className="rl-progress-bar">
        <div className="rl-progress-owned" style={{ width: `${pctOwned}%` }} />
        <div className="rl-progress-read"  style={{ width: `${pctRead}%` }} />
      </div>
      <span className="rl-progress-text">
        {compact ? `${progress?.read || 0}/${total} read` : `${progress?.read || 0} / ${total} read · ${progress?.owned || 0} owned`}
      </span>
    </div>
  );
}

// The dialog moved to components/Modal.jsx (shared by every page, 2026-10-26).
export { Modal };

// Visibility picker (Essential only for the admin, or when already essential).
export function VisibilityPicker({ value, onChange, allowPrivate = true }) {
  const opts = ['private', 'public', ...((isAdmin() || value === 'essential') ? ['essential'] : [])].filter(v => allowPrivate || v !== 'private');
  const hint = {
    private: 'Only you can see this reading order.',
    public: 'Shared: other readers find it with Find shared boxes on the Comic Box page, and can follow or copy it.',
    essential: 'Featured for everyone as an Essentials list. Admin only.',
  }[value];
  return (
    <div className="rl-field">
      <span className="rl-label">Who can see it</span>
      <div className="rl-seg">
        {opts.map(v => (
          <button key={v} type="button" className={value === v ? 'on' : ''} onClick={() => onChange(v)}
            disabled={v === 'essential' && !isAdmin()}>
            {VISIBILITY_LABEL[v]}
          </button>
        ))}
      </div>
      {hint && <div className="rl-seg-hint">{hint}</div>}
    </div>
  );
}

// Create (list = null) or edit an existing list. onSaved(id), onDeleted().
// embedded: the form and its buttons only, for the New list / New Essential dialog (components/NewEntry.jsx).
export function ListSettingsModal({ list, onClose, onSaved, onDeleted, defaultVisibility = 'private', embedded = false }) {
  const editing = !!list;
  const [name, setName] = useState(list?.name || '');
  const [description, setDescription] = useState(list?.description || '');
  const [visibility, setVisibility] = useState(list?.visibility || defaultVisibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canMakePrivate = !editing || list.is_owner;

  const save = async () => {
    if (!name.trim()) { setError('Give the list a name.'); return; }
    setBusy(true); setError('');
    try {
      if (editing) {
        await rlApi('PATCH', `/api/reading-lists/${list.id}`, { name, description, visibility });
        onSaved(list.id);
      } else {
        const d = await rlApi('POST', '/api/reading-lists', { name, description, visibility });
        onSaved(d.id);
      }
    } catch (e) { setError(e.message); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await rlApi('DELETE', `/api/reading-lists/${list.id}`); onDeleted(); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  const buttons = (<>
        {editing && !confirmDelete && (
          <button className="btn btn-ghost" style={{ marginRight: 'auto', color: '#ff7a6a' }} onClick={() => setConfirmDelete(true)} disabled={busy}>Delete list</button>
        )}
        {editing && confirmDelete && (
          <span style={{ marginRight: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="rl-stat-line" style={{ color: '#ff7a6a' }}>Delete for good?</span>
            <button className="btn btn-primary" onClick={remove} disabled={busy}>Delete</button>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep</button>
          </span>
        )}
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Create list'}</button>
  </>);
  const form = (
      <div className="rl-modal-body">
      <label className="rl-field">
        <span className="rl-label">Name</span>
        <input className="rl-input" value={name} maxLength={200} autoFocus placeholder="e.g. Hal Jordan: The Long Way"
          onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
      </label>
      <label className="rl-field">
        <span className="rl-label">Description</span>
        <textarea className="rl-input" value={description} maxLength={4000} placeholder="What's this path through the long box?"
          onChange={e => setDescription(e.target.value)} />
      </label>
      <VisibilityPicker value={visibility} onChange={setVisibility} allowPrivate={canMakePrivate} />
      {error && <div className="rl-error">{error}</div>}
    </div>
  );
  if (embedded) return <>{form}<div className="rl-modal-foot">{buttons}</div></>;
  return (
    <Modal title={editing ? 'List Settings' : defaultVisibility === 'essential' ? 'New Essential' : 'New Reading List'} onClose={onClose} footer={buttons}>
      {form}
    </Modal>
  );
}

// Description text with **bold** spans. Only bold is recognised; everything
// else (including stray asterisks) is shown as written. No HTML is injected.
export function RichText({ text }) {
  const parts = String(text || '').split(/(\*\*[^*\n][^*]*?\*\*)/g);
  return <>{parts.map((p, i) => /^\*\*[^*\n][^*]*?\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}
