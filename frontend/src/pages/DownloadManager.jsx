import PageHeader from '../components/PageHeader';
import ManageMenu from '../components/ManageMenu';
import '../downloadManager.css';
import Modal from '../components/Modal';
import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InfoTip, isAdmin } from '../App';
import DownloadQueueTab from './DownloadQueueTab';
import { AddSeriesModal } from './downloadManager/AddSeriesModal';
import { ImportTab } from './downloadManager/ImportTab';
import { LogsPanel } from './downloadManager/LogsPanel';
import { MassJsonPanel } from './downloadManager/MassJsonPanel';
import { PruneEndedModal } from './downloadManager/PruneEndedModal';
import { SeriesCard } from './downloadManager/SeriesCard';
import { WantedTab } from './downloadManager/WantedTab';
import { WeeklyTab } from './downloadManager/WeeklyTab';
import { DownloadProgressPanel, PlusIcon, ToastContainer, useToast } from './downloadManager/shared';
// The page's parts: downloadManager/ (moved out of this file 2026-11-24, code split step 8). Names other
// pages import from here are re-exported unchanged.
export { useToast, ToastContainer, DownloadProgressPanel } from './downloadManager/shared';
export { AddSeriesModal, sortAndFilter } from './downloadManager/AddSeriesModal';
export { PruneEndedModal } from './downloadManager/PruneEndedModal';

