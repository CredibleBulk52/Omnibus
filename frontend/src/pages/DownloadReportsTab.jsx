// Download Manager → Reports (admin), 2026-10-28 (claude/REQUESTS_AND_REPORTS.md).
// Problems users reported (file, wrong information, reading order, other).
// Mark fixed or close, with an optional reply the user sees on My requests.
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';

const VIEWS = [['open', 'Open'], ['resolved', 'Fixed'], ['dismissed', 'Closed']];
const KIND = { file: 'File problem', metadata: 'Wrong information', order: 'Reading order', other: 'Other' };
const TARGET_LINK = { book: id => `/read/${id}`, series: id => `/series/${id}`, event: id => `/events/${id}`, run: id => `/canon/run/${id}`, list: id => `/reading-lists/${id}` };

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export default function DownloadReportsTab({ onCount }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const requestId = useRef(0);
  const [view, setView] = useState('open');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [replies, setReplies] = useState({});
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try { const d = await api('GET', `/api/reports?status=${view}`); if (id !== requestId.current) return; setRows(d.reports || []); onCount?.(d.open || 0); setError(''); }
    catch (e) { if (id === requestId.current) { setError(e.message); setRows([]); } }
  }, [view, onCount]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const setStatus = async (r, status) => {
    setBusy(r.id);
    try { const d = await api('POST', `/api/reports/${r.id}`, { status, admin_note: replies[r.id] || undefined }); onCount?.(d.open || 0); await load(); }
    catch (e) { setError(e.message); }
    setBusy(null);
  };
  const displayed = (rows || []).filter(r => (kind === 'all' || r.kind === kind) && `${r.target_label || ''} ${r.note || ''} ${r.user}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="dm-triage">
      <div className="a-flex a-gap-8 a-mb-14 a-wrap">
        {VIEWS.map(([k, label]) => (
          <button key={k} className={`adm-pill${view === k ? ' is-on' : ''}`} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      <div className="dm-triage-toolbar"><input className="adm-input" aria-label="Search reports" value={query} onChange={e => setQuery(e.target.value)} placeholder="Title, reporter or description…" /><select className="adm-input" aria-label="Report type" value={kind} onChange={e => setKind(e.target.value)}><option value="all">All problems</option>{Object.entries(KIND).map(([k,label]) => <option key={k} value={k}>{label}</option>)}</select></div>
      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {rows === null && <Loading compact />}
      {rows && !error && rows.length === 0 && <Empty title={view === 'open' ? 'No open reports' : 'Nothing here'}>
        {view === 'open' ? 'Users report problems from the reader, an issue, a series, a reading order or their account menu.' : null}
      </Empty>}
      {rows?.length > 0 && !displayed.length && <div className="adm-empty">No reports match these filters.</div>}
      {displayed.map(r => {
        const link = r.target_id && TARGET_LINK[r.target_type] ? TARGET_LINK[r.target_type](r.target_id) : r.page_url;
        return (
          <div key={r.id} className="dm-triage-card a-flex a-gap-12 a-wrap a-ai-c" style={{ padding: '12px 0', borderBottom: '1px solid var(--adm-g3)' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div className="a-text a-fw6"><span className="dm-problem-kind">{KIND[r.kind] || r.kind}</span>{r.target_label ? `: ${r.target_label}` : ''}</div>
              <div className="a-fs-12 a-muted a-mt-2">
                {r.user} · {String(r.created_at || '').slice(0, 10)}{link ? <> · <Link to={link} className="a-accent">Open affected item ↗</Link></> : null}
              </div>
              {r.note && <div className="a-fs-13 a-text2 a-mt-4" style={{ whiteSpace: 'pre-line' }}>{r.note}</div>}
              {r.admin_note && view !== 'open' && <div className="a-fs-12 a-accent a-mt-4">Reply: {r.admin_note}</div>}
              {view === 'open' && (
                <details className="dm-report-reply"><summary>Reply & resolve</summary><textarea aria-label="Reply to the user" rows={3} className="adm-input a-mt-6 a-fs-12" placeholder="Reply to the user (optional)" maxLength={1000}
                  value={replies[r.id] || ''} onChange={e => setReplies(x => ({ ...x, [r.id]: e.target.value }))} /><div className="dm-triage-toolbar"><button className="adm-btn adm-btn-primary" disabled={busy !== null} onClick={() => setStatus(r, 'resolved')}>Mark fixed</button><button className="adm-btn" disabled={busy !== null} onClick={() => setStatus(r, 'dismissed')}>Close report</button></div></details>
              )}
            </div>
            {view !== 'open' && <button className="adm-btn" disabled={busy !== null} onClick={() => setStatus(r, 'open')}>Reopen</button>}
          </div>
        );
      })}
    </div>
  );
}
