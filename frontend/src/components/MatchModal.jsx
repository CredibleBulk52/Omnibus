import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, rlApi } from './ReadingListBits';
import AcquireBox from './AcquireBox';

export default function MatchModal({ issue, target, acquireBase, onClose, onMatched }) {
  const [query, setQuery] = useState(issue.series_name || '');
  const [num, setNum] = useState(issue.issue_number || '');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = useCallback(async (q = query, n = num) => {
    if (!q.trim()) return;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ q: q.trim() });
      if (String(n).trim()) params.set('issue', String(n).trim());
      const d = await rlApi('GET', `/api/events/book-search?${params}`);
      setResults(Array.isArray(d) ? d : []);
    } catch (e) { setError(e.message); setResults([]); }
    setBusy(false);
  }, [query, num]);
  const searched = useRef(false);
  useEffect(() => { if (!searched.current) { searched.current = true; search(); } }, [search]);   // first search on open

  const pick = async (bookId) => {
    setBusy(true); setError('');
    try { await rlApi(target.method, target.url, target.body(bookId)); onMatched(); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title="Find in Library" onClose={onClose} width={580}
      footer={<>
        {issue.owned && (
          <button className="btn btn-ghost" style={{ marginRight: 'auto', color: '#ff7a6a' }} onClick={() => pick(null)} disabled={busy}>Clear match</button>
        )}
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </>}>
      <div className="rl-modal-sub">
        {issue.series_name} #{issue.issue_number}{issue.volume_year ? ` (${issue.volume_year})` : ''}{issue.title ? ` · “${issue.title}”` : ''}
      </div>
      <div className="rl-modal-body">
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="rl-input" style={{ flex: 1 }} value={query} placeholder="Series name"
            onChange={ev => setQuery(ev.target.value)} onKeyDown={ev => ev.key === 'Enter' && search()} />
          <input className="rl-input" style={{ width: 76 }} value={num} placeholder="#"
            onChange={ev => setNum(ev.target.value)} onKeyDown={ev => ev.key === 'Enter' && search()} />
          <button className="btn btn-primary" onClick={() => search()} disabled={busy}>{busy ? '…' : 'Search'}</button>
        </div>
        {results === null && <div className="rl-status"><span className="rl-spin" /> Searching your library…</div>}
        {results && results.length === 0 && (
          <div className="rl-status">No books found. Try fewer words, or clear the issue number.</div>
        )}
        {results && results.length === 0 && !issue.owned && acquireBase && (
          <AcquireBox base={acquireBase} issue={issue} />
        )}
        {results && results.length > 0 && (
          <div className="rl-picklist" style={{ maxHeight: '45vh' }}>
            {results.map(b => (
              <button key={b.id} type="button" className="rl-pick" onClick={() => pick(b.id)} disabled={busy}>
                <img src={`/api/books/${b.id}/thumbnail`} alt="" style={{ width: 30, height: 45, objectFit: 'cover', border: '1.5px solid #000', flexShrink: 0 }}
                  onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                <span className="rl-pick-name">
                  {b.series_name} <span className="rl-row-num-inline">#{b.issue_number}</span>
                  {b.series_year && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> ({b.series_year})</span>}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.filename}</span>
                </span>
                <span className="rl-pick-tag" style={{ color: 'var(--td-yellow)' }}>{issue.book_id === b.id ? '✓ Current' : 'Select'}</span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="rl-error">{error}</div>}
      </div>
    </Modal>
  );
}