// ─── Main page ────────────────────────────────────────────────────
export default function DownloadManager() {
  const location = useLocation();
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  // ?tab=queue deep links (Library attention list). Requests and Reports moved to the account
  // menu (2026-11-10, /admin/requests and /admin/reports); old links go there.
  const navigate = useNavigate();
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return ['monitored', 'manga', 'wanted', 'queue', 'weekly', 'import', 'logs'].includes(t) ? t : 'monitored';
  });
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab');
    if (t === 'requests' || t === 'reports') navigate(`/admin/${t}`, { replace: true });
  }, [location.search, navigate]);
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all | ongoing | ended | unknown
  const [sortBy, setSortBy] = useState('title'); // title | updated | wanted | status
  const [massJsonOpen, setMassJsonOpen] = useState(false);
  const [deepLinkSearch, setDeepLinkSearch] = useState('');
  const [mangaProcessing, setMangaProcessing] = useState(false);
  const [mangaProcessResult, setMangaProcessResult] = useState(null);
  // Bulk "Refresh All Directories" — calls the SSE backend that runs
  // runRefreshDirectory across every monitored series. Bypasses the
  // library scanner's mtime cache, so it's the right tool for rebuilding
  // Download Manager state after a wipe or after issue-number canonicalisation.
  const [refreshAll, setRefreshAll] = useState({ running: false, done: 0, total: 0, errors: 0 });
  const { toast } = useToast();

  const startRefreshAll = async () => {
    if (refreshAll.running) return;
    setRefreshAll({ running: true, done: 0, total: 0, errors: 0 });
    toast('Refresh All started — this may take a few minutes', 'info');
    try {
      const res = await fetch('/api/monitor/refresh-all-directories', { method: 'POST' });
      if (!res.ok) {
        if (res.status === 409) toast('A Refresh All is already running', 'error');
        else toast(`Refresh All failed (HTTP ${res.status})`, 'error');
        setRefreshAll({ running: false, done: 0, total: 0, errors: 0 });
        return;
      }
      // Stream the SSE response so the inline counter updates per series.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(chunk.slice(5).trim());
            if (ev.start) {
              setRefreshAll(s => ({ ...s, total: ev.total || 0 }));
            } else if (ev.done) {
              setRefreshAll(s => ({ ...s, running: false, done: ev.total || s.total, errors: ev.errors || 0 }));
              toast(
                `Refresh All complete — ${ev.totalMatched || 0} matched, ${ev.totalReset || 0} reset across ${ev.total || 0} series`,
                'success'
              );
            } else if (typeof ev.index === 'number') {
              setRefreshAll(s => ({
                ...s,
                done: ev.index,
                errors: ev.error ? s.errors + 1 : s.errors,
              }));
            }
          } catch { /* malformed SSE chunk — skip */ }
        }
      }
      // Stream closed without explicit done event — make sure UI unsticks.
      setRefreshAll(s => s.running ? { ...s, running: false } : s);
    } catch (e) {
      toast(`Refresh All error: ${e.message}`, 'error');
      setRefreshAll(s => ({ ...s, running: false }));
    }
  };

  // Deep-link from Events: /downloads?search=Batman → stay on monitored tab, open Add Series modal pre-populated
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('search');
    if (q) {
      setAddOpen(true);
      setDeepLinkSearch(decodeURIComponent(q));
    }
  }, [location.search]);

  // Watch the log SSE stream for post-process completion events → fire toast
  useEffect(() => {
    const es = new EventSource('/api/logs/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        if (entry.category === 'postprocess' && entry.message && entry.message.includes('done')) {
          const filename = entry.data?.destFilename || '';
          toast(`Post-processed${filename ? `: ${filename}` : ' — issue complete'}`, 'success');
        }
        if (entry.category === 'pack-process' && entry.message && entry.message.includes('complete')) {
          const { processed } = entry.data || {};
          toast(`Pack post-processed — ${processed ?? 0} issues`, 'success');
        }
        if (entry.category === 'scanner' && entry.message && entry.message.includes('Post-process scan triggered')) {
          toast('Library scan started — new files incoming', 'info');
        }
        if (entry.category === 'scanner' && entry.message && entry.message.includes('scan complete') && entry.data?.trigger === 'postprocess') {
          toast('Library scan complete', 'success');
        }
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);


  // Keep wanted count badge fresh
  const [wantedCount, setWantedCount] = useState(0);
  useEffect(() => {
    const refresh = () =>
      fetch('/api/monitor/wanted')
        .then(r => r.json())
        .then(d => setWantedCount(Array.isArray(d) ? d.filter(i => i.status === 'wanted').length : 0))
        .catch(() => {});
    refresh();
    const iv = setInterval(refresh, 60000);
    return () => clearInterval(iv);
  }, []);

  const processMangaDownloads = async () => {
    setMangaProcessing(true);
    setMangaProcessResult(null);
    try {
      const r = await fetch('/api/manga/process-torrents', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        toast('Manga post-processor started — check logs for progress', 'info');
        // Poll for completion
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          const sr = await fetch('/api/manga/process-torrents/status');
          const sd = await sr.json();
          if (!sd.running || attempts > 30) {
            clearInterval(poll);
            setMangaProcessing(false);
            setMangaProcessResult(sd);
            if (sd.processed > 0) { loadSeries(); toast(`Processed ${sd.processed} manga volume(s)`, 'success'); }
          }
        }, 2000);
      } else {
        setMangaProcessing(false);
        toast(d.message || 'Already running', 'info');
      }
    } catch (e) {
      setMangaProcessing(false);
      toast(`Error: ${e.message}`, 'error');
    }
  };

  const toggleSeriesType = async (id, newType) => {
    try {
      await fetch(`/api/monitor/series/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series_type: newType }),
      });
      setSeries(prev => prev.map(s => s.id === id ? { ...s, series_type: newType } : s));
      toast(`Marked as ${newType === 'manga' ? '🎌 Manga' : 'Comic'}`, 'info');
    } catch (e) {
      toast(`Failed to update type: ${e.message}`, 'error');
    }
  };

  const loadSeries = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/monitor/series');
      const d = await r.json();
      setSeries(d);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSeries();
    const interval = setInterval(loadSeries, 60000); // refresh every 60s

    // Also listen for server-pushed series_updated events (fired after post-process scan)
    const es = new EventSource('/api/downloads/progress/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'series_updated') loadSeries();
      } catch {}
    };
    es.onerror = () => {};

    // Listen for merge/special changes (dispatched after merge operations)
    const onSeriesUpdated = () => loadSeries();
    window.addEventListener('omnibus:series-updated', onSeriesUpdated);

    return () => { clearInterval(interval); es.close(); window.removeEventListener('omnibus:series-updated', onSeriesUpdated); };
  }, [loadSeries]);

  // Queue tab data: polled every 4 s while the tab is open, every 20 s
  // otherwise (just enough to keep the tab badge counts current).
  const [queueData, setQueueData] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const loadQueue = useCallback(async () => {
    try {
      const r = await fetch('/api/downloads/queue');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setQueueData(d); setQueueError(null);
    } catch (e) { setQueueError(e.message); }
  }, []);
  useEffect(() => {
    loadQueue();
    const t = setInterval(loadQueue, tab === 'queue' ? 4000 : 20000);
    return () => clearInterval(t);
  }, [tab, loadQueue]);
  const queueRunning = queueData ? queueData.active.filter(a => a.status === 'downloading').length : 0;
  const queueWaiting = queueData ? queueData.queued.length : 0;

  const [confirmDelete, setConfirmDelete] = useState(null); // { id, name, directory }

  const removeSeries = (id) => {
    const s = series.find(x => x.id === id);
    setConfirmDelete({ id, name: s?.name, directory: s?.directory });
  };

  const doRemove = async (deleteFiles) => {
    if (!confirmDelete) return;
    const { id, name } = confirmDelete;
    setConfirmDelete(null);
    try {
      const r = await fetch(`/api/monitor/series/${id}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(`Failed to delete "${name}": ${d.error || r.statusText}`);
        return;
      }
      setSeries(s => s.filter(x => x.id !== id));
    } catch (e) {
      alert(`Failed to delete "${name}": ${e.message}`);
    }
  };

  return (
    <div className="dm-page">
      {/* Page header */}
      <PageHeader title="DOWNLOAD MANAGER" borderSeed={0}>
        {(tab === 'monitored' || tab === 'manga') && (
          <>
            {isAdmin() && <ManageMenu id="download-maintenance" label="Maintenance" open={maintenanceOpen} setOpen={setMaintenanceOpen}>
            {isAdmin() && <button
              className="btn btn-secondary"
              onClick={() => { setMaintenanceOpen(false); startRefreshAll(); }}
              disabled={refreshAll.running}
              title="Re-scan every monitored series directory and re-link files to monitored issues. Bypasses the scanner's mtime cache. Use this after a bulk wipe or migration."
            >
              {refreshAll.running
                ? `Refreshing… ${refreshAll.done}/${refreshAll.total || '…'}${refreshAll.errors ? ` (${refreshAll.errors} err)` : ''}`
                : '↻ Refresh All'}
            </button>}
            {isAdmin() && tab === 'monitored' && (
              <button className="btn btn-secondary" onClick={() => { setMaintenanceOpen(false); setPruneOpen(true); }}
                title="Remove ended series from the download manager. Files and the library are not touched.">
                ✂ Prune Ended
              </button>
            )}
              <button onClick={() => { setMaintenanceOpen(false); setMassJsonOpen(true); }}>Create missing metadata</button>
            </ManageMenu>}
            <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
              + Add Series
            </button>
          </>
        )}
      </PageHeader>

      {/* Tabs */}
      <div className="dm-tabs">
        <button className={`dm-tab ${tab === 'monitored' ? 'dm-tab-active' : ''}`} onClick={() => setTab('monitored')}>
          Comics <span className="dm-tab-count">{series.filter(s => s.series_type !== 'manga').length}</span>
        </button>
        <button className={`dm-tab ${tab === 'manga' ? 'dm-tab-active' : ''}`} onClick={() => setTab('manga')}>
          Manga <span className="dm-tab-count">{series.filter(s => s.series_type === 'manga').length}</span>
        </button>
        <button className={`dm-tab ${tab === 'wanted' ? 'dm-tab-active' : ''}`} onClick={() => setTab('wanted')}>
          Wanted {wantedCount > 0 && <span className="dm-tab-count a-warn" style={{ background: '#7a3a1e' }}>{wantedCount}</span>}
          <InfoTip text="All monitored issues that haven't been downloaded yet. Use Scan & Grab to search for and download them automatically." position="bottom" />
        </button>
        <button className={`dm-tab ${tab === 'queue' ? 'dm-tab-active' : ''}`} onClick={() => setTab('queue')}>
          Queue
          {(queueRunning > 0 || queueWaiting > 0) && (
            <span className="dm-tab-count a-ok" style={{ background: '#1e3a2a' }} title={`${queueRunning} downloading, ${queueWaiting} waiting`}>
              {queueRunning} ↓{queueWaiting > 0 ? ` · ${queueWaiting} queued` : ''}
            </span>
          )}
          {queueData?.limiter?.cooldownUntil && <span className="dm-tab-count a-err" style={{ background: '#3a1e1e' }} title="Paused by a download-host rate limit">paused</span>}
          <InfoTip text="What is downloading now, what is waiting for a slot, issues waiting to retry, and failed issues. Also shows the download limits." position="bottom" />
        </button>
        <button className={`dm-tab ${tab === 'weekly' ? 'dm-tab-active' : ''}`} onClick={() => setTab('weekly')}>
          Weekly Releases <InfoTip text="Browse releases by week and add series to your monitored list." position="bottom" />
        </button>
        <button className={`dm-tab ${tab === 'import' ? 'dm-tab-active' : ''}`} onClick={() => setTab('import')}
          hidden={!isAdmin()}>
          Import
        </button>
        <button className={`dm-tab ${tab === 'logs' ? 'dm-tab-active' : ''}`} onClick={() => setTab('logs')}
          hidden={!isAdmin()}>
          Logs
        </button>
      </div>

      {/* Content */}
      {tab === 'monitored' && (
        <div className="dm-content">
          {/* Filter + sort toolbar */}
          {series.length > 0 && (
            <div className="dm-filter-bar a-flex a-gap-6 a-ai-c a-mb-10 a-wrap">
              {/* Search */}
              <div className="a-rel" style={{ flex: '1 1 160px', minWidth: 120 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"
                  className="a-faint" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  className="adm-input a-fs-12" style={{ paddingLeft: 28, padding: '6px 10px 6px 28px' }}
                  aria-label="Filter series" placeholder="Filter series…"
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                />
              </div>
              {/* Status pills */}
              <div className="a-flex a-gap-2 a-noshrink">
                {[['all','All'],['ongoing','Ongoing'],['ended','Ended'],['unknown','Unknown']].map(([val, label]) => (
                  <button key={val} onClick={() => setFilterStatus(val)} className={`adm-pill${filterStatus === val ? ' is-on' : ''}`} aria-pressed={filterStatus === val}>{label}</button>
                ))}
              </div>
              {/* Sort compact */}
              <select
                className="adm-input a-fs-11 a-muted" style={{ padding: '5px 8px', flex: '0 0 auto', width: 'auto', background: 'var(--adm-g0)' }}
                aria-label="Sort series" value={sortBy}
                onChange={e => setSortBy(e.target.value)}
              >
                <option value="title">A–Z</option>
                <option value="updated">Updated</option>
                <option value="wanted">Wanted</option>
                <option value="untagged">Untagged</option>
                <option value="status">Status</option>
              </select>

            </div>
          )}
          {series.filter(s => s.series_type !== 'manga').length > 0 && (
            <div className="a-fs-11 a-dim a-mb-10">
              New releases auto-scanned weekly · Downloads go to SABnzbd via Prowlarr · GetComics for back-catalog
            </div>
          )}

          {loading && <div className="adm-empty">Loading…</div>}
          {!loading && series.length === 0 && (
            <div className="adm-empty">
              <div className="a-mb-12" style={{ fontSize: 32, opacity: 0.3 }}>◈</div>
              <div className="a-faint a-fs-13">No series monitored yet</div>
              <div className="a-dim a-fs-12 a-mt-6">Add a series to start tracking and downloading issues</div>
              <button className="adm-btn adm-btn-primary a-mt-16" onClick={() => setAddOpen(true)}>
                <PlusIcon /> Add First Series
              </button>
            </div>
          )}
          {(() => {
            // Apply filter — comics tab excludes manga
            let filtered = series.filter(s => s.series_type !== 'manga');
            if (filterText.trim()) {
              const q = filterText.trim().toLowerCase();
              filtered = filtered.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.publisher || '').toLowerCase().includes(q)
              );
            }
            if (filterStatus !== 'all') {
              filtered = filtered.filter(s => (s.series_status || 'unknown') === filterStatus);
            }
            // Apply sort
            filtered = [...filtered].sort((a, b) => {
              if (sortBy === 'title') return a.name.localeCompare(b.name);
              if (sortBy === 'updated') return (b.last_cv_check || '').localeCompare(a.last_cv_check || '');
              if (sortBy === 'wanted') return (b.wanted_count || 0) - (a.wanted_count || 0);
              if (sortBy === 'untagged') return (b.untagged_count || 0) - (a.untagged_count || 0);
              if (sortBy === 'status') {
                const order = { ongoing: 0, unknown: 1, ended: 2 };
                return (order[a.series_status] ?? 1) - (order[b.series_status] ?? 1);
              }
              return 0;
            });
            if (!loading && filtered.length === 0 && series.length > 0) {
              return <div className="a-faint a-fs-13 a-ta-c" style={{ padding: '32px 0' }}>No series match the current filter.</div>;
            }
            return filtered.map(s => <SeriesCard key={s.id} series={s} onRemove={removeSeries} onTypeToggle={toggleSeriesType} />);
          })()}
        </div>
      )}

      {tab === 'manga' && (
        <div className="dm-content">
          {/* Process downloads toolbar */}
          <div className="a-flex a-ai-c a-gap-8 a-mb-12">
            {isAdmin() && <button
              className="adm-btn a-flex a-ai-c a-gap-6 a-fs-12"
              onClick={processMangaDownloads}
              disabled={mangaProcessing}
              title="Scan D:\Downloads\Complete for completed manga downloads and move them to your library"
            >
              {mangaProcessing ? '⏳ Processing…' : '⬇ Process Downloads'}
            </button>}
            {mangaProcessResult && !mangaProcessing && (
              <span className="a-fs-11" style={{ color: mangaProcessResult.errors > 0 ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60' }}>
                {mangaProcessResult.processed > 0 ? `✓ ${mangaProcessResult.processed} processed` : ''}
                {mangaProcessResult.errors > 0 ? ` · ${mangaProcessResult.errors} errors` : ''}{mangaProcessResult.errors > 0 && <button className="adm-btn" onClick={() => setTab('logs')}>View logs</button>}
                {mangaProcessResult.processed === 0 && mangaProcessResult.errors === 0 ? 'No new files found' : ''}
              </span>
            )}
            <span className="a-ml-auto a-fs-11 a-dim">
              Auto-scans every 10 min · Downloads go to qBittorrent
            </span>
          </div>
          {/* Filter + sort toolbar */}
          {series.filter(s => s.series_type === 'manga').length > 0 && (
            <div className="dm-filter-bar a-flex a-gap-6 a-ai-c a-mb-10 a-wrap">
              <div className="a-rel" style={{ flex: '1 1 160px', minWidth: 120 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12"
                  className="a-faint" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  className="adm-input a-fs-12" style={{ paddingLeft: 28, padding: '6px 10px 6px 28px' }}
                  aria-label="Filter manga" placeholder="Filter manga…"
                  value={filterText}
                  onChange={e => setFilterText(e.target.value)}
                />
              </div>
              <div className="a-flex a-gap-2 a-noshrink">
                {[['all','All'],['ongoing','Ongoing'],['ended','Ended'],['unknown','Unknown']].map(([val, label]) => (
                  <button key={val} onClick={() => setFilterStatus(val)} className={`adm-pill${filterStatus === val ? ' is-on' : ''}`} aria-pressed={filterStatus === val}>{label}</button>
                ))}
              </div>
              <select
                className="adm-input a-fs-11 a-muted" style={{ padding: '5px 8px', flex: '0 0 auto', width: 'auto', background: 'var(--adm-g0)' }}
                aria-label="Sort series" value={sortBy}
                onChange={e => setSortBy(e.target.value)}
              >
                <option value="title">A–Z</option>
                <option value="wanted">Wanted</option>
                <option value="untagged">Untagged</option>
                <option value="status">Status</option>
              </select>
            </div>
          )}
          {loading && <div className="adm-empty">Loading…</div>}
          {!loading && series.filter(s => s.series_type === 'manga').length === 0 && (
            <div className="adm-empty">
              <div className="a-mb-12" style={{ fontSize: 32, opacity: 0.3 }}>🎌</div>
              <div className="a-faint a-fs-13">No manga series monitored yet</div>
              <div className="a-dim a-fs-12 a-mt-6">
                Add a series, then choose Set as Manga from its management menu.
                <br />Publishers like Viz, Kodansha, and Yen Press are auto-detected as manga.
              </div>
              <button className="adm-btn adm-btn-primary a-mt-16" onClick={() => setTab('monitored')}>
                Go to Comics
              </button>
            </div>
          )}
          {(() => {
            let filtered = series.filter(s => s.series_type === 'manga');
            if (filterText.trim()) {
              const q = filterText.trim().toLowerCase();
              filtered = filtered.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.publisher || '').toLowerCase().includes(q)
              );
            }
            if (filterStatus !== 'all') {
              filtered = filtered.filter(s => (s.series_status || 'unknown') === filterStatus);
            }
            filtered = filtered.sort((a, b) => {
              if (sortBy === 'wanted')   return (b.wanted_count   || 0) - (a.wanted_count   || 0);
              if (sortBy === 'untagged') return (b.untagged_count || 0) - (a.untagged_count || 0);
              if (sortBy === 'status') return (a.series_status || 'z').localeCompare(b.series_status || 'z');
              return a.name.localeCompare(b.name);
            });
            if (!loading && filtered.length === 0 && series.some(s => s.series_type === 'manga')) return <div className="adm-empty">No manga matches these filters.</div>;
            return filtered.map(s => (
              <SeriesCard key={s.id} series={s} onRemove={removeSeries} onTypeToggle={toggleSeriesType} />
            ));
          })()}
        </div>
      )}

      {tab === 'wanted' && (
        <div className="dm-content">
          <WantedTab initialSearch={deepLinkSearch} />
        </div>
      )}

      {tab === 'queue' && (
        <div className="dm-content">
          <DownloadQueueTab data={queueData} error={queueError} reload={loadQueue} admin={isAdmin()} toast={toast} />
        </div>
      )}

      {tab === 'weekly' && (
        <div className="dm-content">
          <WeeklyTab onSeriesAdded={() => loadSeries()} />
        </div>
      )}

      {tab === 'import' && isAdmin() && (
        <div className="dm-content">
          <ImportTab onImported={() => loadSeries()} />
        </div>
      )}

      {tab === 'logs' && isAdmin() && (
        <div className="dm-content">
          <LogsPanel />
        </div>
      )}

      {pruneOpen && <PruneEndedModal onClose={() => setPruneOpen(false)} onDone={() => { setPruneOpen(false); loadSeries(); }} />}

      {addOpen && (
        <AddSeriesModal
          onClose={() => { setAddOpen(false); setDeepLinkSearch(''); }}
          onAdded={() => { loadSeries(); setDeepLinkSearch(''); }}
          initialQuery={deepLinkSearch}
        />
      )}

      {massJsonOpen && (
        <MassJsonPanel onClose={() => setMassJsonOpen(false)} />
      )}

      {confirmDelete && (
        <Modal title={`Remove "${confirmDelete.name}"?`} onClose={() => setConfirmDelete(null)} width={440}>
          <div className="adm-modal-content" style={{ padding: '16px 18px' }}>
            <div className="a-muted a-fs-13 a-mb-6">
              This will remove the series and all tracked issues from Omnibus.
            </div>
            <div className="a-faint a-fs-11 a-mono a-mb-20 a-breakall">
              {confirmDelete.directory}
            </div>
            <div className="a-flex a-col a-gap-8">
              <button
                className="adm-btn a-jc-c a-err" style={{ borderColor: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 27%, transparent)' }}
                onClick={() => doRemove(true)}
              >
                Remove from Omnibus + delete directory and files
              </button>
              <button
                className="adm-btn a-jc-c"
                onClick={() => doRemove(false)}
              >
                Remove from Omnibus only (keep files)
              </button>
              <button
                className="adm-btn a-jc-c"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
      <ToastContainer />
      <DownloadProgressPanel />
      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes indeterminate { 0% { transform: translateX(-100%); width: 40%; } 100% { transform: translateX(300%); width: 40%; } }
      `}</style>
    </div>
  );
}
