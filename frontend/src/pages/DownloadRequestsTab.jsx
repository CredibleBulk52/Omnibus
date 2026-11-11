// Download Manager → Requests (admin). When the Download Manager is admin-only,
// users ask for missing issues wherever they show (reading lists, Timeline
// events, Top Shelf runs, series pages: ✉ Request) and for whole series
// (Request a series). One request service: backend/downloadRequests.js.
//   Get issue       a series-page request: files it into that series' folder.
//   Add series      opens Add Series prefilled; the request is marked added
//                   when the series is added.
//   Mark wanted     the series is already monitored but the issue is skipped.
//   Dismiss         the user's list shows "Request dismissed".
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';

const VIEWS = [['open', 'Open'], ['added', 'Handled'], ['dismissed', 'Dismissed']];
const DL_STATUS = { wanted: 'wanted', processed: 'downloaded', downloaded: 'downloaded', skipped: 'skipped' };

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

export default function DownloadRequestsTab({ onAddSeries, onCount, toast, reloadKey }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const requestId = useRef(0);
  const [view, setView] = useState('open');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const d = await api('GET', `/api/download-requests?status=${view}`);
      if (id !== requestId.current) return;
      setRows(d.requests || []); onCount?.(d.open || 0); setError('');
    } catch (e) { if (id === requestId.current) { setError(e.message); setRows([]); } }
  }, [view, onCount]);
  useEffect(() => { setRows(null); load(); }, [load, reloadKey]);

  const setStatus = async (r, status) => {
    const d = await api('POST', `/api/download-requests/${r.id}`, { status });
    onCount?.(d.open || 0);
  };
  const act = async (r, fn) => {
    setBusy(r.id);
    try { await fn(); await load(); } catch (e) { toast ? toast(e.message, 'error') : setError(e.message); }
    setBusy(null);
  };

  const displayed = (rows || []).filter(r => (kind === 'all' || (kind === 'series' ? r.kind === 'series' : r.kind !== 'series')) && `${r.series_name} ${r.issue_number || ''} ${r.user} ${r.note || ''}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="dm-triage">
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} aria-pressed={view === k} className={`btn ${view === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      <div className="dm-triage-toolbar"><input className="adm-input" aria-label="Search requests" placeholder="Series, issue, requester or note…" value={query} onChange={e => setQuery(e.target.value)} /><select className="adm-input" aria-label="Request type" value={kind} onChange={e => setKind(e.target.value)}><option value="all">All requests</option><option value="series">Series requests</option><option value="issue">Issue requests</option></select></div>
      <p className="a-muted">Handled requests may still be downloading. Availability is shown separately.</p>
      {error && <div style={{ color: '#ff7a6a', marginBottom: 10 }}>{error}</div>}
      {rows === null && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
      {rows && !error && rows.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>
          {view === 'open' ? 'No open requests. Users ask for missing issues on series pages and reading lists, and for series on My requests.' : 'Nothing here.'}
        </div>
      )}
      {rows?.length > 0 && displayed.length === 0 && <div className="adm-empty">No requests match these filters.</div>}
      {displayed.map(r => {
        const m = r.monitored;
        const isSeries = r.kind === 'series';
        const label = isSeries
          ? `Series: ${r.series_name || '?'}${r.volume_year ? ` (${r.volume_year})` : ''}${r.publisher ? ` · ${r.publisher}` : ''}`
          : `${r.series_name || 'Unknown series'} #${r.issue_number ?? '?'}${r.volume_year ? ` (${r.volume_year})` : ''}`;
        const from = r.from?.link ? <Link to={r.from.link}>{r.from.label}</Link> : (r.from?.label || 'reading list');
        return (
          <div key={r.id} className="dm-triage-card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 0',
            borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {r.user} · {from} · {String(r.created_at || '').slice(0, 10)}
                
              </div>
              <div className="dm-request-availability">{r.owned ? '✓ In the library' : m ? `Download status: ${DL_STATUS[m.status] || m.status}` : 'Not yet being collected'}</div>
              {r.note && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'pre-line' }}>{r.note}</div>}
            </div>
            {view === 'open' && !r.owned && !m && r.kind === 'series_issue' && r.scanned_series_id && r.cv_issue_id && (
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => act(r, async () => {
                await api('POST', `/api/series/${r.scanned_series_id}/gaps/get`, { issueIds: [String(r.cv_issue_id)] });
                await setStatus(r, 'added');
              })}>Get issue</button>
            )}
            {view === 'open' && !r.owned && !m && r.kind !== 'series_issue' && (
              <button className="btn btn-primary" disabled={busy !== null}
                onClick={() => onAddSeries(r.search || r.series_name || '', r.id)}>Add series</button>
            )}
            {view === 'open' && !r.owned && m?.status === 'skipped' && (
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => act(r, async () => {
                await api('POST', `/api/monitor/series/${m.series_id}/bulk-status`, { issueIds: [m.issue_id], status: 'wanted' });
                await setStatus(r, 'added');
              })}>Mark wanted</button>
            )}
            {view === 'open' && (r.owned || (m && m.status !== 'skipped')) && (
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => act(r, () => setStatus(r, 'added'))}>Mark handled</button>
            )}
            {view === 'open' && (
              <button className="btn btn-ghost" disabled={busy !== null} onClick={() => act(r, () => setStatus(r, 'dismissed'))}>Dismiss</button>
            )}
            {view !== 'open' && (
              <button className="btn btn-ghost" disabled={busy !== null} onClick={() => act(r, () => setStatus(r, 'open'))}>Reopen</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
