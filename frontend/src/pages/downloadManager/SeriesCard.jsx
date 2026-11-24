import { selectIssueRange } from '../../utils/selectIssueRange.mjs';
import Modal from '../../components/Modal';
import { browseIssues } from '../../utils/browseIssues.mjs';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { isAdmin } from '../../App';
import { MergeSeriesPicker } from './AddSeriesModal';
import { IssueRow, stripPunctKeepInitials } from './IssueRow';
import { ChevronDown, DownloadIcon, ExtLink, SearchIcon, SourceStatus, fmt, sourceOutcome, useToast } from './shared';

// ─── Series card ──────────────────────────────────────────────────

export function SeriesCard({ series, onRemove, onTypeToggle }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState([]);
  const [annuals, setAnnuals] = useState([]);
  const [annualsOpen, setAnnualsOpen] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [linkAnnualOpen, setLinkAnnualOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [merging, setMerging] = useState(false);

  // Close overflow menu when clicking outside
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = () => setOverflowOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [overflowOpen]);

  const retagAll = async (onlyUntagged = false) => {
    setRetagging(true);
    setRetagResult(null);
    const label = onlyUntagged ? 'Retag Untagged' : 'Retag All';
    toast(`${label} started for ${series.name}…`, 'info');
    try {
      // retag-all streams SSE — don't parse as JSON, just fire and forget.
      // Progress surfaces in the global download toast automatically.
      fetch(`/api/monitor/series/${series.id}/retag-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyUntagged }),
      });
      setRetagResult({ label });
      setTimeout(() => setRetagResult(null), 8000);
    } catch (err) {
      toast(`${label} failed: ${err.message}`, 'error');
    }
    setRetagging(false);
  };

  // Auto-grab state
  const [autoGrabbing, setAutoGrabbing] = useState(false);
  const [autoGrabResult, setAutoGrabResult] = useState(null);

  // Directory refresh state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);
  const [showPaths, setShowPaths] = useState(false);
  const [pathsData, setPathsData] = useState(null);
  const [loadingPaths, setLoadingPaths] = useState(false);

  // Directory edit state — inline pencil affordance on the directory line.
  // Used to disambiguate same-name same-year series (e.g. two "Old Man Logan
  // (2016)" volumes) where the auto-suggester picks the same path for both
  // and CV's series_id can't tell them apart visually. User edits inline,
  // backend updates monitored_series.directory, scanner re-locates files.
  const [editingDir, setEditingDir] = useState(false);
  const [editDirValue, setEditDirValue] = useState('');
  const [savingDir, setSavingDir] = useState(false);

  // Retag state
  const [retagging, setRetagging] = useState(false);
  const [retagResult, setRetagResult] = useState(null);

  // series.json state
  const [creatingJson, setCreatingJson] = useState(false);
  const [jsonStatus, setJsonStatus] = useState(null); // null | 'ok' | 'exists' | 'error'

  // Pack search state
  const [packOpen, setPackOpen] = useState(false);
  const [packQuery, setPackQuery] = useState('');
  const [packResults, setPackResults] = useState([]);
  const [packSearching, setPackSearching] = useState(false);
  const [packNote, setPackNote] = useState(null);       // what the last Prowlarr search said
  const [packGrabbing, setPackGrabbing] = useState(false);
  const [packGrabbed, setPackGrabbed] = useState(false);
  const [packTab, setPackTab] = useState('prowlarr'); // 'prowlarr' | 'getcomics' | 'nyaa'
  // GetComics state
  const [gcResults, setGcResults] = useState([]);
  const [gcSearching, setGcSearching] = useState(false);
  const [gcNote, setGcNote] = useState(null);           // what the last GetComics search said
  const [gcLinks, setGcLinks] = useState({}); // pageUrl → { loading, links }
  const [gcDownloading, setGcDownloading] = useState({}); // url → true
  // Nyaa state
  const [nyaaResults, setNyaaResults] = useState([]);
  const [nyaaSearching, setNyaaSearching] = useState(false);
  const [nyaaGrabbing, setNyaaGrabbing] = useState({});

  // Multi-select state for bulk skip/unskip
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState(new Set());
  const [issueQuery, setIssueQuery] = useState('');
  const [issueFilter, setIssueFilter] = useState('all');
  const [issueOrder, setIssueOrder] = useState('oldest');
  const visibleIssues = browseIssues(issues, issueQuery, issueFilter, issueOrder);
  const visibleAnnuals = browseIssues(annuals, issueQuery, issueFilter, issueOrder);
  const selectionAnchor = useRef(null);
  // A changed view starts a fresh selection, so bulk actions cannot target hidden rows.
  useEffect(() => { setSelectedIssues(new Set()); selectionAnchor.current = null; }, [issueQuery, issueFilter, issueOrder, annualsOpen]);

  const toggleSelectMode = (e) => {
    e.stopPropagation();
    setSelectMode(m => !m);
    setSelectedIssues(new Set());
    selectionAnchor.current = null;
  };

  const toggleIssueSelect = useCallback((id, shiftKey = false) => {
    // Capture the anchor before React schedules the state updater.
    const anchor = selectionAnchor.current;
    const visibleIds = [...visibleIssues, ...(annualsOpen ? visibleAnnuals : [])].map(issue => issue.id);
    setSelectedIssues(prev => selectIssueRange(prev, visibleIds, id, anchor, shiftKey));
    if (!shiftKey || !visibleIds.includes(anchor)) selectionAnchor.current = id;
  }, [visibleIssues, visibleAnnuals, annualsOpen]);

  const bulkSetStatus = async (status) => {
    const ids = [...selectedIssues];
    if (!ids.length) return;
    try {
      await fetch(`/api/monitor/series/${series.id}/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: ids, status }),
      });
      setIssues(prev => prev.map(i =>
        ids.includes(i.id) && (['wanted','skipped'].includes(i.status)) ? { ...i, status } : i
      ));
      setAnnuals(prev => prev.map(i =>
        ids.includes(i.id) && (['wanted','skipped'].includes(i.status)) ? { ...i, status } : i
      ));
      toast(`${ids.length} issue${ids.length !== 1 ? 's' : ''} marked ${status}`, 'success');
    } catch (e) {
      toast(`Failed to update status: ${e.message}`, 'error');
    }
    setSelectedIssues(new Set());
    setSelectMode(false);
  };

  const loadIssues = async () => {
    const r = await fetch(`/api/monitor/series/${series.id}/issues`);
    const d = await r.json();
    setIssues(d.issues || []);
    setAnnuals(d.annuals || []);
  };

  const toggle = async () => {
    if (!open && issues.length === 0) {
      setLoadingIssues(true);
      try { await loadIssues(); } catch {}
      setLoadingIssues(false);
    }
    setOpen(o => !o);
  };

  const autoGrab = async (e) => {
    e.stopPropagation();
    setAutoGrabbing(true);
    setAutoGrabResult(null);
    toast(`Auto-grabbing ${series.name}…`, 'info');
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/auto-grab`, { method: 'POST' });
      const d = await r.json();
      setAutoGrabResult(d);
      const ir = await fetch(`/api/monitor/series/${series.id}/issues`);
      const id = await ir.json();
      setIssues(id.issues || []);
      setAnnuals(id.annuals || []);
      if (!open) setOpen(true);
      if (d.error) {
        toast(`Auto-grab failed: ${d.error}`, 'error');
      } else {
        const grabbed = d.grabbed || 0;
        const skipped = d.skipped || 0;
        toast(grabbed > 0
          ? `Grabbed ${grabbed} issue${grabbed !== 1 ? 's' : ''} for ${series.name}`
          : `No results found for ${series.name} (${skipped} checked)`,
          grabbed > 0 ? 'success' : 'info');
      }
    } catch (e) {
      setAutoGrabResult({ error: e.message });
      toast(`Auto-grab failed: ${e.message}`, 'error');
    }
    setAutoGrabbing(false);
  };

  const refreshDirectory = async (e) => {
    e.stopPropagation();
    setRefreshing(true);
    setRefreshResult(null);
    toast(`Refreshing ${series.name}…`, 'info');
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/refresh-directory`, { method: 'POST' });
      const d = await r.json();
      setRefreshResult(d);
      const ir = await fetch(`/api/monitor/series/${series.id}/issues`);
      const id = await ir.json();
      setIssues(id.issues || []);
      setAnnuals(id.annuals || []);
      const matched = d.matched || 0;
      toast(`${series.name} refreshed — ${matched} file${matched !== 1 ? 's' : ''} matched. CV sync running in background.`, 'success');
    } catch (err) {
      setRefreshResult({ error: err.message });
      toast(`Refresh failed: ${err.message}`, 'error');
    }
    setRefreshing(false);
    setTimeout(() => setRefreshResult(null), 6000);
  };

  const togglePaths = async (e) => {
    e.stopPropagation();
    if (showPaths) { setShowPaths(false); return; }
    setLoadingPaths(true);
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/file-paths`);
      const d = await r.json();
      setPathsData(d);
      setShowPaths(true);
    } catch {}
    setLoadingPaths(false);
  };

  const startEditDir = (e) => {
    e.stopPropagation();
    setEditDirValue(series.directory || '');
    setEditingDir(true);
  };

  const cancelEditDir = (e) => {
    e?.stopPropagation();
    setEditingDir(false);
    setEditDirValue('');
  };

  const saveDirectoryEdit = async (e) => {
    e?.stopPropagation();
    const newDir = editDirValue.trim();
    if (!newDir || newDir === series.directory) {
      cancelEditDir();
      return;
    }
    setSavingDir(true);
    try {
      const r = await fetch(`/api/monitor/series/${series.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: newDir }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast(`Directory save failed: ${d.error || 'unknown error'}`, 'error');
      } else {
        // Mutate the local series object so the new path renders without
        // a full reload. The parent list will refresh on next poll.
        series.directory = newDir;
        setEditingDir(false);
        setEditDirValue('');
        // Auto-refresh the card. If the new directory exists with files,
        // refreshDirectory will match them. If it doesn't exist, the backend
        // returns {matched: 0} early and the next poll picks up the
        // directory_exists=false state which triggers the warning UI.
        toast(`Directory updated — refreshing…`, 'info');
        await refreshDirectory({ stopPropagation: () => {} });
      }
    } catch (err) {
      toast(`Directory save failed: ${err.message}`, 'error');
    }
    setSavingDir(false);
  };

  const createSeriesJson = async (e) => {
    e.stopPropagation();
    setCreatingJson(true);
    setJsonStatus(null);
    try {
      // Create only. Existing files are kept current by the nightly series.json
      // refresh; edits and re-linking live on the series page.
      const r = await fetch(`/api/monitor/series/${series.id}/create-series-json`, { method: 'POST' });
      const d = await r.json();
      if (d.success) setJsonStatus('ok');
      else if (d.skipped) setJsonStatus('exists');
      else setJsonStatus('error');
    } catch { setJsonStatus('error'); }
    setCreatingJson(false);
    setTimeout(() => setJsonStatus(null), 4000);
  };

  const [discoveringAnnuals, setDiscoveringAnnuals] = useState(false);
  const [annualDiscoverResult, setAnnualDiscoverResult] = useState(null);

  const discoverAnnuals = async (e) => {
    e?.stopPropagation();
    setDiscoveringAnnuals(true);
    setAnnualDiscoverResult(null);
    toast(`Searching for annuals: ${series.name}…`, 'info');
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/discover-annuals`, { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        setAnnualDiscoverResult(d);
        if (d.linked?.length) {
          toast(`Found ${d.linked.length} annual volume(s) for ${series.name}`, 'success');
          // Refresh the issue list so annuals appear
          const ir = await fetch(`/api/monitor/series/${series.id}/issues`);
          const id = await ir.json();
          setIssues(id.issues || []);
          setAnnuals(id.annuals || []);
        } else {
          toast(`No new annuals found for ${series.name}`, 'info');
        }
      } else {
        toast(`Annual discovery failed: ${d.error}`, 'error');
      }
    } catch (err) {
      toast(`Annual discovery failed: ${err.message}`, 'error');
    }
    setDiscoveringAnnuals(false);
    setTimeout(() => setAnnualDiscoverResult(null), 6000);
  };

  const openPackSearch = (e) => {
    e.stopPropagation();
    // Pre-fill with series name (loose)
    const stopWords = new Set(['the','a','an','of','in','on','at','to','for','and','or','new','all']);
    const loose = stripPunctKeepInitials(series.name)
      .replace(/\s+/g, ' ').trim()
      .split(' ').filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()))
      .slice(0, 4).join(' ');
    setPackQuery(loose);
    setPackResults([]);
    setPackGrabbed(false);
    setPackOpen(p => !p);
  };

  const searchGc = async (q) => {
    if (!q.trim()) return;
    setGcSearching(true);
    setGcNote(null);
    setGcResults([]);
    try {
      const r = await fetch(`/api/getcomics/search?q=${encodeURIComponent(q.trim())}`);
      const d = await r.json();
      setGcResults(Array.isArray(d) ? d : []);
      setGcNote(sourceOutcome('GetComics', { status: 'fulfilled', value: d }, Array.isArray(d) ? d : []));
    } catch { setGcNote({ name: 'GetComics', ok: false, text: 'could not be reached' }); }
    setGcSearching(false);
  };

  const fetchGcLinks = async (pageUrl) => {
    setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: true, links: [] } }));
    try {
      const r = await fetch(`/api/getcomics/links?url=${encodeURIComponent(pageUrl)}`);
      const d = await r.json();
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: d.links || [] } }));
    } catch {
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: [] } }));
    }
  };

  const grabGc = async (downloadUrl, filename) => {
    setGcDownloading(prev => ({ ...prev, [downloadUrl]: true }));
    try {
      const r = await fetch('/api/getcomics/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId: series.id, downloadUrl, filename }),
      });
      if (!r.ok) {   // e.g. an address that is not on the public internet (2026-11-12)
        const d = await r.json().catch(() => ({}));
        setGcDownloading(prev => ({ ...prev, [downloadUrl]: 'error' }));
        toast(d.error ? `Pack download failed to start: ${d.error}` : 'Pack download failed to start', 'error');
        return;
      }
      setGcDownloading(prev => ({ ...prev, [downloadUrl]: 'done' }));
      toast('Pack download started — watch progress bottom-left', 'success');
    } catch {
      setGcDownloading(prev => ({ ...prev, [downloadUrl]: 'error' }));
      toast('Pack download failed to start', 'error');
    }
  };

  const searchPack = async (q) => {
    if (!q.trim()) return;
    setPackSearching(true);
    setPackNote(null);
    try {
      const r = await fetch(`/api/prowlarr/search-classified?q=${encodeURIComponent(q.trim())}`);
      const d = await r.json();
      // Sort: packs first (by packScore desc), then by size desc within each group
      const sorted = Array.isArray(d) ? [...d].sort((a, b) =>
        b.packScore - a.packScore || (b.size || 0) - (a.size || 0)
      ).slice(0, 25) : [];
      setPackResults(sorted);
      setPackNote(sourceOutcome('Prowlarr', { status: 'fulfilled', value: d }, Array.isArray(d) ? d : []));
    } catch { setPackNote({ name: 'Prowlarr', ok: false, text: 'could not be reached' }); }
    setPackSearching(false);
  };

  const grabPack = async (result) => {
    setPackGrabbing(true);
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/grab-pack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.downloadUrl, name: result.title }),
      });
      const d = await r.json();
      if (d.success) { setPackGrabbed(true); setPackOpen(false); }
    } catch {}
    setPackGrabbing(false);
  };

  const searchNyaa = async (q) => {
    if (!q.trim()) return;
    setNyaaSearching(true);
    setNyaaResults([]);
    try {
      const r = await fetch(`/api/nyaa/search?q=${encodeURIComponent(q.trim())}`);
      const d = await r.json();
      setNyaaResults(Array.isArray(d.results) ? d.results : []);
    } catch {}
    setNyaaSearching(false);
  };

  const grabNyaa = async (result) => {
    setNyaaGrabbing(g => ({ ...g, [result.infoHash || result.title]: true }));
    try {
      const r = await fetch('/api/qbittorrent/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: result.magnet, torrentUrl: result.link }),
      });
      const d = await r.json();
      if (d.success) {
        setNyaaGrabbing(g => ({ ...g, [result.infoHash || result.title]: 'done' }));
        toast(`Sent to qBittorrent: ${result.title}`, 'info');
      } else {
        setNyaaGrabbing(g => ({ ...g, [result.infoHash || result.title]: 'error' }));
        toast(`qBittorrent error: ${d.error}`, 'error');
      }
    } catch (e) {
      setNyaaGrabbing(g => ({ ...g, [result.infoHash || result.title]: 'error' }));
      toast(`Error: ${e.message}`, 'error');
    }
  };

  const have = series.have_count || 0;
  const total = series.total_tracked || series.total_issues || 0;
  const pct = total > 0 ? Math.round((have / total) * 100) : 0;
  const wanted = series.wanted_count || 0;
  // directory_exists is computed server-side. False = the path stored in the
  // DB doesn't exist on disk. When that happens, disable all buttons that
  // would either create files at the wrong place (auto-grab, JSON, Pack,
  // Annuals) or display data that's irrelevant when the dir is gone (file
  // paths). Keep Refresh + the inline directory edit + delete enabled so
  // the user can fix or recover.
  const dirMissing = series.directory_exists === false;

  return (
    <div className={`dm-series-card${open ? ' is-expanded' : ''}`}>
      {/* Header row */}
      <div className="dm-series-header" onClick={toggle}>
        {series.image_url && (
          <img src={series.image_url} alt="" className="dm-series-cover a-noshrink" style={{ width: 52, height: 74, objectFit: 'cover', borderRadius: 2 }} />
        )}
        <div className="a-grow a-min0">
          {/* Row 1: title + year + publisher + status badge + external links */}
          <div className="a-flex a-ai-c a-gap-8 a-wrap">
            <span className="dm-series-name a-text a-fw6 a-fs-13">{series.name}</span>
            <span className="a-faint a-fs-12">{series.year}</span>
            {series.publisher && <span className="a-faint a-fs-11">{series.publisher}</span>}
            {series.series_status === 'ongoing' && (
              <span className="a-fs-10 a-ok a-fw6" style={{ padding: '1px 6px', borderRadius: 10, background: '#0e2a1a', border: '1px solid #4caa7033', letterSpacing: '0.04em' }}>ONGOING</span>
            )}
            <ExtLink href={series.cv_volume_url} title="View on Comic Vine">CV</ExtLink>
            <ExtLink href={series.locg_series_url} title="View on League of Comic Geeks">LOCG</ExtLink>
            {series.series_status === 'ended' && (
              <span className="a-fs-10 a-faint a-fw6" style={{ padding: '1px 6px', borderRadius: 10, background: 'var(--adm-g2)', border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-base) 85%, white) 40%, transparent)', letterSpacing: '0.04em' }}>ENDED</span>
            )}
            {dirMissing && (
              <span
                className="a-fs-10 a-err a-fw6" style={{ padding: '1px 6px', borderRadius: 10, background: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 12%, transparent)', border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 35%, transparent)', letterSpacing: '0.04em' }}
                title="The directory stored in this series's settings does not exist on disk. Edit the directory below or create the folder, then click Refresh.">
                ⚠ DIRECTORY MISSING
              </span>
            )}
          </div>
          {/* Row 2: progress bar + issue count + CV date */}
          <div className="dm-series-progress a-flex a-ai-c a-gap-10 a-mt-6">
            <div className="a-grow a-ovh" style={{ maxWidth: 200, height: 3, background: 'var(--adm-g3)', borderRadius: 2, border: '1px solid var(--adm-g4)' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#4caa60' : 'var(--td-yellow)', borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
            <span className="dm-availability">{have} of {total} issues available</span>
            {wanted > 0 && <span className="dm-missing-count">{wanted} wanted</span>}
            {series.last_cv_check && (
              <span className="a-dim a-fs-10 a-nowrap" title={`CV last checked: ${series.last_cv_check}`}>
                CV {new Date(series.last_cv_check + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
          {/* Row 3: directory path (inline editable for disambiguating
              same-name same-year series, e.g. two "Old Man Logan (2016)"
              volumes that get the same suggested directory). Click pencil
              to edit, Enter or Save to commit, Esc or Cancel to abort. */}
          <div hidden={!open && !dirMissing && !editingDir} className="dm-directory a-mt-2 a-mono a-fs-10 a-muted a-breakall a-flex a-ai-c a-gap-6">
            {editingDir ? (
              <>
                <input
                  type="text"
                  value={editDirValue}
                  onChange={e => setEditDirValue(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') saveDirectoryEdit();
                    if (e.key === 'Escape') cancelEditDir();
                  }}
                  onClick={e => e.stopPropagation()}
                  autoFocus
                  disabled={savingDir}
                  className="a-grow a-mono a-fs-10 a-accent" style={{ background: 'color-mix(in srgb, var(--td-yellow) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 40%, transparent)', borderRadius: 3, padding: '2px 6px', outline: 'none' }}
                />
                <button
                  onClick={saveDirectoryEdit}
                  disabled={savingDir}
                  title="Save directory change"
                  className="a-ok a-fs-10 a-ptr" style={{ background: 'transparent', border: '1px solid #4caa6044', padding: '1px 6px', borderRadius: 3 }}>
                  {savingDir ? '…' : '✓'}
                </button>
                <button
                  onClick={cancelEditDir}
                  disabled={savingDir}
                  title="Cancel"
                  className="a-muted a-fs-10 a-ptr" style={{ background: 'transparent', border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-text) 40%, var(--om-base)) 27%, transparent)', padding: '1px 6px', borderRadius: 3 }}>
                  ✕
                </button>
              </>
            ) : (
              <>
                <span className="a-grow">{series.directory}</span>
                {isAdmin() && <button
                  onClick={startEditDir}
                  title="Edit directory path — useful when two series share a name and year (e.g. multiple Old Man Logan 2016 volumes)"
                  className="a-muted a-ptr a-fs-11" style={{ background: 'transparent', border: 'none', padding: '0 4px', lineHeight: 1 }}
                  onMouseEnter={e => e.currentTarget.style.color = '#f5c518'}
                  onMouseLeave={e => e.currentTarget.style.color = '#7a7a8a'}>
                  ✎
                </button>}
              </>
            )}
          </div>
        </div>
        <div className="dm-series-actions a-flex a-ai-c a-gap-6">
          {/* Auto-grab: only shown when there are wanted issues */}
          {wanted > 0 && (
            <button
              className="dm-download-action adm-icon-btn a-accent a-fs-11 a-flex a-ai-c a-gap-4" style={{ border: '1px solid color-mix(in srgb, var(--td-yellow) 20%, transparent)', padding: '3px 8px', opacity: dirMissing ? 0.4 : 1, cursor: dirMissing ? 'not-allowed' : 'pointer' }}
              onClick={autoGrab}
              disabled={autoGrabbing || dirMissing}
              title={dirMissing ? 'Disabled — directory missing on disk' : `Auto-grab all ${wanted} missing issues`}
            >
              <DownloadIcon /> {autoGrabbing ? 'Grabbing…' : `Download missing (${wanted})`}
            </button>
          )}
          {isAdmin() && (<>
          {/* Refresh directory — stays enabled even when directory is missing,
              so the user can re-check after creating the folder. */}
          <button
            className="adm-icon-btn a-fs-11 a-flex a-ai-c a-gap-4" style={{ color: refreshResult?.error ? 'color-mix(in srgb, var(--td-red) 75%, white)' : refreshResult ? '#4caa60' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: '1px solid var(--adm-g4)', padding: '3px 8px', opacity: refreshing ? 0.6 : 1 }}
            onClick={refreshDirectory}
            disabled={refreshing}
            title="Scan directory for manually added files and reconcile issue statuses"
          >
            {refreshing ? '…'
              : refreshResult?.error ? '✕ Refresh'
              : refreshResult ? `✓ +${refreshResult.matched} -${refreshResult.reset}`
              : '↻ Refresh'}
          </button>
          </>)}
          {/* Search pack */}
          <button
            className="adm-icon-btn a-fs-11 a-flex a-ai-c a-gap-4" style={{ color: packGrabbed ? '#4caa60' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: '1px solid var(--adm-g4)', padding: '3px 8px', opacity: dirMissing ? 0.4 : 1, cursor: dirMissing ? 'not-allowed' : 'pointer' }}
            onClick={openPackSearch}
            disabled={dirMissing}
            title={dirMissing ? 'Disabled — directory missing on disk' : 'Search for a full series pack'}
          >
            <SearchIcon /> Search packs
          </button>
          {isAdmin() && (<>
          {/* ⋯ overflow menu — secondary actions */}
          <div className="a-rel" onClick={e => e.stopPropagation()}>
            <button
              className="adm-icon-btn a-fs-13" style={{ color: overflowOpen ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', border: `1px solid ${overflowOpen ? 'color-mix(in srgb, var(--td-yellow) 27%, transparent)' : 'color-mix(in srgb, var(--om-base) 95%, white)'}`, padding: '3px 8px', lineHeight: 1 }}
              onClick={e => { e.stopPropagation(); setOverflowOpen(o => !o); }}
              title="More actions"
            >⋯</button>
            {overflowOpen && (
              <div className="a-mt-4" style={{ position: 'absolute', right: 0, top: '100%', background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, zIndex: 500, minWidth: 160, padding: '4px 0', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}
                onClick={e => e.stopPropagation()}>
          {/* File paths diagnostic */}
          <button
            className="adm-icon-btn a-fs-11" style={{ color: showPaths ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: `1px solid ${showPaths ? 'color-mix(in srgb, var(--td-yellow) 27%, transparent)' : 'color-mix(in srgb, var(--om-base) 85%, white)'}`, padding: '3px 8px', opacity: dirMissing ? 0.4 : (loadingPaths ? 0.6 : 1), cursor: dirMissing ? 'not-allowed' : 'pointer' }}
            onClick={togglePaths}
            disabled={loadingPaths || dirMissing}
            title={dirMissing ? 'Disabled — directory missing on disk' : 'Show file paths for processed issues — helps diagnose cross-directory mismatches'}
          >
            {loadingPaths ? 'Loading paths…' : 'File paths'}
          </button>

          {/* Create series.json */}
          <button
            className="adm-icon-btn a-fs-11 a-flex a-ai-c a-gap-4" style={{ color: jsonStatus === 'ok' ? '#4caa60'
                   : jsonStatus === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)'
                   : series.has_series_json ? '#4caa60'
                   : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: `1px solid ${series.has_series_json || jsonStatus === 'ok' ? '#4caa6044' : 'color-mix(in srgb, var(--om-base) 85%, white)'}`, padding: '3px 8px', opacity: dirMissing ? 0.4 : (creatingJson ? 0.6 : 1), cursor: dirMissing ? 'not-allowed' : (series.has_series_json ? 'default' : 'pointer') }}
            onClick={series.has_series_json ? undefined : createSeriesJson}
            disabled={creatingJson || dirMissing || series.has_series_json}
            title={dirMissing ? 'Disabled — directory missing on disk'
              : series.has_series_json ? 'series.json exists — refreshed automatically each week. Edit or re-link it from the series page.'
              : 'Create series.json metadata file'}
          >
            {creatingJson ? '…'
              : jsonStatus === 'ok' ? '✓ JSON'
              : jsonStatus === 'error' ? '✕ JSON'
              : series.has_series_json ? '✓ JSON'
              : '{ } JSON'}
          </button>

                <div className="dm-menu-divider" />
                {/* Annuals */}
                <button className="dm-overflow-item" onClick={() => { discoverAnnuals(); setOverflowOpen(false); }} disabled={discoveringAnnuals || dirMissing}>
                  {discoveringAnnuals ? '⏳ Discovering…' : annualDiscoverResult?.linked?.length ? `✓ ${annualDiscoverResult.linked.length} Annual(s) found` : '📅 Discover Annuals'}
                </button>
                <button className="dm-overflow-item" onClick={() => { setLinkAnnualOpen(true); setOverflowOpen(false); }} disabled={dirMissing}
                  title="When Discover Annuals misses one: link an annual volume by its Comic Vine link">
                  🔗 Link annual volume…
                </button>
                {/* Special */}
                <button className="dm-overflow-item" style={{ color: series.scanned_series_id ? '#c090e0' : 'color-mix(in srgb, var(--om-base) 80%, white)' }}
                  onClick={() => { if (series.scanned_series_id) { setMergePickerOpen(true); setOverflowOpen(false); } }}
                  disabled={!series.scanned_series_id || dirMissing}
                  title={!series.scanned_series_id ? 'No files on disk yet' : ''}>
                  ◈ Make Special of…
                </button>
                <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', margin: '4px 0' }} />
                {/* Retag All */}
                <button className="dm-overflow-item" onClick={() => { retagAll(false); setOverflowOpen(false); }} disabled={retagging || dirMissing}>
                  {retagResult ? '✓ Retagging started' : '↺ Retag All'}
                </button>
                {/* Retag Untagged */}
                <button className="dm-overflow-item" onClick={() => { retagAll(true); setOverflowOpen(false); }} disabled={retagging || dirMissing}>
                  ↺ Retag Untagged
                </button>
                <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', margin: '4px 0' }} />
                {/* Type toggle */}
                <button className="dm-overflow-item" style={{ color: series.series_type === 'manga' ? '#40aa80' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))' }}
                  onClick={() => { onTypeToggle && onTypeToggle(series.id, series.series_type === 'manga' ? 'comic' : 'manga'); setOverflowOpen(false); }}>
                  {series.series_type === 'manga' ? '🎌 Set as Comic' : '◻ Set as Manga'}
                </button>
                <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', margin: '4px 0' }} />
                {/* Remove */}
                <button className="dm-overflow-item a-err" onClick={() => { onRemove(series.id); setOverflowOpen(false); }}>
                  🗑 Remove Series
                </button>
              </div>
            )}
          </div>
          </>)}
          <button className="adm-icon-btn dm-expand" aria-label={open ? "Collapse issues" : "Expand issues"} aria-expanded={open} onClick={e => { e.stopPropagation(); toggle(); }}><ChevronDown open={open} /></button>
        </div>
      </div>

      {/* Auto-grab result banner */}
      {autoGrabResult && !autoGrabResult.error && (
        <div className="a-fs-12 a-flex a-gap-16" style={{ padding: '6px 14px', background: 'var(--adm-g1)', borderTop: '1px solid var(--adm-g3)' }}>
          <span className="a-ok">✓ {autoGrabResult.grabbed} grabbed</span>
          <span className="a-faint">{autoGrabResult.skipped} skipped (no match)</span>
          {autoGrabResult.errors > 0 && <span className="a-err">{autoGrabResult.errors} errors</span>}
          <button className="adm-icon-btn a-faint a-fs-11 a-ml-auto" onClick={() => setAutoGrabResult(null)}>✕</button>
        </div>
      )}
      {autoGrabResult?.error && (
        <div className="a-fs-12 a-err" style={{ padding: '6px 14px', background: 'var(--adm-g1)', borderTop: '1px solid var(--adm-g3)' }}>
          Auto-grab failed: {autoGrabResult.error}
          <button className="adm-icon-btn a-faint a-fs-11 a-ml-8" onClick={() => setAutoGrabResult(null)}>✕</button>
        </div>
      )}

      {/* Refresh result banner */}
      {refreshResult && !refreshResult.error && (refreshResult.matched > 0 || refreshResult.reset > 0) && (
        <div className="a-fs-12 a-flex a-gap-16 a-wrap" style={{ padding: '6px 14px', background: 'var(--adm-g1)', borderTop: '1px solid var(--adm-g3)' }}>
          {refreshResult.matched > 0 && <span className="a-ok">✓ {refreshResult.matched} newly matched</span>}
          {refreshResult.reset > 0 && <span className="a-accent">↺ {refreshResult.reset} reset (file missing)</span>}
          {refreshResult.unmatched > 0 && <span className="a-faint">{refreshResult.unmatched} unrecognised files</span>}
          <button className="adm-icon-btn a-faint a-fs-11 a-ml-auto" onClick={() => setRefreshResult(null)}>✕</button>
        </div>
      )}
      {refreshResult && !refreshResult.error && refreshResult.matched === 0 && refreshResult.reset === 0 && (
        <div className="a-fs-12 a-faint" style={{ padding: '6px 14px', background: 'var(--adm-g0)', borderTop: '1px solid var(--adm-g3)' }}>
          Directory in sync — no changes needed
          <button className="adm-icon-btn a-faint a-fs-11 a-ml-8" onClick={() => setRefreshResult(null)}>✕</button>
        </div>
      )}

      {/* File paths diagnostic panel */}
      {showPaths && pathsData && (
        <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', background: '#08080a', padding: '10px 14px' }}>
          <div className="a-flex a-ai-c a-gap-8 a-mb-8">
            <span className="a-fs-11 a-muted a-mono">{pathsData.directory}</span>
            <button className="adm-icon-btn a-faint a-fs-11 a-ml-auto" onClick={() => setShowPaths(false)}>✕</button>
          </div>
          {pathsData.issues.length === 0 ? (
            <div className="a-fs-11 a-faint">No processed issues with recorded file paths.</div>
          ) : (
            <div className="a-flex a-col a-gap-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {pathsData.issues.map(i => (
                <div key={i.issue_number} className="a-flex a-ai-c a-gap-8 a-fs-11">
                  <span className="a-faint a-ta-r a-noshrink" style={{ width: 32 }}>
                    #{i.issue_number}{i.is_annual ? ' A' : ''}
                  </span>
                  <span className="a-mono a-grow a-min0 a-nowrap a-ovh a-ellip" style={{ color: i.in_series_dir ? 'color-mix(in srgb, var(--om-text) 65%, var(--om-base))' : 'color-mix(in srgb, var(--td-red) 75%, white)' }} title={i.file_path}>
                    {i.file_path}
                  </span>
                  {!i.in_series_dir && (
                    <span className="a-err a-fs-10 a-fw7 a-noshrink">⚠ WRONG DIR</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {pathsData.issues.some(i => !i.in_series_dir) && (
            <div className="a-mt-8 a-fs-11 a-muted">
              Red entries are matched to files outside this series' directory. Hit ↻ Refresh to reset them to wanted.
            </div>
          )}
        </div>
      )}

      {/* Pack search panel */}
      {packOpen && (
        <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', background: '#08080a', padding: '10px 14px' }}>
          {/* Tabs */}
          <div className="a-flex a-gap-2 a-mb-10">
            {['prowlarr', 'getcomics', 'nyaa'].map(tab => (
              <button key={tab} onClick={() => setPackTab(tab)} className="adm-icon-btn a-fs-11 a-fw7 a-upper" style={{ padding: '3px 12px', letterSpacing: '0.06em', color: packTab === tab ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', borderBottom: packTab === tab ? '2px solid var(--td-yellow)' : '2px solid transparent', borderRadius: 0 }}>
                {tab === 'prowlarr' ? 'Prowlarr' : tab === 'getcomics' ? 'GetComics' : 'Nyaa'}
              </button>
            ))}
            <button className="adm-btn a-fs-12 a-ml-auto" style={{ padding: '3px 8px' }}
              onClick={() => setPackOpen(false)}>✕</button>
          </div>

          {/* Shared query bar */}
          <div className="a-flex a-gap-6 a-mb-8">
            <input
              className="adm-input a-fs-12 a-grow" style={{ padding: '5px 10px' }}
              value={packQuery}
              onChange={e => setPackQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (packTab === 'prowlarr' ? searchPack(packQuery) : packTab === 'getcomics' ? searchGc(packQuery) : searchNyaa(packQuery))}
              placeholder={packTab === 'prowlarr' ? 'Search Prowlarr…' : packTab === 'getcomics' ? 'Search GetComics…' : 'Search Nyaa (e.g. My Hero Academia)…'}
              autoFocus
            />
            <button
              className="adm-btn adm-btn-primary a-fs-12" style={{ padding: '5px 12px' }}
              onClick={() => packTab === 'prowlarr' ? searchPack(packQuery) : packTab === 'getcomics' ? searchGc(packQuery) : searchNyaa(packQuery)}
              disabled={packTab === 'prowlarr' ? packSearching : packTab === 'getcomics' ? gcSearching : nyaaSearching}
            >
              {(packTab === 'prowlarr' ? packSearching : packTab === 'getcomics' ? gcSearching : nyaaSearching) ? '…' : <SearchIcon />}
            </button>
          </div>

          {/* Prowlarr results */}
          {packTab === 'prowlarr' && (<>
            {packResults.map((r, i) => (
              <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                <span className="a-muted a-fs-11 a-noshrink" style={{ minWidth: 70 }}>{r.indexer}</span>
                <span className="a-fs-10 a-noshrink a-fw7" style={{ padding: '1px 5px', borderRadius: 3, background: r.looksLikePack ? 'color-mix(in srgb, var(--om-base) 95%, white)' : 'color-mix(in srgb, var(--om-base) 95%, white)', color: r.looksLikePack ? '#6caa40' : '#6060aa', border: `1px solid ${r.looksLikePack ? '#6caa4044' : '#6060aa44'}` }}>{r.looksLikePack ? '◈ pack' : '◉ single'}</span>
                <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 50 }}>{fmt(r.size)}</span>
                <button
                  className="adm-icon-btn a-ok a-fs-11 a-flex a-ai-c a-gap-4 a-noshrink" style={{ border: '1px solid #4caa6033', padding: '3px 8px' }}
                  onClick={() => grabPack(r)} disabled={packGrabbing}
                ><DownloadIcon /> Grab</button>
              </div>
            ))}
            {!packSearching && packNote && <SourceStatus items={[packNote]} />}
            {!packSearching && packResults.length === 0 && !packNote && (
              <div className="a-faint a-fs-12">Search Prowlarr for a series pack or single issues.</div>
            )}
          </>)}

          {/* GetComics results */}
          {packTab === 'getcomics' && (<>
            {gcResults.map((r, i) => {
              const linkState = gcLinks[r.url];
              return (
                <div key={i} style={{ borderBottom: '1px solid color-mix(in srgb, var(--om-base) 90%, black)', padding: '6px 0' }}>
                  <div className="a-flex a-ai-c a-gap-8">
                    {r.cover && <img src={r.cover} alt="" className="a-noshrink" style={{ width: 28, height: 40, objectFit: 'cover', borderRadius: 2 }} />}
                    <div className="a-grow a-min0">
                      <div className="a-text2 a-fs-12 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</div>
                      {r.description && <div className="a-faint a-fs-10 a-mt-2 a-ovh a-ellip a-nowrap">{r.description}</div>}
                    </div>
                    <button
                      className="adm-icon-btn a-info a-fs-11 a-noshrink" style={{ border: '1px solid #6080cc33', padding: '3px 8px' }}
                      onClick={() => !linkState && fetchGcLinks(r.url)}
                      disabled={linkState?.loading}
                    >
                      {linkState?.loading ? '…' : linkState ? '▲ Hide' : '▼ Links'}
                    </button>
                  </div>
                  {/* Download links for this result — grouped by packLabel */}
                  {linkState && !linkState.loading && linkState.links.length > 0 && (
                    <div className="a-mt-4" style={{ paddingLeft: 36 }}>
                      {(() => {
                        let lastLabel = undefined;
                        return linkState.links.map((link, j) => {
                          const dlState = gcDownloading[link.url];
                          const showHeader = link.packLabel && link.packLabel !== lastLabel;
                          if (link.packLabel) lastLabel = link.packLabel;
                          return (
                            <React.Fragment key={j}>
                              {showHeader && (
                                <div className="a-accent a-fs-10 a-fw6 a-mb-2" style={{ marginTop: j === 0 ? 2 : 8, borderBottom: '1px solid color-mix(in srgb, var(--td-yellow) 13%, transparent)', paddingBottom: 2 }}>
                                  {link.packLabel}
                                </div>
                              )}
                              <div className="a-flex a-ai-c a-gap-6" style={{ padding: '3px 0' }}>
                                <span className="a-grow a-faint a-fs-10 a-ovh a-ellip a-nowrap" title={link.url}>{link.label}</span>
                                <button
                                  className="adm-icon-btn a-fs-10 a-noshrink a-flex a-ai-c a-gap-2" style={{ padding: '2px 8px', color: dlState === 'done' ? '#4caa60' : dlState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${dlState === 'done' ? '#4caa6033' : dlState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                                  onClick={() => !dlState && grabGc(link.url, link.label)}
                                  disabled={!!dlState}
                                >
                                  <DownloadIcon />
                                  {dlState === 'done' ? ' Queued' : dlState === 'error' ? ' Error' : dlState ? ' …' : ' Grab'}
                                </button>
                              </div>
                            </React.Fragment>
                          );
                        });
                      })()}
                    </div>
                  )}
                  {linkState && !linkState.loading && linkState.links.length === 0 && (
                    <div className="a-faint a-fs-11 a-mt-4" style={{ paddingLeft: 36 }}>No direct links found — may require Mediafire/Mega.</div>
                  )}
                </div>
              );
            })}
            {!gcSearching && gcNote && <SourceStatus items={[gcNote]} />}
            {!gcSearching && gcResults.length === 0 && !gcNote && (
              <div className="a-faint a-fs-12">Search GetComics for series packs or collections.</div>
            )}
          </>)}

          {/* Nyaa results */}
          {packTab === 'nyaa' && (<>
            {nyaaResults.length > 0 && (
              <div className="a-faint a-fs-10 a-mb-6">
                {nyaaResults.filter(r => r.type === 'single').length} volumes · {nyaaResults.filter(r => r.type === 'pack').length} packs
                {nyaaResults.filter(r => r.type === 'chapter').length > 0 && ` · ${nyaaResults.filter(r => r.type === 'chapter').length} chapters (not downloadable)`}
              </div>
            )}
            {nyaaResults.filter(r => r.type !== 'chapter').map((r, i) => {
              const key = r.infoHash || r.title;
              const grabState = nyaaGrabbing[key];
              return (
                <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                  <span className="a-fs-10 a-noshrink a-fw7" style={{ padding: '1px 5px', borderRadius: 3, background: r.type === 'pack' ? 'color-mix(in srgb, var(--om-base) 95%, white)' : 'color-mix(in srgb, var(--om-base) 95%, white)', color: r.type === 'pack' ? '#6caa40' : '#40aa80', border: `1px solid ${r.type === 'pack' ? '#6caa4044' : '#40aa8044'}` }}>{r.type === 'pack' ? '◈ pack' : `◉ v${String(r.volumeNumber || '?').padStart(2,'0')}`}</span>
                  <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                  <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 50 }}>{r.size}</span>
                  <span className="a-fs-10 a-ta-r a-noshrink" style={{ color: r.seeders > 5 ? '#4caa60' : r.seeders > 0 ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', minWidth: 30 }}>↑{r.seeders}</span>
                  <button
                    className="adm-icon-btn a-fs-11 a-noshrink a-flex a-ai-c a-gap-4" style={{ padding: '3px 8px', color: grabState === 'done' ? '#4caa60' : grabState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${grabState === 'done' ? '#4caa6033' : grabState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                    onClick={() => !grabState && grabNyaa(r)}
                    disabled={!!grabState}
                  >
                    <DownloadIcon />
                    {grabState === 'done' ? ' Sent' : grabState === 'error' ? ' Error' : grabState ? ' …' : ' Grab'}
                  </button>
                </div>
              );
            })}
            {nyaaResults.filter(r => r.type === 'chapter').length > 0 && (
              <div className="a-dim a-fs-11 a-mt-8" style={{ padding: '6px 8px', background: 'var(--adm-g0)', borderRadius: 4, border: '1px solid var(--adm-g2)' }}>
                ℹ {nyaaResults.filter(r => r.type === 'chapter').length} chapter releases hidden — volume downloads only for now.
              </div>
            )}
            {!nyaaSearching && nyaaResults.length === 0 && (
              <div className="a-faint a-fs-12">Search Nyaa for manga volumes. Use the English title or Japanese romanization.</div>
            )}
          </>)}
        </div>
      )}

      {/* Issue list */}
      {open && (
        <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
          {loadingIssues && <div className="a-faint a-ta-c a-fs-12" style={{ padding: 16 }}>Loading issues…</div>}

          <div className="dm-issue-browser">
            <input className="adm-input" aria-label="Find issue number or title" placeholder="Find issue # or title…" value={issueQuery} onChange={e => setIssueQuery(e.target.value)} />
            <select className="adm-input" aria-label="Filter issue status" value={issueFilter} onChange={e => setIssueFilter(e.target.value)}>
              <option value="all">All statuses</option><option value="wanted">Wanted</option><option value="processed">Processed</option><option value="untagged">Missing metadata</option><option value="waiting">Waiting</option><option value="snatched">Downloading</option><option value="skipped">Skipped</option>
            </select>
            <select className="adm-input" aria-label="Issue order" value={issueOrder} onChange={e => setIssueOrder(e.target.value)}><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select>
            <span>{visibleIssues.length} of {issues.length} issues</span>
          </div>
          {/* Multi-select toolbar */}
          {!loadingIssues && issues.length > 0 && (
            <div className="dm-selection-toolbar a-flex a-ai-c a-gap-8 a-wrap" style={{ padding: '5px 10px', background: selectMode ? 'var(--om-base)' : 'transparent', borderBottom: selectMode ? '1px solid color-mix(in srgb, var(--om-base) 95%, white)' : 'none' }}>
              <button
                onClick={toggleSelectMode}
                className="a-fs-10 a-ptr" style={{ padding: '2px 8px', borderRadius: 3, background: selectMode ? 'color-mix(in srgb, var(--td-yellow) 13%, transparent)' : 'transparent', border: `1px solid ${selectMode ? 'color-mix(in srgb, var(--td-yellow) 40%, transparent)' : 'color-mix(in srgb, var(--om-base) 95%, white)'}`, color: selectMode ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' }}
              >{selectMode ? '✕ Cancel' : '☐ Select'}</button>
              {selectMode && <span className="a-muted a-fs-11">Shift-click to select a range</span>}

              {selectMode && selectedIssues.size > 0 && (<>
                <span className="dm-selection-count">{selectedIssues.size} selected</span>
                <button
                  onClick={() => bulkSetStatus('skipped')}
                  className="a-fs-10 a-ptr a-err" style={{ padding: '2px 8px', borderRadius: 3, background: 'var(--adm-g1)', border: '1px solid #5a1a1a' }}
                >Skip selected</button>
                <button
                  onClick={() => bulkSetStatus('wanted')}
                  className="a-fs-10 a-ptr a-ok" style={{ padding: '2px 8px', borderRadius: 3, background: 'var(--adm-g1)', border: '1px solid #1a5a1a' }}
                >Un-skip selected</button>
              </>)}

              {selectMode && (
                <button
                  onClick={() => { selectionAnchor.current = null; setSelectedIssues(new Set([...visibleIssues, ...(annualsOpen ? visibleAnnuals : [])].filter(i => i.status === 'wanted').map(i => i.id))); }}
                  className="a-fs-10 a-ptr a-faint a-ml-auto" style={{ padding: '2px 8px', borderRadius: 3, background: 'transparent', border: '1px solid var(--adm-g3)' }}
                >Select visible wanted</button>
              )}
            </div>
          )}

          {!loadingIssues && visibleIssues.length === 0 && <p className="dm-no-issues">No regular issues match these filters.</p>}
          <div className="dm-issue-column-labels" aria-hidden="true"><span>Issue · Title</span><span>Released</span><span>Status</span><span>Actions</span></div>
          <div style={selectMode ? { userSelect: 'none' } : {}}>
          {visibleIssues.map(issue => (
            <IssueRow
              key={issue.id}
              issue={{ ...issue, series_name: series.name }}
              seriesId={series.id}
              selectMode={selectMode}
              selected={selectedIssues.has(issue.id)}
              onSelect={toggleIssueSelect}
              onChanged={loadIssues}
            />
          ))}
          </div>

          {/* Annuals section */}
          {annuals.length > 0 && (
            <div style={{ borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
              <div
                className="a-flex a-ai-c a-gap-8 a-ptr" style={{ padding: '7px 12px', background: 'var(--adm-g0)' }}
                onClick={() => setAnnualsOpen(o => !o)}
              >
                <span className="a-muted a-fs-11 a-fw7 a-upper" style={{ letterSpacing: '0.08em' }}>
                  Annuals
                </span>
                <span className="a-accent a-fs-10" style={{ background: 'var(--adm-g3)', padding: '1px 6px', borderRadius: 10 }}>
                  {annuals.length}
                </span>
                <span className="a-faint a-fs-11 a-ml-auto">{annualsOpen ? '▲' : '▼'}</span>
              </div>
              {annualsOpen && visibleAnnuals.map(issue => (
                <IssueRow
                  key={issue.id}
                  issue={{ ...issue, series_name: issue._annual_series_name || series.name }}
                  seriesId={series.id}
                  selectMode={selectMode}
                  selected={selectedIssues.has(issue.id)}
                  onSelect={toggleIssueSelect}
              onChanged={loadIssues}
                />
              ))}
            </div>
          )}

          {/* Special of indicator — shown when this series has a parent */}
          {(series.parent_series_id || series.shelf_home_id) && (
            <div className="a-flex a-ai-c a-gap-6" style={{ padding: '4px 12px', background: 'var(--adm-g1)', borderTop: '1px solid #2a1a3a' }}>
              <span className="a-fs-11" style={{ color: '#c090e0' }}>◈ Special of</span>
              <span className="a-fs-11 a-fw6" style={{ color: '#c090e0' }}>
                {series._parent_name || series._shelf_home_name || series.parent_series_id || series.shelf_home_id}
              </span>
            </div>
          )}

          {/* Merge picker modal */}
          {mergePickerOpen && (
            <MergeSeriesPicker
              sourceScannedSeriesId={series.scanned_series_id}
              sourceName={series.name}
              onClose={() => setMergePickerOpen(false)}
              onMerged={() => {
                setMergePickerOpen(false);
                window.dispatchEvent(new Event('omnibus:series-updated'));
              }}
            />
          )}
        </div>
      )}
      {linkAnnualOpen && (
        <LinkAnnualModal series={series} onClose={() => setLinkAnnualOpen(false)}
          onLinked={async () => {
            setLinkAnnualOpen(false);
            try {
              const ir = await fetch(`/api/monitor/series/${series.id}/issues`);
              const d = await ir.json();
              setIssues(d.issues || []); setAnnuals(d.annuals || []);
            } catch {}
          }} />
      )}
    </div>
  );
}

// Manual annual link (2026-11-10): for an annual volume Discover Annuals does not find. The
// server looks the volume up on Comic Vine; its issues join this series' annuals as wanted
// (as a found annual) and files already in the folder are matched.
function LinkAnnualModal({ series, onClose, onLinked }) {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/monitor/series/${series.id}/link-annual`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast(`Linked ${d.annual?.name || 'the annual volume'} to ${series.name}`, 'success');
      onLinked();
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  return (
    <Modal title="🔗 Link annual volume" onClose={onClose} width={480}>
      <form className="adm-modal-content" onSubmit={submit} style={{ padding: 12 }}>
        <div className="a-faint a-fs-12 a-mb-8">For "{series.name}". Paste the annual's Comic Vine volume link (…/4050-12345/) or its number. Its issues join this series' annuals as wanted, and files already in the folder are matched.</div>
        <input autoFocus className="adm-input a-w100" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://comicvine.gamespot.com/…/4050-…/" />
        {err && <div className="a-err a-fs-12 a-mt-8">{err}</div>}
        <div className="a-flex a-gap-8 a-mt-8" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="adm-btn adm-btn-primary" disabled={busy || !url.trim()}>{busy ? 'Linking…' : 'Link'}</button>
        </div>
      </form>
    </Modal>
  );
}
