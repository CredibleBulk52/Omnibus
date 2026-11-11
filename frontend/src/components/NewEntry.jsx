import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import '../newEntry.css';

// ─── New entries on the curated pages (2026-10-27) ───────────────
// Timeline (+ New event), Top Shelf (+ New run), Essentials (+ New Essential) and Reading
// Lists (+ New list) all add entries the same way: the first button in the page's admin bar
// (Reading Lists: its "My lists" bar, for every user), opening one dialog with two tabs,
// Generate with AI and Create manually.

export function NewEntryButton({ label, onClick }) {
  return <button type="button" className="admin-bar-btn primary" onClick={onClick}><span aria-hidden="true">+ </span>{label}</button>;
}

export const NEW_ENTRY_TABS = [
  { id: 'generate', label: '✦ Generate with AI' },
  { id: 'manual', label: '✎ Create manually' },
];

// Controlled tabs; children receive the current tab id. Clicking outside does not close it
// (a generation may be running); ✕ or Escape does.
export function NewEntryDialog({ title, tab, onTab, onClose, children, width = 960, tabs = NEW_ENTRY_TABS }) {
  return (
    <Modal title={title} onClose={onClose} width={width} closeOnBackdrop={false} className="new-entry-dialog">
      <div className="new-entry-tabs" role="tablist" aria-label={title}>
        {tabs.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => onTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="new-entry-body" role="tabpanel">{children(tab)}</div>
    </Modal>
  );
}

// Generate with AI for reading lists: Comic Book Guy builds lists in his chat, so this tab
// hands the request to him (components/AssistantBubble.jsx listens for omnibus:assistant-ask).
export function AskForList({ essential, onSent }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('/api/assistant/status').then(r => r.json()).then(d => { if (live) setStatus(d); }).catch(() => { if (live) setStatus({ enabled: false }); });
    return () => { live = false; };
  }, []);
  const send = () => {
    const what = text.trim(); if (!what) return;
    window.dispatchEvent(new window.CustomEvent('omnibus:assistant-ask', { detail: { text: `Build me ${essential ? 'an Essentials' : 'a'} reading list: ${what}` } }));
    onSent();
  };
  if (status && !status.enabled) return <p className="new-entry-note">Comic Book Guy is switched off. An admin can turn him on in Settings → AI &amp; Comic Book Guy. You can still create the list by hand.</p>;
  return (
    <div className="new-entry-ask">
      <label className="adm-label" htmlFor="new-entry-ask">What should the list cover?</label>
      <textarea id="new-entry-ask" className="adm-input" rows={3} value={text} onChange={e => setText(e.target.value)} autoFocus
        placeholder={essential ? 'e.g. John Stewart: his origin, tragedies, recovery and leadership' : 'e.g. the best Batman stories for a new reader'}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
      <p className="new-entry-note">Comic Book Guy builds the list in his chat (he may ask one question first). Save it there with <b>+ Save as reading list</b>{essential ? ', then make it an Essential in the list’s settings' : ''}.
        {status && !status.unlimited && status.daily_limit > 0 ? ` Uses one of your ${status.daily_limit} questions today.` : ''}</p>
      <div className="new-entry-actions">
        <button type="button" className="adm-btn adm-btn-primary" disabled={!text.trim()} onClick={send}>Ask Comic Book Guy</button>
      </div>
    </div>
  );
}
