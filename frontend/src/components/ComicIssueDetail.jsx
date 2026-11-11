import { useConfirm } from './Confirm';
import React, { useState, useEffect } from 'react';
import { isAdmin } from '../App';
import { issueText, uniqueCredits, issueSummary } from './issuePresentation';
import '../comicIssueDetail.css';
import { reportProblem } from './ReportProblem';

function DiskLocation({ seriesId, bookId }) {
  const [loc, setLoc] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const q = bookId ? `bookId=${encodeURIComponent(bookId)}` : `seriesId=${encodeURIComponent(seriesId)}`;
    fetch(`/api/admin/location?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setLoc)
      .catch(() => {});
  }, [seriesId, bookId]);
  const p = loc?.hostPath;
  if (!p) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(p); }
    catch {
      const t = document.createElement('textarea');
      t.value = p; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch {}
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, margin:'8px 0', fontSize:12, color:'var(--text-muted)', minWidth:0 }}>
      <span title="Location on disk (admin only)">📁</span>
      <code title={p} style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', userSelect:'all' }}>{p}</code>
      {loc.exists === false && <span style={{ color:'color-mix(in srgb, var(--td-red) 75%, white)', whiteSpace:'nowrap' }}>missing on disk</span>}
      <button className="btn btn-ghost" style={{ fontSize:11, padding:'2px 8px', flexShrink:0 }} onClick={copy}>
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function ComicIssueDetail({ book, seriesTitle, onClose, onRead, onToggleSpecial, onAddToList, onTagged, onDeleted, deletionNote }) {
  const confirm = useConfirm();
  const ci = book.comicinfo || {};
  const coverUrl = `/api/books/${book.id}/thumbnail`;
  const [tagState, setTagState] = React.useState(null); // null | 'tagging' | 'ok' | 'error'
  const [tagMsg, setTagMsg] = React.useState('');
  const [specialState, setSpecialState] = React.useState(null);
  const [isSpecial, setIsSpecial] = React.useState(!!book.is_special);
  const [cvUrlOpen, setCvUrlOpen] = React.useState(false);
  const [cvUrl, setCvUrl] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  // Admin only: deletes the file from disk (and its reading progress). Asks first.
  const deleteIssue = async () => {
    const name = book.filename || `${seriesTitle || ''} #${book.issue_number || ''}`;
    if (!(await confirm({ title: 'Delete this file?', message: `Permanently delete "${name}" from disk?\n\nThe file is removed from your library folder and cannot be recovered. Reading progress for it is cleared.${deletionNote ? `\n\n${deletionNote}` : ''}`, confirmLabel: 'Delete file', danger: true }))) return;
    setDeleting(true); setTagMsg('');
    try {
      const r = await fetch('/api/books/batch', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookIds: [book.id] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.deleted?.includes(book.id)) throw new Error(d.errors?.[0]?.error || d.error || 'Delete failed');
      if (onDeleted) onDeleted(book.id); else onClose();
    } catch (e) { setTagState('error'); setTagMsg(`Could not delete: ${e.message}`); setDeleting(false); }
  };

  const tagIssue = async (overrideUrl = null) => {
    setTagState('tagging');
    setTagMsg('');
    try {
      const body = overrideUrl ? { cv_issue_url: overrideUrl } : {};
      const r = await fetch(`/api/books/${book.id}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok && d.success) {
        setTagState('ok');
        setCvUrlOpen(false);
        setCvUrl('');
        setTagMsg(d.source === 'cv-url' ? 'Tagged from the Comic Vine link ✓' : 'Retagged from Comic Vine ✓');
        if (onTagged) onTagged(book.id);
      } else {
        setTagState('error');
        setTagMsg(d.error || 'Tag failed');
      }
    } catch (e) {
      setTagState('error');
      setTagMsg(e.message);
    }
  };

  const toggleSpecial = async () => {
    setSpecialState('toggling');
    try {
      const r = await fetch(`/api/books/${book.id}/toggle-special`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Could not update the special designation.');
      if (d.ok) {
        setIsSpecial(d.is_special === 1);
        if (onToggleSpecial) onToggleSpecial(book.id, d.is_special === 1);
      }
    } catch (error) {
      setTagState('error'); setTagMsg(error.message);
    } finally {
      setSpecialState(null);
    }
  };

  const dialog = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector('button')?.focus();
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = [...dialog.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),summary,[tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown',keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  const seriesName = issueText(ci.series || seriesTitle || 'Issue');
  const number = book.issue_number ?? ci.number;
  const identity = `${seriesName}${number != null && number !== '' ? ` #${number}` : ''}`;
  const rawTitle = issueText(ci.title || book.title);
  const storyTitle = rawTitle && !/\.(cbz|cbr|pdf|zip)$/i.test(rawTitle) ? rawTitle : identity;
  const summary = issueSummary(ci.summary);
  const credits = [ ['Writer',ci.writer], ['Penciller',ci.penciller], ['Inker',ci.inker], ['Colorist',ci.colorist], ['Cover artist',ci.coverArtist] ].map(([role,value]) => [role,uniqueCredits(value)]).filter(([,value]) => value);
  const web = /^https?:\/\//i.test(ci.web || '') ? ci.web : null;
  return <div className="cid-overlay" onClick={event => { if(event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="cid-dialog" role="dialog" aria-modal="true" aria-labelledby="cid-title">
      <button className="cid-close" aria-label="Close issue details" onClick={onClose}>×</button>
      <div className="cid-layout">
        <aside className="cid-cover-column">
          <img className="cid-cover" src={coverUrl} alt={`${identity} cover`} />
          <button className="cid-button cid-read" onClick={onRead}>▶ Read</button>
          <button className="cid-button" onClick={() => { onClose(); reportProblem({ type: 'book', id: book.id, label: identity, kinds: ['file', 'metadata', 'other'] }); }}>⚑ Report a problem</button>
          {(isAdmin() || onAddToList) && <details className="cid-manage"><summary>Manage issue <span>⌄</span></summary>
            {onAddToList && <button className="cid-button" onClick={onAddToList}>+ Add to a box</button>}
            {isAdmin() && <>
            <button className="cid-button" disabled={tagState === 'tagging'} onClick={() => tagIssue()}>{tagState === 'tagging' ? 'Tagging…' : 'Tag Issue'}</button>
            <button className="cid-button" disabled={tagState === 'tagging'} onClick={() => setCvUrlOpen(v => !v)}>Tag with CV URL</button>
            {cvUrlOpen && <div className="cid-url"><label htmlFor="cid-cv-url">Comic Vine issue URL</label><input id="cid-cv-url" type="url" value={cvUrl} onChange={e => setCvUrl(e.target.value)} placeholder="https://comicvine.gamespot.com/…" onKeyDown={e => { if(e.key === 'Enter' && cvUrl.trim() && tagState !== 'tagging') tagIssue(cvUrl.trim()); }} /><button className="cid-button" disabled={!cvUrl.trim() || tagState === 'tagging'} onClick={() => tagIssue(cvUrl.trim())}>Apply</button></div>}
            <button className="cid-button" disabled={specialState === 'toggling'} onClick={toggleSpecial}>{specialState === 'toggling' ? 'Saving…' : isSpecial ? 'Remove special designation' : 'Mark as Special'}</button>
            <DiskLocation bookId={book.id} />
            <button className="cid-button cid-danger" disabled={deleting || tagState === 'tagging'} onClick={deleteIssue}
              title="Remove this issue's file from disk">{deleting ? 'Deleting…' : '🗑 Delete from disk'}</button>
          </>}
          </details>}
          {tagMsg && <p className="cid-status" role={tagState === 'error' ? 'alert' : 'status'}>{tagMsg}</p>}
        </aside>
        <div className="cid-info">
          <div className="cid-kicker">{storyTitle === identity ? 'Issue details' : identity}{isSpecial && <span>Special</span>}</div>
          <h2 id="cid-title">{storyTitle}</h2>
          <dl className="cid-facts">{[['Publisher',ci.publisher],['Year',ci.year],['Pages',ci.pageCount]].filter(([,v]) => v).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{issueText(value)}</dd></div>)}</dl>
          {summary.story && <section className="cid-story"><h3>The story</h3><p>{summary.story}</p></section>}
          {credits.length > 0 && <section className="cid-credits"><h3>Credits</h3><dl>{credits.map(([role,value]) => <div key={role}><dt>{role}</dt><dd>{value}</dd></div>)}</dl></section>}
          {ci.genre && <p className="cid-genre">{issueText(ci.genre)}</p>}
          {ci.characters && <details className="cid-extra"><summary>Characters</summary><p>{uniqueCredits(ci.characters)}</p></details>}
          {summary.supplement && <details className="cid-extra"><summary>Cover variants &amp; additional notes</summary><p>{summary.supplement}</p></details>}
          {web && <a className="cid-source" href={web} target="_blank" rel="noopener noreferrer">View on Comic Vine ↗</a>}
        </div>
      </div>
    </section>
  </div>;
}

