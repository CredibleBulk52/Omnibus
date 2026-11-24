import React, { useState, useEffect, useCallback, useRef } from 'react';
import { InfoTip } from '../../App';
import { IssueRow } from './IssueRow';
import { useToast } from './shared';

// ─── Wanted tab ───────────────────────────────────────────────────
export function WantedTab({ initialSearch = '' }) {
  const { toast } = useToast();
  const [error, setError] = useState('');
  const scanPoll = useRef(null);
  useEffect(() => () => clearInterval(scanPoll.current), []);
  const [issues, setIssues]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [scanState, setScanState] = useState(null);
  const [scanning, setScanning]   = useState(false);
  const [filter, setFilter]       = useState('wanted');
  const [searchFilter, setSearchFilter] = useState(initialSearch);

  // If a deep-link search arrives after mount, apply it
  useEffect(() => { if (initialSearch) setSearchFilter(initialSearch); }, [initialSearch]);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/wanted');
      const d = await r.json();
      if (!r.ok || !Array.isArray(d)) throw new Error(d.error || 'Could not load wanted issues');
      setIssues(d); setError('');
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/wanted/scan/status');
      const d = await r.json();
      setScanState(d);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    loadStatus();
    const iv = setInterval(() => { load(); loadStatus(); }, 30000);
    return () => clearInterval(iv);
  }, [load, loadStatus]);

  const triggerScan = async () => {
    setScanning(true);
    toast('Scan & grab started…', 'info');
    try {
      const r = await fetch('/api/monitor/wanted/scan', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not start scan');
      setScanState(d.state);
      clearInterval(scanPoll.current);
      scanPoll.current = setInterval(async () => {
        try {
        const r2 = await fetch('/api/monitor/wanted/scan/status');
        const d2 = await r2.json();
        if (!r2.ok) throw new Error(d2.error || 'Could not check scan');
        setScanState(d2);
        if (!d2.running) {
          clearInterval(scanPoll.current);
          setScanning(false);
          load();
          toast(`Scan complete — ${d2.grabbed || 0} grabbed, ${d2.skipped || 0} not found`, 'success');
        }
        } catch (e) { clearInterval(scanPoll.current); setScanning(false); setError(e.message); }
      }, 2000);
    } catch (e) {
      setScanning(false);
      toast(`Scan failed: ${e.message}`, 'error');
    }
  };

  const skipIssue = async (issue, newStatus = 'skipped') => {
    try {
      const r = await fetch(`/api/monitor/series/${issue.series_id}/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: [issue.id], status: newStatus }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not update issue'); }
      setIssues(prev => prev.map(i => i.id === issue.id ? { ...i, status: newStatus } : i));
      toast(`${issue.series_name} ${issue.issue_number} marked ${newStatus}`, 'success');
    } catch (e) {
      toast(`Failed: ${e.message}`, 'error');
    }
  };

  const wantedOnly = issues.filter(i => i.status === 'wanted');
  const baseList   = filter === 'wanted' ? wantedOnly : issues;
  const displayed  = searchFilter
    ? baseList.filter(i => {
        const q = searchFilter.toLowerCase();
        return (i.series_name || '').toLowerCase().includes(q) ||
               String(i.issue_number || '').includes(q);
      })
    : baseList;

  // Group by series name for display
  const grouped = displayed.reduce((acc, issue) => {
    const key = issue.series_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(issue);
    return acc;
  }, {});

  const fmtTime = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="dm-wanted">
      {error && <div className="a-err" role="alert">{error} <button className="adm-btn" onClick={load}>Retry</button></div>}
      {/* Toolbar */}
      <div className="a-flex a-ai-c a-gap-10 a-mb-16 a-wrap">
        {/* Filter toggle */}
        <div className="a-flex a-ovh" style={{ background: 'var(--adm-g1)', borderRadius: 6, border: '1px solid var(--adm-g3)' }}>
          {['wanted', 'all'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="a-fs-12 a-ptr" style={{ padding: '5px 14px', border: 'none', background: filter === f ? 'color-mix(in srgb, var(--om-base) 95%, white)' : 'transparent', color: filter === f ? 'var(--om-text)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))' }}
            >
              {f === 'wanted' ? `Wanted (${wantedOnly.length})` : `All active (${issues.length})`}
            </button>
          ))}
        </div>

        {/* Search filter */}
        <input
          type="text"
          aria-label="Filter wanted issues" placeholder="Filter by series or issue…"
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          className="a-fs-12" style={{ width: 220, padding: '5px 10px' }}
        />

        {/* Scan button */}
        <button
          className="adm-btn adm-btn-primary a-ml-auto" style={{ opacity: scanning || scanState?.running ? 0.7 : 1 }}
          onClick={triggerScan}
          disabled={scanning || scanState?.running}
        >
          {scanning || scanState?.running ? '⟳ Scanning…' : '⟳ Scan & Grab Wanted'}
        </button>
        <InfoTip text="Checks all wanted issues against Prowlarr indexers and sends found NZBs to SABnzbd for download. Runs through each wanted issue in order — can take several minutes for large queues." position="left" width={260} />
      </div>

      {/* Scan progress / last run */}
      {scanState && (
        <div className="a-mb-12 a-fs-12 a-flex a-ai-c a-gap-16 a-wrap" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, padding: '8px 14px' }}>
          {scanState.running ? (
            <>
              <span className="a-accent">⟳ Scanning…</span>
              <span className="a-faint">{scanState.done} / {scanState.total} checked</span>
              <span className="a-ok">↓ {scanState.grabbed} grabbed</span>
              <span className="a-faint">{scanState.skipped} skipped</span>
              {scanState.errors > 0 && <span className="a-err">{scanState.errors} errors</span>}
            </>
          ) : (
            <>
              <span className="a-faint">Last scan: {scanState.lastRun ? fmtTime(scanState.lastRun) : 'never'}</span>
              {scanState.lastRun && <>
                <span className="a-ok">↓ {scanState.grabbed} grabbed</span>
                <span className="a-faint">{scanState.skipped} not found</span>
                {scanState.errors > 0 && <span className="a-err">{scanState.errors} errors</span>}
              </>}
              <span className="a-dim a-ml-auto">Auto-scans every 6 hours</span>
            </>
          )}
        </div>
      )}

      {loading && <div className="adm-empty">Loading…</div>}

      {!loading && !error && displayed.length === 0 && (
        <div className="adm-empty">
          <div className="a-mb-10" style={{ fontSize: 28, opacity: 0.3 }}>✓</div>
          <div className="a-faint a-fs-13">
            {searchFilter ? 'No issues match your search.' : filter === 'wanted' ? 'No issues currently marked wanted.' : 'No active downloads.'}
          </div>
        </div>
      )}

      {/* Grouped issue list */}
      {Object.entries(grouped).map(([groupId, seriesIssues]) => {
        const seriesName = seriesIssues[0].series_name;
        // seriesId is same for all issues in group
        const seriesId = seriesIssues[0].series_id;
        return (
          <div key={groupId} className="a-mb-8 a-ovh" style={{ border: '1px solid var(--adm-g3)', borderRadius: 6 }}>
            {/* Series header */}
            <div className="a-flex a-ai-c a-gap-8" style={{ background: 'var(--adm-g1)', padding: '7px 12px', borderBottom: '1px solid var(--adm-g3)' }}>
              <span className="a-text a-fs-13 a-fw6">{seriesName}</span>
              {seriesIssues[0].series_year && (
                <span className="a-faint a-fs-11">{seriesIssues[0].series_year}</span>
              )}
              {seriesIssues[0].series_publisher && (
                <span className="a-dim a-fs-11">{seriesIssues[0].series_publisher}</span>
              )}
              <span className="a-ml-auto a-faint a-fs-11">
                {seriesIssues.length} issue{seriesIssues.length !== 1 ? 's' : ''}
              </span>
            </div>
            {seriesIssues.map(issue => (
              <IssueRow
                key={issue.id}
                issue={{ ...issue, series_name: seriesName }}
                seriesId={seriesId}
                onSkip={skipIssue}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
