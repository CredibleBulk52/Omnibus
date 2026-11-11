import DeleteSeriesAction from '../components/DeleteSeriesAction';
import {PullButton} from '../components/PullBox';
import { useConfirm } from '../components/Confirm';
import { ErrorNote } from '../components/StateMessage';
import ComicIssueDetail from '../components/ComicIssueDetail';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import ManageMenu from '../components/ManageMenu';
import IssueCardMenu from '../components/IssueCardMenu';
import { ReidentifySeriesButton } from '../components/LibraryHealth';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useSeriesCache, isAdmin, InfoTip } from '../App';
import { reportProblem } from '../components/ReportProblem';
import MissingCover, { MissingAction } from '../components/MissingCover';
import '../requestsReports.css';
import { isOfflineSupported, isComicOffline, saveComicOffline, removeOfflineComic } from '../offlineStorage';
import AddToListModal from '../components/AddToListModal';
import FillMissingModal from '../components/FillMissingModal';
import { markSeriesRead } from './seriesReading.mjs';
import '../seriesDetail.css';
import ComicSeriesHero from '../components/ComicSeriesHero';
import { AiInfo } from '../components/AiInfo';

// ─── SaveOfflineBtn ───────────────────────────────────────────────
// Per-issue download button. Shows: 📥 (not saved) → progress → ✓ (saved) → 🗑 (on hover)
function SaveOfflineBtn({ book, seriesTitle }) {
  const confirm = useConfirm();
  const [status, setStatus]     = useState('idle'); // idle | checking | saving | saved | error
  const [progress, setProgress] = useState(null);   // { done, total }
  const supported = isOfflineSupported();

  // Check on mount if already saved
  useEffect(() => {
    if (!supported || !book?.id) return;
    setStatus('checking');
    isComicOffline(book.id).then(saved => setStatus(saved ? 'saved' : 'idle'));
  }, [book?.id, supported]);

  if (!supported) return null;
  if (status === 'checking') return null;

  async function handleSave(e) {
    e.stopPropagation();
    if (status === 'saving') return;

    if (status === 'saved') {
      // Already saved — offer to remove
      if (!(await confirm({ title: 'Remove offline copy?', message: `Remove "${book.metadata?.title || book.issue_number || 'this issue'}" from this device? It stays in your library.`, confirmLabel: 'Remove', danger: true }))) return;
      try {
        await removeOfflineComic(book.id);
        setStatus('idle');
      } catch {}
      return;
    }

    // Need pageCount — fetch from server
    let pageCount = book.media?.pagesCount || null;
    if (!pageCount) {
      try {
        const r = await fetch(`/api/books/${book.id}/pages`);
        const d = await r.json();
        pageCount = d.count;
      } catch { setStatus('error'); return; }
    }

    setStatus('saving');
    setProgress({ done: 0, total: pageCount });
    try {
      await saveComicOffline(book.id, {
        title: book.metadata?.title || `#${book.issue_number}` || book.id,
        seriesTitle: seriesTitle || '',
        issueNumber: book.issue_number,
        pageCount,
      }, (done, total) => setProgress({ done, total }));
      setStatus('saved');
    } catch (err) {
      console.error('Save offline failed:', err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
    setProgress(null);
  }

  const label = status === 'saving'
    ? (progress ? `${progress.done}/${progress.total}` : '…')
    : status === 'saved'   ? '✓'
    : status === 'error'   ? '!'
    : '📥';

  const color = status === 'saved' ? '#4caa60'
    : status === 'error' ? '#cc4444'
    : status === 'saving' ? '#f5c518'
    : '#888';

  return (
    <button
      className="issue-action-btn issue-action-btn--secondary"
      onClick={handleSave}
      title={status === 'saved' ? 'Saved offline — tap to remove' : 'Save for offline reading'}
      style={{
        color,
        borderColor: `${color}44`,
        fontSize: status === 'saving' ? 10 : 12,
        minWidth: 36,
      }}
    >
      {label}
    </button>
  );
}

const ISSUE_W = 164;
const ISSUE_H = 246;

export default function SeriesDetailComic() {
  const confirm = useConfirm();
  const [seriesPaletteStyle, setSeriesPaletteStyle] = useState({});
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { invalidate } = useSeriesCache();
  const [series, setSeries] = useState(null);
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(() => { const t = new URLSearchParams(location.search).get('tab'); return t === 'annuals' || t === 'specials' ? t : 'issues'; });   // ?tab= from search
  useEffect(() => { const t = new URLSearchParams(location.search).get('tab'); if (t === 'annuals' || t === 'specials') setTab(t); }, [id, location.search]);
  const [detailBook, setDetailBook] = useState(null);  // issue detail modal
  const [manageOpen, setManageOpen] = useState(false);
  const [markingSeries, setMarkingSeries] = useState(false);
  const [seriesReadNotice, setSeriesReadNotice] = useState('');
  const [listTarget, setListTarget] = useState(null);  // Add-to-reading-list dialog

  useEffect(() => { setManageOpen(false); setSeriesReadNotice(''); setAnnualGaps(null); setAnnualNote(null); }, [id]);

  // Annuals
  const [annuals, setAnnuals] = useState(null);       // null = not loaded yet, {} = loaded but empty
  const [annualsLoading, setAnnualsLoading] = useState(false);
  // Missing annuals (2026-11-10): from the annual volumes the folder's files, the annual links or
  // Manage › Find annuals name; Get / Request as the regular missing issues.
  const [annualGaps, setAnnualGaps] = useState(null);
  const [annualBusy, setAnnualBusy] = useState(null);
  const [annualNote, setAnnualNote] = useState(null);   // { tone, text }
  const [findingAnnuals, setFindingAnnuals] = useState(false);
  const [specials, setSpecials] = useState(null);
  const [specialsLoading, setSpecialsLoading] = useState(false);

  // Tag editing
  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [userTags, setUserTags] = useState([]);

  // JSON editor
  const [jsonEditor, setJsonEditor] = useState('');
  const [jsonSaving, setJsonSaving] = useState(false);
  const [jsonError, setJsonError] = useState('');

  // Collection modal

  // Favorite

  // Ratings & awards
  const [seriesRating, setSeriesRating] = useState(null);
  const [seriesAwards, setSeriesAwards] = useState([]);
  const [ratingFetching, setRatingFetching] = useState(false);
  const [cbrUrlInput, setCbrUrlInput] = useState('');
  const [cbrMsg, setCbrMsg] = useState('');   // result of the manual Comic Book Roundup fetch

  // CV search (Tools tab)
  const [cvQuery, setCvQuery] = useState('');
  const [cvResults, setCvResults] = useState([]);
  const [cvSearching, setCvSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [autoSearchPending, setAutoSearchPending] = useState(false);

  // Enricher
  const [enrichLog, setEnrichLog] = useState([]);
  const [enriching, setEnriching] = useState(false);
  const [enrichAi, setEnrichAi] = useState(null);   // the run's request id, for the ⓘ AI details (admins)
  const [forceRescanning, setForceRescanning] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const logRef = useRef(null);

  // Creator scraping
  const [scraping, setScraping]       = useState(false);
  const [scrapeResult, setScrapeResult] = useState(null);

  // Issue selection (bulk actions)
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [batchWorking, setBatchWorking] = useState(false);
  const [batchLog, setBatchLog] = useState([]);
  const [showBatchLog, setShowBatchLog] = useState(false);

  // ─── Current book (bookmark target) ─────────────────────────────
  // The "current" issue is: highest in-progress book, OR if none,
  // the first unread book after the last completed one.
  const currentBookId = React.useMemo(() => {
    if (!books.length) return null;
    // In-progress takes priority
    const inProgress = books.filter(b => b.readProgress && !b.readProgress.completed && b.readProgress.page > 0);
    if (inProgress.length) return inProgress[inProgress.length - 1].id;
    // Find the first unread after the last completed
    const lastCompletedIdx = books.reduce((acc, b, i) => b.readProgress?.completed ? i : acc, -1);
    const nextIdx = lastCompletedIdx + 1;
    if (nextIdx < books.length) return books[nextIdx].id;
    return null;
  }, [books]);

  // ─── Missing issues (2026-10-28, claude/REQUESTS_AND_REPORTS.md) ───────
  // The issues of this series' Comic Vine volume that are not in the library,
  // shown on the shelf like reading lists' "Not in library" covers. Users who
  // may download get them; others request them. Long gap lists start folded.
  const GAPS_INLINE = 40;
  const [gaps, setGaps] = useState(null);
  const [gapBusy, setGapBusy] = useState(null);
  const [gapError, setGapError] = useState('');
  const [gapsShown, setGapsShown] = useState(() => { try { return localStorage.getItem('omnibus.series.gaps') || 'auto'; } catch { return 'auto'; } });
  const setGapsMode = mode => { setGapsShown(mode); try { localStorage.setItem('omnibus.series.gaps', mode); } catch {} };
  useEffect(() => {
    let live = true; setGaps(null); setGapError('');
    fetch(`/api/series/${id}/gaps`).then(r => r.json()).then(d => { if (live) setGaps(d && Array.isArray(d.rows) ? d : { rows: [] }); })
      .catch(() => { if (live) setGaps({ rows: [] }); });
    return () => { live = false; };
  }, [id]);
  const gapAct = async (g, action) => {
    setGapBusy(g.id); setGapError('');
    try {
      // Get: the Fill missing path. Request: the shared request service (as lists, events and runs).
      const r = action === 'get'
        ? await fetch(`/api/series/${id}/gaps/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueIds: [g.id] }) })
        : await fetch(`/api/requests/series/${id}/issues/${g.id}/request`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'That did not work');
      setGaps(prev => ({ ...prev, rows: prev.rows.map(x => x.id !== g.id ? x : action === 'get' ? { ...x, state: 'wanted' } : { ...x, request: 'open' }) }));
    } catch (e) { setGapError(e.message); }
    setGapBusy(null);
  };
  const getAllGaps = async () => {
    const ids = (gaps?.rows || []).filter(g => g.state === 'missing' && !g.unreleased).map(g => g.id);
    if (!ids.length) return;
    if (!(await confirm({ title: 'Get all missing issues?', message: `Download the ${ids.length} missing issue${ids.length === 1 ? '' : 's'} of this series into its folder?`, confirmLabel: 'Get them' }))) return;
    setGapBusy('all'); setGapError('');
    try {
      const r = await fetch(`/api/series/${id}/gaps/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueIds: ids }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'That did not work');
      const set = new Set(ids);
      setGaps(prev => ({ ...prev, rows: prev.rows.map(x => set.has(x.id) ? { ...x, state: 'wanted' } : x) }));
    } catch (e) { setGapError(e.message); }
    setGapBusy(null);
  };

  // ─── Load ───────────────────────────────────────────────────────
  const reload = async () => {
    const [sRes, bRes] = await Promise.all([
      fetch(`/api/series/${id}`).then(r => r.json()),
      fetch(`/api/series/${id}/books`).then(r => r.json()),
    ]);
    setSeries(sRes);
    setBooks((bRes.content || []).sort((a, b) => (a.number || 0) - (b.number || 0)));
    // Load tags from dedicated table (shared across all users)
    fetch(`/api/series/${id}/tags`).then(r => r.json()).then(t => setUserTags(Array.isArray(t) ? t : [])).catch(() => {});
    // Load ratings & awards
    fetch(`/api/series/${id}/ratings`).then(r => r.json()).then(d => {
      setSeriesRating(d.rating || null);
      setSeriesAwards(d.awards || []);
    }).catch(() => {});
    setJsonEditor(sRes.seriesJson
      ? JSON.stringify({ version: '1.0.2', metadata: sRes.seriesJson }, null, 2)
      : '');
  };

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [enrichLog]);

  // Auto-search CV when navigating to tools tab with a pending query
  useEffect(() => {
    if (tab === 'tools' && autoSearchPending && cvQuery.trim()) {
      setAutoSearchPending(false);
      searchCV();
    }
  }, [tab, autoSearchPending]); // intentional: searchCV reads cvQuery from state

  // Load annuals on first visit to annuals tab
  useEffect(() => {
    if (tab !== 'annuals' || annuals !== null) return;
    setAnnualsLoading(true);
    fetch(`/api/series/${id}/annuals`)
      .then(r => r.json())
      .then(data => setAnnuals(data || {}))
      .catch(() => setAnnuals({}))
      .finally(() => setAnnualsLoading(false));
  }, [tab, id, annuals]);
  const loadAnnualGaps = useCallback(() => fetch(`/api/series/${id}/annual-gaps`).then(r => r.json())
    .then(d => setAnnualGaps(d && Array.isArray(d.rows) ? d : { rows: [], volumes: [] }))
    .catch(() => setAnnualGaps({ rows: [], volumes: [] })), [id]);
  useEffect(() => { if (tab === 'annuals' && annualGaps === null) loadAnnualGaps(); }, [tab, annualGaps, loadAnnualGaps]);
  const annualAct = async (g, action) => {
    setAnnualBusy(g ? g.id : 'all'); setAnnualNote(null);
    try {
      const ids = g ? [g.id] : (annualGaps?.rows || []).filter(x => x.state === 'missing' && !x.unreleased).map(x => x.id);
      if (!g && !(await confirm({ title: 'Get all missing annuals?', message: `Download the ${ids.length} missing annual${ids.length === 1 ? '' : 's'} into this series' folder?`, confirmLabel: 'Get them' }))) { setAnnualBusy(null); return; }
      const r = action === 'get'
        ? await fetch(`/api/series/${id}/annual-gaps/get`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueIds: ids }) })
        : await fetch(`/api/requests/series/${id}/issues/${g.id}/request`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'That did not work');
      const set = new Set(ids);
      setAnnualGaps(prev => ({ ...prev, rows: prev.rows.map(x => !set.has(x.id) ? x : action === 'get' ? { ...x, state: 'wanted' } : { ...x, request: 'open' }) }));
    } catch (e) { setAnnualNote({ tone: 'err', text: e.message }); }
    setAnnualBusy(null);
  };
  const findAnnuals = async () => {
    setManageOpen(false); setTab('annuals'); setFindingAnnuals(true);
    setAnnualNote({ tone: 'info', text: 'Looking for this series\' annuals on Comic Vine…' });
    try {
      const r = await fetch(`/api/series/${id}/find-annuals`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'That did not work');
      const names = (d.found || []).map(v => v.name || `volume ${v.id}`);
      setAnnualNote(names.length ? { tone: 'ok', text: `Found ${names.join(', ')}.` }
        : { tone: 'info', text: (d.volumes || []).length ? 'No new annual volumes found.' : 'No annual volumes found for this series.' });
      await loadAnnualGaps();
    } catch (e) { setAnnualNote({ tone: 'err', text: `Find annuals failed: ${e.message}` }); }
    setFindingAnnuals(false);
  };

  // Load specials on first visit to specials tab
  useEffect(() => {
    if (tab !== 'specials' || specials !== null) return;
    setSpecialsLoading(true);
    fetch(`/api/series/${id}/specials`)
      .then(r => r.json())
      .then(data => setSpecials(data || {}))
      .catch(() => setSpecials({}))
      .finally(() => setSpecialsLoading(false));
  }, [tab, id, specials]);

  // ─── Komga tag helpers ──────────────────────────────────────────
  const saveTags = async () => {
    const newTags = tagInput.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    await Promise.all(newTags.map(tag =>
      fetch(`/api/series/${id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
      })
    ));
    const updated = await fetch(`/api/series/${id}/tags`).then(r => r.json());
    setUserTags(Array.isArray(updated) ? updated : []);
    setTagInput(''); setEditingTags(false);
  };

  const removeTag = async (tag) => {
    await fetch(`/api/series/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    setUserTags(prev => prev.filter(t => t !== tag));
  };

  // ─── Save JSON ──────────────────────────────────────────────────
  const saveJson = async () => {
    setJsonError(''); setJsonSaving(true);
    try {
      JSON.parse(jsonEditor);
      const res = await fetch(`/api/series/${id}/series-json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: jsonEditor }),
      });
      if (!res.ok) throw new Error(await res.text());
      await reload();
      setTab('metadata');
    } catch (e) { setJsonError(e.message); }
    setJsonSaving(false);
  };

  // ─── Comic Vine search ──────────────────────────────────────────
  const searchCV = async (overrideQuery) => {
    const raw = (overrideQuery || cvQuery || '').trim();
    if (!raw) return;
    if (!overrideQuery) setCvQuery(raw);
    setCvSearching(true); setCvResults([]);
    try {
      // Case 1: input contains a CV volume URL or bare 4050-XXXXX ID
      // → skip search, fetch that volume directly
      const urlIdMatch = raw.match(/4050-(\d+)/i) || raw.match(/\/(\d{4,})\/?$/);
      const bareIdMatch = raw.match(/^(\d{4,})$/);
      const directId = urlIdMatch?.[1] || bareIdMatch?.[1];
      if (directId) {
        const r = await fetch(`/api/comicvine/volume/${directId}`);
        const d = await r.json();
        if (d.results) {
          setCvResults([d.results]);
        } else if (d.error) {
          setCvResults([]);
        }
        setCvSearching(false);
        return;
      }

      // Case 2: year appears at end of query (e.g. "The Dark Knight Returns 1986")
      // → strip year from query, use as year sort hint
      let q = raw;
      let year = series.displayYear || series.seriesJson?.year || series.metadata?.year || '';
      const yearSuffix = q.match(/\b((?:19|20)\d{2})\s*$/);
      if (yearSuffix) {
        year = yearSuffix[1];
        q = q.slice(0, yearSuffix.index).trim();
      }

      const url = `/api/comicvine/search?q=${encodeURIComponent(q)}&limit=10${year ? `&year=${year}` : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      setCvResults(d.results || []);
    } catch {}
    setCvSearching(false);
  };

  const createFromCV = async (vol) => {
    setCreating(true); setCreateError('');
    try {
      // Just send the CV volume ID — the Python script fetches everything from CV itself
      const res = await fetch(`/api/series/${id}/create-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volumeId: vol.id }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setCvResults([]);
        invalidate(null); // clear frontend series cache so shelf/list views reflect new metadata
        await reload();
        setTab('metadata');
      } else {
        setCreateError('Could not create series.json: ' + (data.error || res.statusText));
      }
    } catch (e) { setCreateError(e.message); }
    setCreating(false);
  };

  // ─── Enricher ───────────────────────────────────────────────────
  const runEnricher = async (force = false) => {
    setEnriching(true);
    setEnrichLog(['Starting enricher…\n']);
    try {
      const res = await fetch(`/api/series/${id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      setEnrichAi(res.headers.get('X-AI-Request'));
      if (res.status !== 200) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        setEnrichLog(p => [...p, `Error: ${err.error}\n`]);
        setEnriching(false);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dec.decode(value).split('\n').forEach(line => {
          if (!line.startsWith('data: ')) return;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.log) setEnrichLog(p => [...p, d.log]);
            if (d.done) {
              setEnrichLog(p => [...p, d.code === 0
                ? '\n✓ Enrichment complete!\n'
                : `\n⚠ Enricher exited with code ${d.code}\n`]);
              reload();
            }
          } catch {}
        });
      }
    } catch (e) {
      setEnrichLog(p => [...p, `Error: ${e.message}\n`]);
    }
    setEnriching(false);
  };

  // ─── Bulk selection helpers ──────────────────────────────────────
  const toggleSelect = (bookId) => setSelected(s => {
    const n = new Set(s);
    n.has(bookId) ? n.delete(bookId) : n.add(bookId);
    return n;
  });
  const selectAll = () => setSelected(new Set(books.map(b => b.id)));
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); };

  const markWholeSeriesRead = async (completed = true) => {
    if (markingSeries) return;
    setMarkingSeries(true);
    setSeriesReadNotice('');
    try {
      const count = await markSeriesRead(id, series.displayTitle || series.name, fetch, message => confirm({ title: completed ? 'Mark series as read?' : 'Mark series as unread?', message, confirmLabel: completed ? 'Mark read' : 'Mark unread' }), completed);
      if (count === null) return;
      setManageOpen(false);
      invalidate(null);
      const verb = completed ? 'read' : 'unread';
      setBooks(previous => previous.map(book => ({ ...book, readProgress: completed ? { ...book.readProgress, completed: true } : { page: 0, completed: false } })));
      setSpecials(null);
      setAnnuals(null);
      setSeriesReadNotice(count ? `Marked ${count} owned issue${count === 1 ? '' : 's'} as ${verb}.` : 'There are no owned issues in this series folder.');
      try { await reload(); } catch { setSeriesReadNotice(`Series marked as ${verb}. Refresh the page to reload its details.`); }
    } catch (error) {
      setSeriesReadNotice(`Could not mark the series as ${completed ? 'read' : 'unread'}: ${error.message}`);
    } finally { setMarkingSeries(false); }
  };

  // One issue marked read or unread from its ⋮ menu: update whichever shelf shows it.
  const issueLabel = book => `${series?.name || ''} #${book.issue_number || ''}`.trim();
  const issueReadChanged = (bookId, completed) => {
    const upd = b => (b.id === bookId ? { ...b, readProgress: completed ? { ...b.readProgress, completed: true } : { page: 0, completed: false } } : b);
    setBooks(prev => prev.map(upd));
    setAnnuals(prev => (prev?.books ? { ...prev, books: prev.books.map(upd) } : prev));
    setSpecials(prev => (prev?.books ? { ...prev, books: prev.books.map(upd) } : prev));
  };

  const batchMarkRead = async (completed) => {
    if (!selected.size) return;
    setBatchWorking(true);
    await fetch('/api/books/batch/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: [...selected], completed }),
    });
    setBatchWorking(false);
    clearSelection();
    reload();
  };

  const batchDelete = async () => {
    if (!selected.size) return;
    if (!(await confirm({ title: 'Delete issue files?', message: `Permanently delete ${selected.size} issue file${selected.size > 1 ? 's' : ''} from disk? This cannot be undone.`, confirmLabel: 'Delete files', danger: true }))) return;
    setBatchWorking(true);
    const r = await fetch('/api/books/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: [...selected] }),
    }).then(r => r.json());
    setBatchWorking(false);
    clearSelection();
    if (r.errors?.length) setSeriesReadNotice(`${r.deleted.length} deleted, ${r.errors.length} could not be deleted.`);
    reload();
  };

  const batchRetag = async () => {
    if (!selected.size) return;
    setBatchWorking(true);
    setBatchLog([]);
    setShowBatchLog(true);
    const res = await fetch('/api/books/batch/retag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: [...selected] }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      dec.decode(value).split('\n').forEach(line => {
        if (!line.startsWith('data: ')) return;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.log) setBatchLog(p => [...p, d.log]);
          if (d.done) { clearSelection(); reload(); }
        } catch {}
      });
    }
    setBatchWorking(false);
  };

  // ─── Add to collection ──────────────────────────────────────────
  // ─── Render ─────────────────────────────────────────────────────
  if (loading) return <div className="loading"><div className="spinner" /><span>Loading series...</span></div>;
  if (!series) return (
    <div className="empty-state">
      <div className="empty-title">Series not found</div>
      <button className="btn btn-secondary" onClick={() => navigate(-1)}>Go Back</button>
    </div>
  );

  const readingBook = books.find(book => book.id === currentBookId) || books[0];
  const resuming = !!(readingBook?.readProgress?.page > 0 && !readingBook.readProgress.completed);
  const title   = series.displayTitle || series.metadata?.title || series.name;
  // For CV searches: strip year suffix and any parens — CV search doesn't handle them well.
  // Original script searches plain name or "name year" (no parens), so we do the same.
  const cvTitle = (series.seriesJson?.name || series.metadata?.title || series.name || '')
    .replace(/\s*\(\d{4}(-\d{4})?\)\s*/, ' ').replace(/\s+/g, ' ').trim();
  const m       = series.seriesJson || {};
  const hasJson = !!series.seriesJson;

  // Shelf: owned books with missing-issue placeholders between them, by issue number.
  const gapRows = gaps?.rows || [];
  const showGaps = gapRows.length > 0 && (gapsShown === 'show' || (gapsShown === 'auto' && gapRows.length <= GAPS_INLINE));
  const numKey = n => { const f = parseFloat(String(n ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(f) ? f : Infinity; };
  const shelfItems = showGaps
    ? [...books.map((book, k) => ({ book, key: numKey(book.issue_number ?? book.number), k })), ...gapRows.map((gap, k) => ({ gap, key: numKey(gap.number), k: books.length + k }))]
        .sort((a, b) => (a.key - b.key) || (a.k - b.k))
    : books.map(book => ({ book }));
  const renderGap = g => {
    const today = new Date().toISOString().slice(0, 10);
    const label = g.unreleased ? `Out ${g.date && g.date > today ? g.date : 'soon'}`
      : g.state === 'wanted' ? 'Wanted' : g.request === 'open' ? 'Requested' : g.request === 'added' ? 'Request accepted'
      : g.request === 'dismissed' ? 'Request declined' : 'Not in library';
    const stateKey = g.state === 'wanted' ? 'wanted' : g.request === 'open' ? 'open' : 'missing';
    const canAct = g.state === 'missing' && !g.unreleased;
    return (
      <div key={`gap-${g.id}`} className="issue-book issue-book--missing" style={{ width: ISSUE_W }}>
        <div className="issue-cover" style={{ width: ISSUE_W, height: ISSUE_H }}>
          <MissingCover number={g.number} image={g.image} label={label} tone={stateKey === 'open' ? 'requested' : stateKey}
            actions={canAct && (gaps.can_download || !g.request || g.request === 'dismissed')
              ? <MissingAction disabled={gapBusy === g.id} onClick={() => gapAct(g, gaps.can_download ? 'get' : 'request')}>
                  {gapBusy === g.id ? '…' : gaps.can_download ? '⬇ Get' : '✉ Request'}
                </MissingAction>
              : null} />
        </div>
        <div className="issue-number">#{g.number}</div>
        <div className="issue-title">{g.title || ''}</div>
      </div>
    );
  };

  const renderAnnualGap = g => {
    const today = new Date().toISOString().slice(0, 10);
    const label = g.unreleased ? `Out ${g.date && g.date > today ? g.date : 'soon'}`
      : g.state === 'wanted' ? 'Wanted' : g.request === 'open' ? 'Requested' : g.request === 'added' ? 'Request accepted'
      : g.request === 'dismissed' ? 'Request declined' : 'Not in library';
    const stateKey = g.state === 'wanted' ? 'wanted' : g.request === 'open' ? 'open' : 'missing';
    const canAct = g.state === 'missing' && !g.unreleased;
    const dl = annualGaps?.can_download;
    return (
      <div key={`agap-${g.id}`} className="issue-book issue-book--missing" style={{ width: ISSUE_W }}>
        <div className="issue-cover" style={{ width: ISSUE_W, height: ISSUE_H }}>
          <MissingCover number={g.number} image={g.image} label={label} tone={stateKey === 'open' ? 'requested' : stateKey}
            actions={canAct && (dl || !g.request || g.request === 'dismissed')
              ? <MissingAction disabled={annualBusy === g.id} onClick={() => annualAct(g, dl ? 'get' : 'request')}>
                  {annualBusy === g.id ? '…' : dl ? '⬇ Get' : '✉ Request'}
                </MissingAction>
              : null} />
        </div>
        <div className="issue-number">#{g.number}</div>
        <div className="issue-title" title={g.title || ''}>{g.volume_name || ''}{g.date ? ` (${String(g.date).slice(0, 4)})` : ''}</div>
      </div>
    );
  };

  const publisher  = m.publisher || series.metadata?.publisher;
  const era        = series.displayEra;
  const description = m.description_text || series.metadata?.summary;
  const genres     = m.genres || series.metadata?.genres || [];
  const characters = series.displayCharacters || [];
  const pubRun     = m.publication_run;
  const year       = m.year;
  const totalIssues = m.total_issues || series.booksCount;
  const status     = m.status || series.metadata?.status;
  // userTags lives in state, loaded from DB

  // Deduplicate creators from booksMetadata
  const authorMap = {};
  (series.booksMetadata?.authors || []).forEach(a => {
    if (!authorMap[a.role]) authorMap[a.role] = new Set();
    authorMap[a.role].add(a.name);
  });
  const writers     = [...(authorMap['writer']    || [])].slice(0, 5);
  const pencillers  = [...(authorMap['penciller'] || [])].slice(0, 5);
  const inkers      = [...(authorMap['inker']     || [])].slice(0, 4);
  const colorists   = [...(authorMap['colorist']  || [])].slice(0, 4);
  const coverArt    = [...(authorMap['cover']     || [])].slice(0, 3);

  const seriesBadges = (<>
            {/* Award badges + CBR rating */}
            {(seriesAwards.length > 0 || seriesRating) && (
              <div className="a-flex a-wrap a-gap-6 a-mt-10 a-ai-c">
                {/* Deduplicated award badges: group by award+winner, pick highest year */}
                {(() => {
                  // Group: key = award+winner, value = max year entry
                  const grouped = {};
                  for (const a of seriesAwards) {
                    const k = `${a.award}-${a.winner}`;
                    if (!grouped[k] || a.year > grouped[k].year) grouped[k] = a;
                  }
                  return Object.values(grouped).sort((a,b) => {
                    // winners before nominees, eisner before harvey
                    if (b.winner !== a.winner) return b.winner - a.winner;
                    if (a.award !== b.award) return a.award.localeCompare(b.award);
                    return b.year - a.year;
                  }).map((a, i) => {
                    const isEisner = a.award === 'eisner';
                    const isWinner = a.winner === 1;
                    const label = isEisner ? 'Eisner' : 'Harvey';
                    const sublabel = isWinner ? `Winner` : `Nominee`;
                    // Count how many wins/nominations total
                    const totalForType = seriesAwards.filter(x => x.award === a.award && x.winner === a.winner).length;
                    return (
                      <span key={i} className={`award-badge award-badge--${a.award} ${isWinner ? 'award-badge--winner' : 'award-badge--nominee'}`}
                        title={seriesAwards.filter(x=>x.award===a.award && x.winner===a.winner).map(x=>`${x.year} ${x.category}`).join('\n')}>
                        <span className="award-badge__icon">{isEisner ? '🏆' : '🥇'}</span>
                        <span className="award-badge__text">
                          <span className="award-badge__name">{label}</span>
                          <span className="award-badge__sub">{sublabel}{totalForType > 1 ? ` ×${totalForType}` : ''}</span>
                        </span>
                      </span>
                    );
                  });
                })()}
                {/* CBR critic rating badge */}
                {seriesRating && seriesRating.cbr_score != null && (
                  <a href={seriesRating.cbr_url} target="_blank" rel="noopener noreferrer"
                    className="award-badge award-badge--cbr"
                    title={`${seriesRating.cbr_count || 0} critic review${seriesRating.cbr_count !== 1 ? 's' : ''} on Comic Book Roundup`}>
                    <span className="award-badge__icon">★</span>
                    <span className="award-badge__text">
                      <span className="award-badge__name">{seriesRating.cbr_score.toFixed(1)}</span>
                      <span className="award-badge__sub">Critics{seriesRating.cbr_count ? ` · ${seriesRating.cbr_count}` : ''}</span>
                    </span>
                  </a>
                )}
                {/* CBR user rating badge */}
                {seriesRating && seriesRating.user_score != null && (
                  <a href={seriesRating.cbr_url} target="_blank" rel="noopener noreferrer"
                    className="award-badge award-badge--cbr csh-reader-score"
                    style={{ background: 'rgba(74,140,204,0.15)', borderColor: 'rgba(74,140,204,0.4)' }}
                    title={`${seriesRating.user_count || 0} user rating${seriesRating.user_count !== 1 ? 's' : ''} on Comic Book Roundup`}>
                    <span className="award-badge__icon">👤</span>
                    <span className="award-badge__text">
                      <span className="award-badge__name">{seriesRating.user_score.toFixed(1)}</span>
                      <span className="award-badge__sub">Readers{seriesRating.user_count ? ` · ${seriesRating.user_count}` : ''}</span>
                    </span>
                  </a>
                )}
                {/* Fetch rating button (admin only, no score yet) */}
                {isAdmin() && (!seriesRating || (seriesRating.cbr_score == null && seriesRating.user_score == null)) && (
                  <button className="award-badge award-badge--fetch" disabled={ratingFetching}
                    onClick={async () => {
                      setRatingFetching(true);
                      try {
                        const r = await fetch(`/api/series/${id}/ratings/fetch`, { method:'POST' });
                        const d = await r.json();
                        if (d.ok && d.rating) setSeriesRating({ cbr_score: d.rating.score, cbr_count: d.rating.count, cbr_url: d.rating.url, user_score: d.rating.userScore ?? null, user_count: d.rating.userCount ?? null });
                      } finally { setRatingFetching(false); }
                    }}>
                    <span className="award-badge__icon">★</span>
                    <span className="award-badge__text">
                      <span className="award-badge__name">{ratingFetching ? 'Fetching…' : 'Get CBR Score'}</span>
                    </span>
                  </button>
                )}
              </div>
            )}
            {seriesAwards.length === 0 && (!seriesRating || (seriesRating.cbr_score == null && seriesRating.user_score == null)) && isAdmin() && (
              <div className="a-mt-8">
                <button className="award-badge award-badge--fetch" disabled={ratingFetching}
                  onClick={async () => {
                    setRatingFetching(true);
                    try {
                      const r = await fetch(`/api/series/${id}/ratings/fetch`, { method:'POST' });
                      const d = await r.json();
                      if (d.ok && d.rating) setSeriesRating({ cbr_score: d.rating.score, cbr_count: d.rating.count, cbr_url: d.rating.url, user_score: d.rating.userScore ?? null, user_count: d.rating.userCount ?? null });
                    } finally { setRatingFetching(false); }
                  }}>
                  <span className="award-badge__icon">★</span>
                  <span className="award-badge__text">
                    <span className="award-badge__name">{ratingFetching ? 'Fetching…' : 'Get CBR Score'}</span>
                  </span>
                </button>
              </div>
            )}

  </>);

  return (
    <div className="series-detail-page series-detail-comic" style={{ ...seriesPaletteStyle, minHeight: '100vh', background: 'var(--bg-base)' }}>

      {/* ── Hero ── */}
      <ComicSeriesHero
        onPalette={setSeriesPaletteStyle}
        id={id} title={title} publisher={publisher} era={era} year={year} pubRun={pubRun}
        status={status} totalIssues={totalIssues} owned={books.length} readCount={books.filter(book => book.readProgress?.completed).length} unread={series.booksUnreadCount || 0}
        genres={genres} userTags={userTags} description={description} badges={seriesBadges}
        readingBook={readingBook} resuming={resuming}
        resumeLabel={resuming ? `▶ Resume #${readingBook?.issue_number || readingBook?.metadata?.number || '—'}` : currentBookId && currentBookId !== books[0]?.id ? `▶ Start #${readingBook?.issue_number || readingBook?.metadata?.number || '—'}` : '▶ Read First Issue'}
        onRead={() => readingBook && navigate(`/read/${readingBook.id}`)} onDetails={() => setTab('metadata')}
        onReadFirst={books.length > 0 && (resuming || currentBookId !== books[0]?.id) ? () => navigate(`/read/${books[0].id}`) : undefined}
        tabs={(
<div className="series-tabs">
      <div className="series-tabs-list">
        <button className={`series-tab ${tab==='issues'?'active':''}`} onClick={() => setTab('issues')}>
          Issues ({books.length})
        </button>
        <button className={`series-tab ${tab==='annuals'?'active':''}`} onClick={() => setTab('annuals')}>
          Annuals{annuals?.books?.length > 0 ? ` (${annuals.books.length})` : ''}
        </button>
        <button className={`series-tab ${tab==='specials'?'active':''}`} onClick={() => setTab('specials')}>
          Specials{specials?.books?.length > 0 ? ` (${specials.books.length})` : ''}
        </button>
        <button className={`series-tab ${tab==='metadata'?'active':''}`} onClick={() => setTab('metadata')}>
          Details <InfoTip text="Series details: publisher, era, genres, characters, creators and the full description." position="bottom" />
        </button>
        {['tools', 'json'].includes(tab) && <button className="series-tab active" onClick={() => setTab(tab)}>{tab === 'json' ? 'Edit JSON' : 'Metadata tools'}</button>}
      </div>
      {/* Manage (reading tools for everyone, admin tools for admins) at the right end of the tab rail. */}
      <div className="series-tabs-tools">
              <ManageMenu id="series-manage-panel" className="series-manage-menu" open={manageOpen} setOpen={setManageOpen} width={320}>
                  <div className="manage-menu-label">Reading</div>
                  <button className="btn btn-ghost" disabled={markingSeries || batchWorking} onClick={() => markWholeSeriesRead(true)}>{markingSeries ? 'Updating…' : '✓ Mark all as read'}</button>
                  <button className="btn btn-ghost" disabled={markingSeries || batchWorking} onClick={() => markWholeSeriesRead(false)}
                    title="Clears your reading progress for every issue in this series folder">↺ Mark all as unread</button>
                  <button className="btn btn-ghost" onClick={() => { setSelectMode(true); setTab('issues'); setManageOpen(false); }}>☐ Select issues</button>
                  <div className="manage-menu-label">Help</div>
                  <button className="btn btn-ghost" onClick={() => { setManageOpen(false); reportProblem({ type: 'series', id, label: title, kinds: ['metadata', 'file', 'other'] }); }}>⚑ Report a problem</button>
                  {isAdmin() && <div className="manage-menu-label">Admin · Maintenance</div>}
              {isAdmin() && <button
                className="btn btn-ghost"
                disabled={forceRescanning}
                title="Bypass smart-rescan, re-read this series from disk, and regenerate thumbnails for all books"
                onClick={async () => {
                  setForceRescanning(true);
                  try {
                    await fetch(`/api/series/${id}/force-rescan?thumbs=1`, { method: 'POST' });
                    setTimeout(() => window.location.reload(), 4000);
                  } catch {}
                  setTimeout(() => setForceRescanning(false), 5000);
                }}
              >
                {forceRescanning ? '⏳ Rescanning…' : '↺ Rescan'}
              </button>}
              {isAdmin() && <ReidentifySeriesButton seriesId={id} />}
              {isAdmin() && hasJson && <button className="btn btn-ghost" disabled={findingAnnuals}
                title="Search Comic Vine for this series' annual volumes (an AI check confirms them); missing annuals then show on the Annuals tab"
                onClick={findAnnuals}>{findingAnnuals ? '⏳ Finding annuals…' : '◈ Find annuals'}</button>}
              {isAdmin() && hasJson && <button className="btn btn-ghost"
                title="Download the issues of this series you don't own yet. Uses the normal download flow and files them into this folder."
                onClick={() => { setManageOpen(false); setFillOpen(true); }}>⬇ Fill Missing</button>}
                  {isAdmin() && <>
                    <button className="btn btn-ghost" onClick={() => { setTab('tools'); setManageOpen(false); }}>{hasJson ? 'Enrich metadata' : 'Create metadata'}</button>
                    <button className="btn btn-ghost" onClick={() => { setTab('json'); setManageOpen(false); }}>Edit JSON</button>
                    <div className="manage-menu-label">Folder location</div>
                    <div className="series-manage-location"><DiskLocation seriesId={id} /></div>
                    <DeleteSeriesAction id={id} name={series.name} onDeleted={()=>{invalidate(null);navigate('/series');}}/>
                  </>}
              </ManageMenu>
      </div>
      </div>
        )}
        notice={seriesReadNotice}
        actions={<PullButton key={id} seriesId={id} status={status} name={series?.displayTitle || series?.name}>
          <button className="order-list-button" onClick={() => setListTarget({ kind: 'series', seriesId: id, label: series?.name })}>+ Add to a box</button>
        </PullButton>}
        bulkActions={selectMode ? (
<div className="series-bulk-actions">
                  <span className="a-fs-12 a-accent" style={{ padding: '6px 4px' }}>{selected.size} selected</span>
                  <button className="btn btn-ghost" onClick={selectAll}>All</button>
                  <button className="btn btn-ghost" onClick={clearSelection}>Cancel</button>
                  {selected.size > 0 && !batchWorking && (
                    <>
                      <button className="btn btn-ghost a-ok" style={{ borderColor: 'rgba(100,180,100,0.3)' }}
                        onClick={() => batchMarkRead(true)}>✓ Read</button>
                      <button className="btn btn-ghost a-accent" style={{ borderColor: 'rgba(180,180,100,0.3)' }}
                        title="Clears reading progress for the selected issues"
                        onClick={() => batchMarkRead(false)}>↺ Unread</button>
                      <button className="btn btn-ghost a-accent" style={{ borderColor: 'color-mix(in srgb, var(--td-yellow) 35%, transparent)' }}
                        title="Add the selected issues to a reading order"
                        onClick={() => {
                          const inOrder = books.filter(b => selected.has(b.id)).map(b => b.id);
                          const rest = [...selected].filter(x => !inOrder.includes(x));
                          setListTarget({ kind: 'books', bookIds: [...inOrder, ...rest], label: series?.name });
                        }}>+ Add to a box</button>
                      {isAdmin() && (
                        <button className="btn btn-ghost a-info" style={{ borderColor: 'rgba(100,140,200,0.3)' }}
                          onClick={batchRetag}>⟳ Retag</button>
                      )}
                      {isAdmin() && (
                        <button className="btn btn-ghost a-err" style={{ borderColor: 'rgba(180,80,80,0.3)' }}
                          onClick={batchDelete}>🗑 Delete</button>
                      )}
                    </>
                  )}
                  {batchWorking && <span role="status">Working…</span>}
                </div>
        ) : null}
      />
      {/* ── Tab bodies ── */}
      <div className="series-body">

        {/* ── Issues — bookshelf layout ── */}
        {tab === 'issues' && (
          books.length === 0
            ? <div className="empty-state"><div className="empty-title">No issues found</div></div>
            : (
              <div className="issues-shelf-section">
                {/* Batch retag log */}
                {showBatchLog && batchLog.length > 0 && (
                  <div style={{ margin: '0 16px 12px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '10px 14px', maxHeight: 160, overflowY: 'auto' }}>
                    <div className="a-flex a-jc-b a-mb-6">
                      <span className="a-fs-11 a-upper" style={{ color: 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))', letterSpacing: '0.08em' }}>Retag log</span>
                      {!batchWorking && <button className="a-fs-10 a-ptr" style={{ color: 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', background: 'none', border: 'none' }} onClick={() => setShowBatchLog(false)}>✕</button>}
                    </div>
                    <pre className="a-fs-11 a-m0 a-prewrap a-mono" style={{ color: 'color-mix(in srgb, var(--om-text) 70%, var(--om-base))' }}>{batchLog.join('')}</pre>
                  </div>
                )}

                {gapRows.length > 0 && (
                  <div className="gap-toggle">
                    <span>{gapRows.length} issue{gapRows.length === 1 ? '' : 's'} not in the library</span>
                    <button type="button" onClick={() => setGapsMode(showGaps ? 'hide' : 'show')}>{showGaps ? 'Hide missing' : 'Show missing'}</button>
                    {gaps.can_download && gapRows.some(g => g.state === 'missing' && !g.unreleased) && (
                      <button type="button" className="primary" disabled={gapBusy === 'all'} onClick={getAllGaps}>{gapBusy === 'all' ? 'Adding…' : '⬇ Get all missing'}</button>
                    )}
                    {gapError && <span className="a-err">{gapError}</span>}
                  </div>
                )}
                <div className="issues-bookshelf">
                  <div className="shelf-wall" style={{ padding:'16px 0 0' }}>
                    <div className="issues-books">
                      {shelfItems.map(({ book, gap }, i) => gap ? renderGap(gap) : (() => {
                        const isCurrent   = book.id === currentBookId;
                        const isCompleted = !!book.readProgress?.completed;
                        const isInProgress = book.readProgress && !isCompleted && book.readProgress.page > 0;
                        const isUnread    = !book.readProgress;
                        const pct = isInProgress && book.media?.pagesCount
                          ? (book.readProgress.page / book.media.pagesCount) * 100
                          : 0;
                        const isSelected = selected.has(book.id);
                        return (
                        <div key={book.id} className={`issue-book${isCurrent ? ' issue-book--current' : ''}`} style={{ width: ISSUE_W }}>
                          {isCurrent && <div className="issue-tagrow"><span /><span className="issue-here">▶ Reading</span></div>}
                          {/* Cover + hover overlay */}
                          <div className="issue-cover issue-cover-hoverable" style={{ width: ISSUE_W, height: ISSUE_H, outline: isSelected ? '2px solid var(--td-yellow)' : 'none', outlineOffset: 2 }}
                            onClick={selectMode ? () => toggleSelect(book.id) : undefined}>
                            <img src={`/api/books/${book.id}/thumbnail`} alt="" loading="lazy"
                              onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                            <div className="shelf-book-placeholder" style={{ display:'none' }}>◈</div>

                            {/* Selection checkbox */}
                            {selectMode && (
                              <div className="a-flex a-ai-c a-jc-c a-ptr a-fs-12 a-fw7" style={{ position: 'absolute', top: 6, left: 6, zIndex: 10, width: 18, height: 18, borderRadius: 3, border: '2px solid var(--td-yellow)', background: isSelected ? 'var(--td-yellow)' : 'rgba(0,0,0,0.6)', color: 'var(--om-base)' }}>
                                {isSelected ? '✓' : ''}
                              </div>
                            )}

                            {/* Completed tick */}
                            {isCompleted && <div className="issue-read-badge">✓</div>}

                            {/* In-progress bar */}
                            {isInProgress && (
                              <div className="issue-progress-bar" style={{ width: `${pct}%` }} />
                            )}

                            {/* Unread dot */}
                            {isUnread && !isCurrent && (
                              <div className="issue-unread-dot" />
                            )}

                            {/* Current bookmark */}
                            {isCurrent && <div className="issue-bookmark" title="Continue reading here" />}

                            {/* ⋮: read / unread, add to a reading order (2026-11-04); hidden in select mode */}
                            {!selectMode && <IssueCardMenu bookId={book.id} label={issueLabel(book)} read={isCompleted} onChanged={c => issueReadChanged(book.id, c)} />}
                            {/* Hover action overlay — hidden in select mode */}
                            {!selectMode && (
                              <div className="issue-hover-overlay">
                                <button className="issue-action-btn" onClick={() => navigate(`/read/${book.id}`)}>
                                  ▶ Read
                                </button>
                                <button className="issue-action-btn issue-action-btn--secondary" onClick={() => setDetailBook(book)}>
                                  ◈ Details
                                </button>
                                <SaveOfflineBtn book={book} seriesTitle={series?.name} />
                              </div>
                            )}
                          </div>
                          <div className="issue-number">{book.issue_number ? `#${book.issue_number}` : `#${i+1}`}</div>
                          <div className="issue-title">{book.metadata?.title||''}</div>
                        </div>
                        );
                      })())}
                    </div>
                  </div>
                  <div className="shelf-plank" />
                </div>
              </div>
            )
        )}

        {/* ── Annuals ── (owned, then missing ones: seriesAnnuals.js, 2026-11-10) */}
        {tab === 'annuals' && (() => {
          if (annualsLoading) return <div className="loading"><div className="spinner" /><span>Loading annuals…</span></div>;
          const ownedAnnuals = annuals?.books || [];
          const aRows = annualGaps?.rows || [];
          const vols = (annualGaps?.volumes || []).filter(v => v.missing > 0).map(v => v.name || `volume ${v.id}`);
          const canGetAll = annualGaps?.can_download && aRows.some(g => g.state === 'missing' && !g.unreleased);
          const note = annualNote && <div className={`a-fs-13 a-mb-8 ${annualNote.tone === 'err' ? 'a-err' : annualNote.tone === 'ok' ? 'a-ok' : 'a-muted'}`} style={{ padding: '0 16px' }}>{annualNote.text}</div>;
          const pending = annualGaps?.pending > 0 && <div className="a-fs-13 a-muted a-mt-8" style={{ padding: '0 16px' }}>Still looking up {annualGaps.pending} annual volume{annualGaps.pending === 1 ? '' : 's'} on Comic Vine; open this tab again shortly to see them.</div>;
          if (!ownedAnnuals.length && !aRows.length) return <>
            {note}
            <div className="empty-state"><div className="empty-icon">◈</div>
              <div className="empty-title">{annualGaps === null ? 'Checking for annuals…' : 'No annuals found'}</div>
              <div className="empty-subtitle">Annual issues (files with "Annual" in the filename) appear here automatically, with any of their volume you don't have yet.{isAdmin() && hasJson ? ' Manage › Find annuals searches Comic Vine for annual volumes this folder has none of.' : ''}</div></div>
            {pending}
          </>;
          return (
            <div className="issues-shelf-section">
              {note}
              {ownedAnnuals.length > 0 && (
                <div className="issues-bookshelf">
                  <div className="shelf-wall" style={{ padding:'16px 0 0' }}>
                    <div className="issues-books">
                        {annuals.books.map((book, i) => (
                          <div key={book.id} className="issue-book" style={{ width: ISSUE_W }}>
                            <div className="issue-cover issue-cover-hoverable" style={{ width: ISSUE_W, height: ISSUE_H }}>
                              <img src={`/api/books/${book.id}/thumbnail`} alt="" loading="lazy"
                                onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                              <div className="shelf-book-placeholder" style={{ display:'none' }}>◈</div>
                              {book.readProgress?.completed && <div className="issue-read-badge">✓</div>}
                              <IssueCardMenu bookId={book.id} label={issueLabel(book)} read={!!book.readProgress?.completed} onChanged={c => issueReadChanged(book.id, c)} />
                              <div className="issue-hover-overlay">
                                <button className="issue-action-btn" onClick={() => navigate(`/read/${book.id}`)}>
                                  ▶ Read
                                </button>
                                <button className="issue-action-btn issue-action-btn--secondary" onClick={() => setDetailBook(book)}>
                                  ◈ Details
                                </button>
                              </div>
                            </div>
                            <div className="issue-number">{book.issue_number ? `#${book.issue_number}` : `#${i+1}`}</div>
                            <div className="issue-title">{book.title || ''}</div>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              )}
              {aRows.length > 0 && <>
                <div className="gap-toggle">
                  <span>{aRows.length} annual{aRows.length === 1 ? '' : 's'} not in the library{vols.length ? ` · ${vols.join(', ')}` : ''}</span>
                  {canGetAll && <button type="button" className="primary" disabled={annualBusy === 'all'} onClick={() => annualAct(null, 'get')}>{annualBusy === 'all' ? 'Adding…' : '⬇ Get all missing'}</button>}
                </div>
                <div className="issues-bookshelf">
                  <div className="shelf-wall" style={{ padding:'16px 0 0' }}>
                    <div className="issues-books">{aRows.map(renderAnnualGap)}</div>
                  </div>
                </div>
              </>}
              {pending}
            </div>
          );
        })()}

        {/* ── Specials ── */}
        {tab === 'specials' && (
          specialsLoading
            ? <div className="loading"><div className="spinner" /><span>Loading specials…</span></div>
            : (!specials?.books?.length)
              ? <div className="empty-state"><div className="empty-icon">◈</div><div className="empty-title">No specials found</div><div className="empty-subtitle">Issues with "Special" or "One-Shot" in the filename appear here automatically. You can also mark any issue as a special via its Details popup.</div></div>
              : (
                <div className="issues-shelf-section">
                  <div className="issues-bookshelf">
                    <div className="shelf-wall" style={{ padding:'16px 0 0' }}>
                      <div className="issues-books">
                        {specials.books.map((book, i) => (
                          <div key={book.id} className="issue-book" style={{ width: ISSUE_W }}>
                            <div className="issue-cover issue-cover-hoverable" style={{ width: ISSUE_W, height: ISSUE_H }}>
                              <img src={`/api/books/${book.id}/thumbnail`} alt="" loading="lazy"
                                onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                              <div className="shelf-book-placeholder" style={{ display:'none' }}>◈</div>
                              {book.readProgress?.completed && <div className="issue-read-badge">✓</div>}
                              <IssueCardMenu bookId={book.id} label={issueLabel(book)} read={!!book.readProgress?.completed} onChanged={c => issueReadChanged(book.id, c)} />
                              <div className="issue-hover-overlay">
                                <button className="issue-action-btn" onClick={() => navigate(`/read/${book.id}`)}>
                                  ▶ Read
                                </button>
                                <button className="issue-action-btn issue-action-btn--secondary" onClick={() => setDetailBook(book)}>
                                  ◈ Details
                                </button>
                              </div>
                            </div>
                            <div className="issue-number">{book.issue_number ? `#${book.issue_number}` : `#${i+1}`}</div>
                            <div className="issue-title">{book.title || ''}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )
        )}

        {/* ── Metadata ── */}
        {tab === 'metadata' && (
          <div className="metadata-panel">
            {!hasJson && (
              <div className="no-json-banner">
                <span>⚠ No series.json found for this series.</span>
                {isAdmin() && <button className="adm-btn a-ml-auto"
                  onClick={() => {
                    // Pre-fill CV query with series title and auto-search
                    setCvQuery(cvTitle);
                    setAutoSearchPending(true);
                    setTab('tools');
                  }}>
                  Create Metadata →
                </button>}
              </div>
            )}

            {/* Description (also shown in hero, but full text here) */}
            <div className="series-mobile-details">{seriesBadges}</div>
            {description && (
              <div className="meta-section">
                <div className="meta-section-title">Description</div>
                <p className="meta-description">{description}</p>
              </div>
            )}

            {/* Key details */}
            {(publisher||era||year||pubRun||status||totalIssues||m.comicid) && (
              <div className="meta-section">
                <div className="meta-section-title">Details</div>
                <div className="meta-grid">
                  {publisher    && <MetaField label="Publisher"        value={publisher} />}
                  {era          && <MetaField label="Era"              value={era} highlight />}
                  {year         && <MetaField label="Year"             value={year} />}
                  {pubRun       && <MetaField label="Publication Run"  value={pubRun} />}
                  {status       && <MetaField label="Status"           value={status} />}
                  {totalIssues > 0 && <MetaField label="Total Issues" value={totalIssues} />}
                  {series.booksCount > 0 && <MetaField label="In Library" value={`${series.booksCount} issues`} />}
                  {m.comicid    && <MetaField label="Comic Vine ID"    value={m.comicid} />}
                  {m.imprint    && <MetaField label="Imprint"          value={m.imprint} />}
                  {m.age_rating && <MetaField label="Age Rating"       value={m.age_rating} />}
                  {/* External links */}
                  {(series.cv_volume_url || series.locg_series_url) && (
                    <div className="a-flex a-gap-10" style={{ gridColumn: '1 / -1', paddingTop: 4 }}>
                      {series.cv_volume_url && (
                        <a href={series.cv_volume_url} target="_blank" rel="noopener noreferrer"
                          className="a-fs-11 a-accent a-flex a-ai-c a-gap-4" style={{ textDecoration: 'none', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', borderRadius: 4, padding: '3px 8px' }}>
                          📖 Comic Vine
                        </a>
                      )}
                      {series.locg_series_url && (
                        <a href={series.locg_series_url} target="_blank" rel="noopener noreferrer"
                          className="a-fs-11 a-info a-flex a-ai-c a-gap-4" style={{ textDecoration: 'none', border: '1px solid #7aa8c944', borderRadius: 4, padding: '3px 8px' }}>
                          📋 League of Comic Geeks
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Creators */}
            {(writers.length||pencillers.length||inkers.length||colorists.length||coverArt.length) > 0 && (
              <div className="meta-section">
                <div className="meta-section-title">Creators</div>
                <div className="meta-creators">
                  {writers.length    > 0 && <CreatorGroup label="Writer"    names={writers} />}
                  {pencillers.length > 0 && <CreatorGroup label="Penciller" names={pencillers} />}
                  {inkers.length     > 0 && <CreatorGroup label="Inker"     names={inkers} />}
                  {colorists.length  > 0 && <CreatorGroup label="Colorist"  names={colorists} />}
                  {coverArt.length   > 0 && <CreatorGroup label="Cover"     names={coverArt} />}
                </div>
              </div>
            )}

            {/* Characters */}
            {characters.length > 0 && (
              <div className="meta-section">
                <div className="meta-section-title">Characters</div>
                <div className="a-flex a-wrap a-gap-6">
                  {characters.map(c => <span key={c} className="tag">{c}</span>)}
                </div>
              </div>
            )}

            {/* Genres */}
            {genres.length > 0 && (
              <div className="meta-section">
                <div className="meta-section-title">Genres</div>
                <div className="a-flex a-wrap a-gap-6">
                  {genres.map(g => <span key={g} className="tag tag-genre" style={{ opacity:0.75 }}>{g}</span>)}
                </div>
              </div>
            )}

            {/* Tags */}
            <div className="meta-section">
              <div className="meta-section-title">Tags</div>
              <div className="a-flex a-wrap a-gap-6 a-ai-c">
                {userTags.map(tag => (
                  <span key={tag} className="tag tag-user a-ptr" onClick={() => removeTag(tag)}
                    title="Click to remove">
                    {tag} ×
                  </span>
                ))}
                {editingTags ? (
                  <>
                    <input className="form-input a-fs-12"
                      style={{ padding:'3px 8px', width:200 }}
                      placeholder="tag1, tag2, ..."
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => e.key==='Enter' && saveTags()}
                      autoFocus />
                    <button className="btn btn-primary a-fs-12"
                      style={{ padding:'3px 10px' }}
                      onClick={saveTags}>Save</button>
                    <button className="btn btn-ghost"
                      style={{ padding:'3px 6px' }}
                      onClick={() => setEditingTags(false)}>×</button>
                  </>
                ) : (
                  <span className="tag a-ptr"
                    style={{ opacity:0.45, borderStyle:'dashed' }}
                    onClick={() => setEditingTags(true)}>
                    + Tag
                  </span>
                )}
              </div>
            </div>

            {isAdmin() && <div className="a-mt-20 a-flex a-gap-8">
              <button className="adm-btn" onClick={() => {
                if (!hasJson) { setCvQuery(cvTitle); setAutoSearchPending(true); setTab('tools'); }
                else setTab('tools');
              }}>
                ⚙ {hasJson ? 'Enrich with Comic Vine' : 'Search CV & Create Metadata'}
              </button>
              <button className="adm-btn adm-btn-ghost" onClick={() => setTab('json')}>
                Edit series.json
              </button>
            </div>}
          </div>
        )}

        {/* ── Tools: Create + Enrich ── */}
        {tab === 'tools' && isAdmin() && (
          <div className="metadata-panel">

            {/* ── Search Comic Vine to create series.json ── */}
            <div className="meta-section">
              <div className="meta-section-title">
                {hasJson ? 'Re-link to Comic Vine' : '1. Search Comic Vine to Create series.json'}
              </div>
              <p className="a-fs-15 a-text2 a-mb-12" style={{ lineHeight:1.7 }}>
                {hasJson
                  ? 'Search to link a different Comic Vine volume to this series. This will overwrite the existing series.json.'
                  : <>Search Comic Vine and click <strong>Use This</strong> to create a series.json.
                    The script fetches full metadata directly from Comic Vine — this takes 5–15 seconds.
                    Then use the enricher to add characters, genres, and an AI description.</>}
              </p>
              <div className="a-flex a-gap-8 a-mb-16">
                <input className="adm-input a-grow"
                  placeholder={`Search "${cvTitle}", paste a CV URL, or add a year (e.g. "${cvTitle} 1986")…`}
                  value={cvQuery}
                  onChange={e => setCvQuery(e.target.value)}
                  onKeyDown={e => e.key==='Enter' && searchCV()}
                />
                <button className="adm-btn" onClick={() => searchCV()} disabled={cvSearching}>
                  {cvSearching ? 'Searching…' : 'Search CV'}
                </button>
              </div>

              {cvSearching && (
                <div className="a-text2 a-fs-13" style={{ padding:'8px 0' }}>
                  Searching Comic Vine…
                </div>
              )}
              {!cvSearching && cvResults.length === 0 && cvQuery.trim() && !autoSearchPending && (
                <div className="a-muted a-fs-13" style={{ padding:'8px 0' }}>
                  No results found for "{cvQuery}". Try a shorter or different title.
                </div>
              )}
              {createError && <ErrorNote>{createError}</ErrorNote>}
              {cvResults.length > 0 && (
                <div className="a-flex a-col a-gap-8">
                  {cvResults.map(vol => (
                    <div key={vol.id} className="cv-result-card">
                      <div className="cv-result-cover">
                        {vol.image?.medium_url && (
                          <img src={vol.image.medium_url} alt=""
                            onError={e => { e.target.style.display='none'; }} />
                        )}
                      </div>
                      <div className="a-grow">
                        <div className="a-fw7 a-fs-15 a-text">
                          {vol.name}
                        </div>
                        <div className="a-fs-12 a-muted a-mono a-mt-2">
                          {[vol.start_year, vol.publisher?.name, vol.count_of_issues && `${vol.count_of_issues} issues`]
                            .filter(Boolean).join(' · ')}
                        </div>
                        {vol.description && (
                          <div className="a-fs-13 a-text2 a-mt-4 a-ovh" style={{ lineHeight:1.5, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>
                            {vol.description.replace(/<[^>]+>/g,'').trim()}
                          </div>
                        )}
                      </div>
                      <button className="adm-btn adm-btn-primary a-noshrink" style={{ alignSelf:'center' }}
                        onClick={() => createFromCV(vol)} disabled={creating}>
                        {creating ? 'Fetching from CV…' : 'Use This'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Scrape Creators from Issues ── */}
            <div className="meta-section">
              <div className="meta-section-title">Scrape Creators from Issues</div>
              <p className="a-fs-15 a-text2 a-mb-12" style={{ lineHeight:1.7 }}>
                Reads the <code className="a-fs-13" style={{ color:'var(--color-accent)', background:'color-mix(in srgb, var(--td-yellow) 8%, transparent)', padding:'1px 5px', borderRadius:3 }}>ComicInfo.xml</code> embedded
                in each issue and aggregates writers, pencillers, inkers, colorists, and cover artists.
                Names appearing in ≥10% of issues are saved to <code className="a-fs-13" style={{ color:'var(--color-accent)', background:'color-mix(in srgb, var(--td-yellow) 8%, transparent)', padding:'1px 5px', borderRadius:3 }}>series.json</code> and
                shown in the Details tab. Comic Vine data takes priority if the enricher has already run.
              </p>
              <div className="a-flex a-gap-8 a-ai-c a-wrap">
                <button className="adm-btn adm-btn-primary"
                  disabled={scraping}
                  onClick={async () => {
                    setScraping(true);
                    setScrapeResult(null);
                    try {
                      const r = await fetch(`/api/series/${id}/scrape-creators`, { method: 'POST' });
                      const data = await r.json();
                      setScrapeResult(data);
                      if (data.ok) reload();
                    } catch (e) {
                      setScrapeResult({ ok: false, message: e.message });
                    }
                    setScraping(false);
                  }}>
                  {scraping ? '⏳ Scraping…' : '🔍 Scrape Creators'}
                </button>
                {scrapeResult && !scraping && (
                  <button className="adm-btn adm-btn-ghost" onClick={() => setScrapeResult(null)}>Clear</button>
                )}
              </div>
              {scrapeResult && !scraping && (
                <div className="a-mt-12 a-fs-13" style={{ background:'var(--bg-elevated)', borderRadius:6, padding:'10px 14px', border:'1px solid var(--border-subtle)' }}>
                  {scrapeResult.ok ? (
                    <>
                      <div className="a-accent a-mb-6 a-fw6">
                        ✓ Scraped from {scrapeResult.totalBooks} issues (threshold: {scrapeResult.threshold}+)
                      </div>
                      {Object.entries(scrapeResult.scraped || {}).map(([role, names]) => (
                        <div key={role} className="a-mb-2 a-text2">
                          <span className="a-text a-iblock" style={{ textTransform:'capitalize', minWidth:100 }}>
                            {role.replace('_', ' ')}:
                          </span>
                          {names.join(', ')}
                        </div>
                      ))}
                      {Object.keys(scrapeResult.scraped || {}).length === 0 && (
                        <span className="a-muted">{scrapeResult.message}</span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: '#e05' }}>{scrapeResult.message || scrapeResult.error}</span>
                  )}
                </div>
              )}
            </div>

            {/* ── Enricher ── */}
            <div className="meta-section">
              <div className="meta-section-title">
                {hasJson ? '2. Enrich with Comic Vine + OpenAI' : '2. Enrich (after creating above)'}
              </div>
              <p className="a-fs-15 a-text2 a-mb-12" style={{ lineHeight:1.7 }}>
                Runs <code className="a-fs-13" style={{ color:'var(--color-accent)', background:'color-mix(in srgb, var(--td-yellow) 8%, transparent)', padding:'1px 5px', borderRadius:3 }}>enricher.py</code> to
                pull characters, creators, genres, and descriptions from Comic Vine and generate/improve
                the description with OpenAI. Uses your <code className="a-fs-13" style={{ color:'var(--color-accent)', background:'color-mix(in srgb, var(--td-yellow) 8%, transparent)', padding:'1px 5px', borderRadius:3 }}>config.yaml</code> credentials.
                {!hasJson && ' You need to create a series.json first using the search above.'}
              </p>

              <div className="a-flex a-gap-8 a-mb-16">
                <button className="adm-btn adm-btn-primary" onClick={() => runEnricher(false)}
                  disabled={enriching || !hasJson}>
                  {enriching ? '⏳ Running…' : '▶ Run Enricher'}
                </button>
                <button className="adm-btn" onClick={() => runEnricher(true)}
                  disabled={enriching || !hasJson}
                  title="Force re-enrich even if recently enriched">
                  ↺ Force Re-enrich
                </button>
                {enrichLog.length > 0 && !enriching && (
                  <button className="adm-btn adm-btn-ghost" onClick={() => setEnrichLog([])}>Clear Log</button>
                )}
                {enrichLog.length > 0 && !enriching && <AiInfo request={enrichAi} />}
              </div>

              {(enrichLog.length > 0 || enriching) && (
                <div className="enrich-log" ref={logRef}>
                  {enrichLog.map((line, i) => (
                    <div key={i} className="log-line">{line}</div>
                  ))}
                  {enriching && <div className="log-line log-cursor">■</div>}
                </div>
              )}

              {/* CBR score fetch — manual URL override */}
              {isAdmin() && (
                <div className="a-mt-24" style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                  <div className="meta-section-title a-mb-8">Comic Book Roundup Score</div>
                  <p className="a-fs-13 a-text2 a-mb-12" style={{ lineHeight: 1.6 }}>
                    Fetches critic and user scores from Comic Book Roundup.
                    Auto-detection uses the publisher and year from series.json.
                    Paste the CBR page URL below to override if auto-detection fails (an issue page is trimmed to its series page).
                  </p>
                  <div className="a-flex a-gap-8 a-ai-c a-wrap">
                    <input
                      className="a-fs-12 a-grow" style={{ padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', minWidth: 260 }}
                      placeholder="https://comicbookroundup.com/comic-books/reviews/publisher/series-name"
                      value={cbrUrlInput}
                      onChange={e => setCbrUrlInput(e.target.value)}
                    />
                    <button className="adm-btn" disabled={ratingFetching}
                      onClick={async () => {
                        setRatingFetching(true); setCbrMsg('');
                        try {
                          const body = cbrUrlInput.trim() ? JSON.stringify({ cbrUrl: cbrUrlInput.trim() }) : undefined;
                          const r = await fetch(`/api/series/${id}/ratings/fetch`, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body });
                          const d = await r.json();
                          if (d.ok && d.rating) {
                            setSeriesRating({ cbr_score: d.rating.score, cbr_count: d.rating.count, cbr_url: d.rating.url, user_score: d.rating.userScore ?? null, user_count: d.rating.userCount ?? null });
                            setCbrUrlInput(''); setCbrMsg('Scores saved.');
                          } else setCbrMsg(d.message || d.error || 'No match found on Comic Book Roundup.');
                        } catch (e) { setCbrMsg(e.message); } finally { setRatingFetching(false); }
                      }}>
                      {ratingFetching ? '⏳ Fetching…' : '★ Fetch CBR Score'}
                    </button>
                  </div>
                  {cbrMsg && <div role="status" className="a-mt-8 a-fs-12 a-text2">{cbrMsg}</div>}
                  {seriesRating && (seriesRating.cbr_score != null || seriesRating.user_score != null) && (
                    <div className="a-mt-8 a-fs-12 a-text2">
                      Currently cached:
                      {seriesRating.cbr_score != null && ` Critics ${seriesRating.cbr_score.toFixed(1)} (${seriesRating.cbr_count || 0} reviews)`}
                      {seriesRating.user_score != null && ` · Users ${seriesRating.user_score.toFixed(1)} (${seriesRating.user_count || 0} ratings)`}
                      {seriesRating.cbr_url && <> · <a href={seriesRating.cbr_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on CBR</a></>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Edit series.json ── */}
        {tab === 'json' && isAdmin() && (
          <div className="metadata-panel">
            <div className="meta-section-title">Edit series.json</div>
            <p className="a-fs-13 a-text2 a-mt-4 a-mb-16" style={{ lineHeight:1.7 }}>
              Raw JSON editor for the series.json file on disk. Changes here control all metadata
              shown throughout Omnibus — era, characters, description, genres, Comic Vine ID.
              Saving will write the file directly and clear the metadata cache.
            </p>

            {!hasJson && (
              <div className="no-json-banner a-mb-16">
                No series.json found. Use the <strong>⚙ Create Metadata</strong> tab to create one first,
                or paste JSON below to create from scratch.
              </div>
            )}

            <textarea className="json-editor"
              value={jsonEditor}
              onChange={e => setJsonEditor(e.target.value)}
              spellCheck={false}
              placeholder={`{\n  "version": "1.0.2",\n  "metadata": {\n    "type": "comicSeries",\n    "publisher": "Publisher Name",\n    "name": "Series Name",\n    "comicid": 12345,\n    "year": 2020,\n    "description_text": "...",\n    "era": "Era Name",\n    "characters": [],\n    "genres": [],\n    "status": "Ended"\n  }\n}`}
            />

            {jsonError && (
              <div className="a-fs-13 a-mt-8" style={{ color:'color-mix(in srgb, var(--td-red) 75%, white)', padding:'8px 12px', background:'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 10%, transparent)', borderRadius:4 }}>
                ⚠ {jsonError}
              </div>
            )}

            <div className="a-flex a-gap-8 a-mt-12">
              <button className="adm-btn adm-btn-primary" onClick={saveJson} disabled={jsonSaving}>
                {jsonSaving ? 'Saving…' : 'Save series.json'}
              </button>
              <button className="adm-btn adm-btn-ghost" onClick={() => {
                setJsonEditor(series.seriesJson
                  ? JSON.stringify({ version:'1.0.2', metadata:series.seriesJson }, null, 2)
                  : '');
                setJsonError('');
              }}>Reset</button>
              <button className="adm-btn adm-btn-ghost" onClick={() => setTab('metadata')}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Issue Detail Modal ── */}
      {listTarget && <AddToListModal target={listTarget} withBoxes={listTarget.kind === 'series'} onClose={() => setListTarget(null)} />}
      {fillOpen && <FillMissingModal seriesId={id} onClose={() => setFillOpen(false)} />}
      {detailBook && (
        <ComicIssueDetail seriesTitle={series?.name}
          book={detailBook}
          onClose={() => setDetailBook(null)}
          onDeleted={bookId => {
            // File deleted from disk: drop it here and reload specials/annuals.
            setDetailBook(null);
            setBooks(prev => prev.filter(b => b.id !== bookId));
            setSpecials(null); setAnnuals(null);
            invalidate(null);
          }}
          onRead={() => { setDetailBook(null); navigate(`/read/${detailBook.id}`); }}
          onTagged={async () => {
            // Refresh the list and this card from the newly written metadata.
            try {
              const bRes = await fetch(`/api/series/${id}/books`).then(r => r.json());
              const sorted = (bRes.content || []).sort((a, b) => (a.number || 0) - (b.number || 0));
              setBooks(sorted);
              setDetailBook(prev => prev ? (sorted.find(b => b.id === prev.id) || prev) : prev);
            } catch {}
          }}
          onAddToList={() => {
            const b = detailBook; setDetailBook(null);
            setListTarget({ kind: 'book', bookId: b.id, label: `${series?.name || ''} #${b.issue_number || ''}`.trim() });
          }}
          onToggleSpecial={(bookId, isSpecial) => {
            // Move book between issues/specials lists in local state
            if (isSpecial) {
              // Moved to specials — remove from books, add to specials
              setBooks(prev => prev.filter(b => b.id !== bookId));
              setSpecials(prev => prev ? { books: [...(prev.books || []), { ...detailBook, is_special: 1 }] } : null);
            } else {
              // Removed from specials — remove from specials, add back to books (re-sorted)
              setSpecials(prev => prev ? { books: (prev.books || []).filter(b => b.id !== bookId) } : null);
              setBooks(prev => [...prev, { ...detailBook, is_special: 0 }].sort((a, b) => (a.number || 0) - (b.number || 0)));
            }
            setDetailBook(prev => prev ? { ...prev, is_special: isSpecial ? 1 : 0 } : null);
          }}
        />
      )}
    </div>
  );
}

// Admin only: where this series folder / issue file is on the server, with Copy.
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
    <div className="a-flex a-ai-c a-gap-8 a-fs-12 a-muted a-min0" style={{ margin:'8px 0' }}>
      <span title="Location on disk (admin only)">📁</span>
      <code title={p} className="a-grow a-min0 a-ovh a-ellip a-nowrap" style={{ userSelect:'all' }}>{p}</code>
      {loc.exists === false && <span className="a-nowrap" style={{ color:'color-mix(in srgb, var(--td-red) 75%, white)' }}>missing on disk</span>}
      <button className="btn btn-ghost a-fs-11 a-noshrink" style={{ padding:'2px 8px' }} onClick={copy}>
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

function MetaField({ label, value, highlight }) {
  return (
    <div className="meta-field">
      <div className="meta-field-label">{label}</div>
      <div className="meta-field-value"
        style={highlight ? { color:'var(--color-accent)' } : {}}>
        {value}
      </div>
    </div>
  );
}

function CreatorGroup({ label, names }) {
  return (
    <div className="creator-group">
      <div className="creator-role">{label}</div>
      <div className="creator-names">{names.join(', ')}</div>
    </div>
  );
}

