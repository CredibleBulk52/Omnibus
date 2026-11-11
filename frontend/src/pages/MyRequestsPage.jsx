import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import { reportProblem } from '../components/ReportProblem';
import RequestSeriesDialog from '../components/RequestSeries';
import { isAdmin, useAppSettings } from '../App';
import '../curatedPage.css';
import '../requestsReports.css';

// ─── My requests (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ─────────────────
// What this user has asked the admin for (missing issues, series) and the
// problems they reported, with their status and any reply.
const REQ_STATUS = { open: 'Waiting', added: 'Handled', dismissed: 'Declined' };
const REP_STATUS = { open: 'Open', resolved: 'Fixed', dismissed: 'Closed' };
const REP_KIND = { file: 'File problem', metadata: 'Wrong information', order: 'Reading order', other: 'Other' };
const date = s => String(s || '').slice(0, 10);

function requestTitle(r) {
  if (r.kind === 'series') return `${r.series_name}${r.volume_year ? ` (${r.volume_year})` : ''}`;
  return `${r.series_name || 'Unknown series'} #${r.issue_number ?? '?'}${r.volume_year ? ` (${r.volume_year})` : ''}`;
}

export default function MyRequestsPage() {
  const settings = useAppSettings();
  const canDownload = isAdmin() || settings.download_manager_admin_only !== 'true';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch('/api/requests/mine').then(r => r.json()), fetch('/api/reports/mine').then(r => r.json())]);
      setData({ requests: a.requests || [], reports: b.reports || [] }); setError('');
    } catch (e) { setError('Could not load your requests'); setData({ requests: [], reports: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { window.addEventListener('omnibus:report-sent', load); return () => window.removeEventListener('omnibus:report-sent', load); }, [load]);

  return (
    <div className="mr-page">
      <PageHeader title="MY REQUESTS" borderSeed={7} />
      <div className="curated-page mr-content">
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        <section className="mr-section">
          <h2>Requests</h2>
          <div className="mr-actions">
            {canDownload
              ? <Link className="btn btn-primary" to="/downloads">+ Add a series</Link>
              : <button type="button" className="btn btn-primary" onClick={() => setAsking(true)}>✉ Request a series</button>}
          </div>
          {!data ? <Loading compact /> : data.requests.length === 0 ? (
            <Empty title="No requests yet">
              {canDownload
                ? 'Missing issues show on each series page; you can get them there.'
                : 'Missing issues show on series pages, reading lists, the Timeline and Top Shelf; tap ✉ Request on one, or request a whole series here.'}
            </Empty>
          ) : (
            <div className="mr-list">
              {data.requests.map(r => {
                const st = r.owned ? 'owned' : r.status;
                return (
                  <div key={r.id} className="mr-row">
                    <div className="mr-main">
                      <div className="mr-title">{r.kind === 'series' ? 'Series: ' : ''}{requestTitle(r)}</div>
                      <div className="mr-meta">
                        {r.from?.link ? <>From <Link to={r.from.link}>{r.from.label}</Link> · </> : null}
                        Asked {date(r.created_at)}{r.handled_at ? ` · answered ${date(r.handled_at)}` : ''}
                      </div>
                      {r.note && <div className="mr-note">{r.note}</div>}
                    </div>
                    <span className={`mr-status mr-status--${st}`}>{r.owned ? 'In the library' : REQ_STATUS[r.status] || r.status}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="mr-section">
          <h2>Problem reports</h2>
          <div className="mr-actions">
            <button type="button" className="btn btn-secondary" onClick={() => reportProblem({ type: 'page', label: null })}>⚑ Report a problem</button>
          </div>
          {!data ? <Loading compact /> : data.reports.length === 0 ? (
            <Empty title="No reports">Use ⚑ Report a problem in the reader, on an issue, a series or a reading order, or here.</Empty>
          ) : (
            <div className="mr-list">
              {data.reports.map(r => (
                <div key={r.id} className="mr-row">
                  <div className="mr-main">
                    <div className="mr-title">{REP_KIND[r.kind] || r.kind}{r.target_label ? `: ${r.target_label}` : ''}</div>
                    <div className="mr-meta">
                      Reported {date(r.created_at)}{r.page_url ? <> · <Link to={r.page_url}>open page</Link></> : null}
                    </div>
                    {r.note && <div className="mr-note">{r.note}</div>}
                    {r.admin_note && <div className="mr-reply">{r.admin_note}</div>}
                  </div>
                  <span className={`mr-status mr-status--${r.status}`}>{REP_STATUS[r.status] || r.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {asking && <RequestSeriesDialog onClose={() => setAsking(false)} onSent={load} />}
    </div>
  );
}
