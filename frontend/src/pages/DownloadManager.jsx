import PageHeader from '../components/PageHeader';
import ManageMenu from '../components/ManageMenu';
import '../downloadManager.css';
import { selectIssueRange } from '../utils/selectIssueRange.mjs';
import Modal from '../components/Modal';
import CoverPeek from '../components/CoverPeek';
import DownloadIssueInspector from '../components/DownloadIssueInspector';
import { browseIssues } from '../utils/browseIssues.mjs';
import { filterWeeklyIssues } from '../utils/weeklyIssues.mjs';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { InfoTip, isAdmin, authHeader } from '../App';
import DownloadQueueTab from './DownloadQueueTab';

// One search source's outcome in words, so a failed source never looks like an
// empty search (2026-11-03). res: a Promise.allSettled entry; list: its results.
const searchError = msg => (/timeout/i.test(String(msg)) ? `timed out after ${(String(msg).match(/(\d+)ms/) || [0, 45000])[1] / 1000} s` : String(msg || 'failed').slice(0, 80));
function sourceOutcome(name, res, list) {
  if (res.status === 'rejected') return { name, ok: false, text: 'could not be reached' };
  const err = res.value && !Array.isArray(res.value) && res.value.error;
  if (err) return { name, ok: false, text: searchError(err) };
  return { name, ok: true, text: `${list.length} found` };
}
function SourceStatus({ items }) {
  if (!items || !items.length) return null;
  return <div className="a-fs-11 a-faint" style={{ padding: '2px 0 6px' }} role="status">
    {items.map((x, i) => <span key={x.name}>{i > 0 && ' · '}<span className={x.ok ? (x.pending ? 'a-dim' : '') : 'a-err'}>{x.name}: {x.text}</span></span>)}
  </div>;
}

// ─── Toast system ─────────────────────────────────────────────────
// Usage: const { toast } = useToast();
//        toast('Refreshing…', 'info')   → yellow, auto-dismiss 3s
//        toast('Done', 'success')        → green, auto-dismiss 4s
//        toast('Failed', 'error')        → red, persists until dismissed

let _toastId = 0;
let _globalAddToast = null; // set by ToastProvider

export function useToast() {
  return {
    toast: (message, type = 'info', duration) => {
      if (_globalAddToast) _globalAddToast(message, type, duration);
    }
  };
}

const TOAST_COLORS = {
  success: { bg: '#0a1f0f', border: '#4caa60', color: '#4caa60', icon: '✓' },
  error:   { bg: '#1f0a0a', border: '#cc5050', color: '#cc5050', icon: '✕' },
  info:    { bg: '#111118', border: 'var(--td-yellow)', color: 'var(--td-yellow)', icon: '…' },
};
const TOAST_DURATIONS = { success: 4000, error: 0, info: 3000 };

export function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    _globalAddToast = (message, type = 'info', duration) => {
      const id = ++_toastId;
      const ms = duration ?? TOAST_DURATIONS[type] ?? 4000;
      setToasts(prev => [...prev, { id, message, type, ms }]);
      if (ms > 0) setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), ms);
    };
    return () => { _globalAddToast = null; };
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="a-flex a-col a-gap-8" style={{ position: 'fixed', bottom: window.innerWidth <= 767 ? 80 : 20, right: 20, zIndex: 9999, maxWidth: 360 }}>
      {toasts.map(t => {
        const c = TOAST_COLORS[t.type] || TOAST_COLORS.info;
        return (
          <div key={t.id} className="a-flex a-ai-s a-gap-10" style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 6, padding: '10px 14px', boxShadow: '0 4px 20px #00000088', animation: 'slideIn 0.2s ease' }}>
            <span className="a-fw7 a-fs-13" style={{ color: c.color, lineHeight: 1.4 }}>{c.icon}</span>
            <span className="a-grow a-text2 a-fs-12" style={{ lineHeight: 1.5 }}>{t.message}</span>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              className="a-faint a-ptr a-fs-13" style={{ background: 'none', border: 'none', padding: 0, lineHeight: 1 }}>✕</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Download progress panel ──────────────────────────────────────
export function DownloadProgressPanel() {
  const [downloads, setDownloads] = useState([]);

  useEffect(() => {
    const es = new EventSource('/api/downloads/progress/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'snapshot') {
        setDownloads(msg.downloads || []);
      } else if (msg.type === 'download') {
        const dl = msg.download;
        if (dl.status === 'removed') {
          setDownloads(prev => prev.filter(d => d.id !== dl.id));
        } else {
          setDownloads(prev => {
            const idx = prev.findIndex(d => d.id === dl.id);
            if (idx === -1) return [...prev, dl];
            const next = [...prev];
            next[idx] = dl;
            return next;
          });
        }
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  if (!downloads.length) return null;

  return (
    <div style={{ position: 'fixed', bottom: window.innerWidth <= 767 ? 80 : 20, left: 20, zIndex: 9998, width: 320 }}>
      {downloads.map(dl => {
        const pct = dl.totalBytes > 0 ? Math.round((dl.bytesReceived / dl.totalBytes) * 100) : null;
        const fmt = (b) => b > 1048576 ? `${(b/1048576).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`;
        const statusColor = dl.status === 'error' ? '#cc5050' : dl.status === 'complete' ? '#4caa60' : '#f5c518';
        return (
          <div key={dl.id} className="a-mb-8" style={{ background: 'var(--adm-g1)', border: `1px solid ${statusColor}44`, borderRadius: 6, padding: '10px 14px', boxShadow: '0 4px 20px #00000088' }}>
            <div className="a-flex a-ai-c a-gap-8 a-mb-6">
              <span className="a-fs-11 a-fw7" style={{ color: statusColor }}>
                {dl.status === 'error' ? '✕ Error' : dl.status === 'complete' ? '✓ Complete' : '↓ Downloading'}
              </span>
              <span className="a-muted a-fs-10 a-ml-auto">{dl.seriesName}</span>
            </div>
            <div className="a-text2 a-fs-11 a-mb-6 a-ovh a-ellip a-nowrap"
              title={dl.filename}>{dl.filename}</div>
            {dl.status === 'error' && (
              <div className="a-err a-fs-10">{dl.error}</div>
            )}
            {dl.status !== 'error' && (
              <div>
                <div className="a-ovh a-mb-4" style={{ background: 'var(--adm-g1)', borderRadius: 3, height: 4 }}>
                  <div style={{
                    height: '100%', borderRadius: 3, transition: 'width 0.3s ease',
                    background: dl.status === 'complete' ? '#4caa60' : 'var(--td-yellow)',
                    width: pct !== null ? `${pct}%` : (dl.status === 'complete' ? '100%' : '100%'),
                    animation: pct === null && dl.status !== 'complete' ? 'indeterminate 1.5s ease infinite' : 'none',
                  }} />
                </div>
                <div className="a-faint a-fs-10 a-flex a-jc-b">
                  <span>{fmt(dl.bytesReceived)}{dl.totalBytes > 0 ? ` / ${fmt(dl.totalBytes)}` : ''}</span>
                  {pct !== null && <span>{pct}%</span>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const ChevronDown = ({ open }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

// ─── Status badge ─────────────────────────────────────────────────
const STATUS_COLORS = {
  wanted:     { bg: '#111118', border: 'color-mix(in srgb, var(--td-yellow) 33%, transparent)', color: 'var(--td-yellow)' },
  snatched:   { bg: '#0e1a1a', border: '#4caaaa55', color: '#4caaaa' },
  downloaded: { bg: '#0e1a10', border: '#4caa6055', color: '#4caa60' },
  waiting:    { bg: '#0e1626', border: '#6a9ae055', color: '#8ab0e8' },
  processed:  { bg: '#0e1510', border: '#5ccc6055', color: '#5ccc60' },
  untagged:   { bg: '#1a0e1a', border: '#aa60aa55', color: '#cc80cc' },
  skipped:    { bg: '#1a1a1a', border: 'color-mix(in srgb, color-mix(in srgb, var(--om-text) 30%, var(--om-base)) 33%, transparent)', color: 'color-mix(in srgb, var(--om-text) 45%, var(--om-base))' },
};
const STATUS_TIPS = {
  wanted:     'Issue has been identified but not yet downloaded.',
  snatched:   'Download has been sent to SABnzbd or qBittorrent and is in progress.',
  downloaded: 'File has finished downloading and is waiting to be post-processed.',
  waiting:    'Downloaded but not yet processed into the library.',
  processed:  'File has been renamed, tagged with ComicInfo.xml, and moved to your library.',
  untagged:   'File is in your library but is missing ComicInfo.xml metadata. Use Retag to fix.',
  skipped:    'Issue has been manually skipped and will not be auto-downloaded.',
};
// Downloaded but not yet processed: a single issue in 'downloaded', or a
// wanted issue covered by a pack that is downloaded but not processed.
// Server fields: issue.waiting = { reason, until (UTC 'YYYY-MM-DD HH:MM:SS'), pack }.
function waitingTip(w) {
  if (!w) return '';
  let t = w.reason || 'Waiting to be processed';
  if (w.until) {
    const d = new Date(String(w.until).replace(' ', 'T') + 'Z');
    if (!isNaN(d)) t += d > new Date() ? ` · resumes at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' · retrying shortly';
  }
  return t;
}
const StatusBadge = ({ status, title }) => {
  const s = STATUS_COLORS[status] || STATUS_COLORS.skipped;
  return (
    <span className="a-fs-10 a-fw6 a-upper a-nowrap" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, borderRadius: 3, padding: '1px 7px', letterSpacing: '0.06em' }} title={title || STATUS_TIPS[status] || status}>{status}</span>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────
const fmt = bytes => {
  if (!bytes) return '—';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return (bytes / 1e6).toFixed(0) + ' MB';
};

// ─── Directory Picker Modal ───────────────────────────────────────
function DirectoryPicker({ onSelect, onClose }) {
  const [path, setPath] = useState('/comics');
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);

  const browse = useCallback(async (p) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/filesystem/browse?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (d.error) return;
      setPath(d.path);
      setDirs(d.dirs);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { browse('/comics'); }, [browse]);

  const navigate = (newPath) => {
    setHistory(h => [...h, path]);
    browse(newPath);
  };
  const goUp = () => {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setHistory(h => h.slice(0, -1));
      browse(prev);
    }
  };

  return (
    <Modal title="Select Parent Directory" onClose={onClose} width={520} closeOnBackdrop={false}>
      <div className="adm-modal-content">
        <div style={{ padding: '10px 20px', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', background: 'var(--om-base)' }}>
          <div className="a-mono a-fs-12 a-accent" style={{ opacity: 0.7 }}>{path}</div>
        </div>

        <div className="a-grow" style={{ overflowY: 'auto', padding: '8px 0' }}>
          {history.length > 0 && (
            <button className="dm-dir-row" onClick={goUp}>
              <FolderIcon /> <span className="a-accent">← Back</span>
            </button>
          )}
          {loading && <div className="a-faint a-ta-c" style={{ padding: 20 }}>Loading…</div>}
          {!loading && dirs.length === 0 && (
            <div className="a-faint a-ta-c" style={{ padding: 20 }}>No subdirectories</div>
          )}
          {dirs.map(d => (
            <div key={d.path} className="dm-dir-entry">
              <button className="dm-dir-row" onClick={() => navigate(d.path)}>
                <FolderIcon />
                <span>{d.name}</span>
                <span className="a-ml-auto a-dim a-fs-11">›</span>
              </button>
              <button className="dm-select-here" onClick={() => onSelect(d.path)} title="Add series here">
                Select
              </button>
            </div>
          ))}
        </div>

        <div className="a-flex a-gap-8 a-jc-e" style={{ padding: '12px 20px', borderTop: '1px solid var(--adm-g3)' }}>
          <button className="adm-btn" onClick={() => onSelect(path)}>
            Use Current: <span className="a-accent a-mono a-ml-6 a-fs-11">{path.split('/').pop()}/</span>
          </button>
          <button className="adm-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Add Series Modal ─────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'name-asc',  label: 'Title A–Z' },
  { value: 'name-desc', label: 'Title Z–A' },
  { value: 'year-desc', label: 'Year (newest)' },
  { value: 'year-asc',  label: 'Year (oldest)' },
  { value: 'issues-desc', label: 'Most issues' },
  { value: 'issues-asc',  label: 'Fewest issues' },
  { value: 'publisher',   label: 'Publisher' },
];

// Relevance: how well a volume name matches what was searched. Comic Vine's
// own order (and the server's newest-first sort) ignores the title, so
// "knight terrors catwoman" listed Absolute Catwoman first.
const relWords = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && w !== 'the');
function relevanceScore(name, query) {
  const q = relWords(query), n = relWords(name);
  if (!q.length || !n.length) return 0;
  if (q.join(' ') === n.join(' ')) return 1000;                       // exact title
  const nSet = new Set(n);
  const hits = q.filter(w => nSet.has(w)).length;
  let score = (hits / q.length) * 600;                                  // share of searched words in the title
  if (hits === q.length) score += 200;                                  // every searched word present
  if (n.join(' ').startsWith(q.join(' '))) score += 100;                // title starts with the search
  score -= (n.length - hits) * 15;                                      // extra words in the title
  return score;
}

export function sortAndFilter(results, filter, sort, query = '') {
  let out = results;
  if (filter.trim()) {
    const f = filter.toLowerCase();
    out = out.filter(r =>
      r.name?.toLowerCase().includes(f) ||
      r.publisher?.name?.toLowerCase().includes(f)
    );
  }
  switch (sort) {
    case 'name-asc':    return [...out].sort((a,b) => (a.name||'').localeCompare(b.name||''));
    case 'name-desc':   return [...out].sort((a,b) => (b.name||'').localeCompare(a.name||''));
    case 'year-desc':   return [...out].sort((a,b) => (b.start_year||0) - (a.start_year||0));
    case 'year-asc':    return [...out].sort((a,b) => (a.start_year||0) - (b.start_year||0));
    case 'issues-desc': return [...out].sort((a,b) => (b.count_of_issues||0) - (a.count_of_issues||0));
    case 'issues-asc':  return [...out].sort((a,b) => (a.count_of_issues||0) - (b.count_of_issues||0));
    case 'publisher':   return [...out].sort((a,b) => (a.publisher?.name||'').localeCompare(b.publisher?.name||''));
    case 'relevance':   return [...out].map(r => [relevanceScore(r.name, query), r]).sort((a, b) => b[0] - a[0]
                          || (b[1].start_year || 0) - (a[1].start_year || 0) || (b[1].count_of_issues || 0) - (a[1].count_of_issues || 0)).map(x => x[1]);
    default:            return out;
  }
}

// Fetch a directory suggestion from the server based on publisher + year
function useSuggestDirectory(selected, setParentDir) {
  const [suggestion, setSuggestion] = React.useState(null);
  const [loadingSuggestion, setLoadingSuggestion] = React.useState(false);

  React.useEffect(() => {
    if (!selected) { setSuggestion(null); return; }
    const publisher = selected.publisher?.name || '';
    const year = selected.start_year || '';
    if (!publisher) { setSuggestion(null); return; }
    setLoadingSuggestion(true);
    fetch(`/api/publishers/suggest-directory?publisher=${encodeURIComponent(publisher)}&year=${year}`)
      .then(r => r.json())
      .then(d => {
        setSuggestion(d);
        // Auto-fill parentDir with suggestion if high confidence and folder exists
        if (d.suggested && d.confidence === 'high' && d.exists) {
          setParentDir(d.suggested);
        }
      })
      .catch(() => setSuggestion(null))
      .finally(() => setLoadingSuggestion(false));
  }, [selected?.id]);

  return { suggestion, loadingSuggestion };
}

// Shared directory selector UI used by both add modals
function DirectorySuggestionPanel({ selected, suggestion, loadingSuggestion, parentDir, setParentDir, onBrowse }) {
  const folderPreview = selected && parentDir
    ? `${parentDir}/${selected.name} (${selected.start_year || '?'})`
    : null;

  return (
    <div style={{ padding: '14px 20px', borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', background: '#09090b' }}>
      <div className="a-fs-11 a-muted a-mb-8 a-upper" style={{ letterSpacing: '0.06em' }}>Series Directory</div>

      {loadingSuggestion && (
        <div className="a-fs-11 a-faint a-mb-8">Checking publisher config…</div>
      )}

      {suggestion && !loadingSuggestion && (
        <div className="a-mb-10" style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: `1px solid ${suggestion.confidence === 'high' ? 'rgba(100,180,100,0.25)' : suggestion.confidence === 'medium' ? 'rgba(200,160,60,0.25)' : 'rgba(255,255,255,0.08)'}`, borderRadius: 6 }}>
          <div className="a-flex a-ai-c a-gap-8 a-mb-6">
            <span className="a-fs-11" style={{ color: suggestion.confidence === 'high' ? '#8d8' : suggestion.confidence === 'medium' ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }}>
              {suggestion.confidence === 'high' ? '✓' : suggestion.confidence === 'medium' ? '⚠' : '?'} {suggestion.reason}
            </span>
          </div>
          <div className="a-mono a-fs-11 a-accent a-mb-8 a-breakall">
            {suggestion.suggested}
            {!suggestion.exists && <span className="a-err a-ml-6">(folder not found)</span>}
          </div>

          {/* Era picker if multiple eras available */}
          {suggestion.erasWithFolders?.length > 1 && (
            <div className="a-mb-8">
              <div className="a-fs-10 a-faint a-mb-4">Or select a different era:</div>
              <div className="a-flex a-gap-4 a-wrap">
                {suggestion.erasWithFolders.map(era => (
                  <button key={era.id}
                    className="a-fs-10 a-ptr" style={{ padding: '3px 8px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.12)', background: parentDir === era.path ? 'color-mix(in srgb, var(--td-yellow) 20%, transparent)' : 'transparent', color: parentDir === era.path ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }}
                    onClick={() => setParentDir(era.path)}
                    title={era.path}>
                    {era.name} {!era.exists && '⚠'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Imprint picker — separate row from eras so the user sees the
              distinction. Imprints aren't auto-suggested (no reliable
              detection signal at series-add time) but appear here for
              manual selection. Once a series is placed under an imprint
              folder, enricher.py picks it up via path-based matching and
              writes the imprint into series.json automatically. */}
          {suggestion.imprintsWithFolders?.length > 0 && (
            <div className="a-mb-8">
              <div className="a-fs-10 a-faint a-mb-4">Or place under an imprint:</div>
              <div className="a-flex a-gap-4 a-wrap">
                {suggestion.imprintsWithFolders.map(imp => (
                  <button key={imp.id}
                    className="a-fs-10 a-ptr" style={{ padding: '3px 8px', borderRadius: 3, border: '1px solid rgba(180,140,200,0.25)', background: parentDir === imp.path ? 'rgba(180,140,200,0.2)' : 'transparent', color: parentDir === imp.path ? '#c0a0d0' : '#9a8aa8' }}
                    onClick={() => setParentDir(imp.path)}
                    title={imp.path}>
                    {imp.name} {!imp.exists && '⚠'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="a-flex a-gap-6">
            {parentDir !== suggestion.suggested && (
              <button className="a-ok a-ptr a-fs-11" style={{ padding: '4px 10px', background: 'rgba(100,180,100,0.12)', border: '1px solid rgba(100,180,100,0.3)', borderRadius: 4 }}
                onClick={() => setParentDir(suggestion.suggested)}>
                Use suggestion
              </button>
            )}
            {parentDir === suggestion.suggested && suggestion.exists && (
              <span className="a-fs-11 a-ok" style={{ padding: '4px 0' }}>✓ Using suggested folder</span>
            )}
            {parentDir === suggestion.suggested && !suggestion.exists && (
              <span className="a-fs-11 a-accent" style={{ padding: '4px 0' }}>⚠ Folder will be created</span>
            )}
            <button className="a-muted a-ptr a-fs-11" style={{ padding: '4px 10px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4 }}
              onClick={onBrowse}>
              <FolderIcon /> Browse manually
            </button>
          </div>
        </div>
      )}

      {!suggestion && !loadingSuggestion && (
        <div className="a-flex a-gap-8 a-ai-c a-mb-8">
          <button className="adm-btn a-flex a-ai-c a-gap-6" onClick={onBrowse}>
            <FolderIcon /> {parentDir ? 'Change…' : 'Browse…'}
          </button>
          {parentDir && <span className="a-mono a-fs-11 a-accent" style={{ opacity: 0.8 }}>{parentDir}</span>}
        </div>
      )}

      {folderPreview && (
        <div className="a-mono a-fs-11 a-muted a-mt-4">
          Will create: <span className="a-accent">{folderPreview}</span>
        </div>
      )}
    </div>
  );
}

// ─── Make Special of… ────────────────────────────────────────────
// Puts a series on another series' Specials shelf (2026-11-14). Nothing on disk moves and it can be
// taken off again; it replaced the old merge, which moved the files into the parent's folder.
// Searches scanned_series (both monitored and unmonitored).
function MergeSeriesPicker({ sourceScannedSeriesId, sourceName, onClose, onMerged }) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) { setResults([]); return; }
      setLoading(true);
      fetch(`/api/specials/scanned-series?q=${encodeURIComponent(query.trim())}`)
        .then(r => r.json())
        .then(d => { setResults(d || []); setLoading(false); })
        .catch(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const doMerge = async () => {
    if (!selected) return;
    setMerging(true);
    try {
      const r = await fetch('/api/specials/shelve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceScannedSeriesId: sourceScannedSeriesId,
          parentScannedSeriesId: selected.id,
        }),
      });
      const d = await r.json();
      if (d.ok) {
        toast(d.shelvesOn ? `"${sourceName}" is now on ${selected.name}'s Specials shelf`
          : `"${sourceName}" will be on ${selected.name}'s Specials shelf once Specials shelves are turned on (Library)`, 'success');
        onMerged();
      } else {
        toast(d.error || 'Could not make it a special', 'error');
      }
    } catch (err) {
      toast(`Could not make it a special: ${err.message}`, 'error');
    }
    setMerging(false);
  };

  return (
    <Modal title="◈ Make Special of…" onClose={onClose} width={520}>
      <div className="adm-modal-content">
        <div className="a-faint a-fs-12" style={{ padding: '8px 12px 0' }}>For "{sourceName}": it goes on the Specials shelf of the series you pick. Its files stay where they are, and you can take it off again.</div>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--om-base)' }}>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search series by name…"
            className="a-w100 a-text a-fs-13 a-bb" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g3)', borderRadius: 4, padding: '6px 10px' }}
          />
        </div>
        <div className="a-grow" style={{ overflowY: 'auto' }}>
          {loading && <div className="a-faint a-fs-12" style={{ padding: 16 }}>Searching…</div>}
          {!loading && query && results.length === 0 && <div className="a-faint a-fs-12" style={{ padding: 16 }}>No series found</div>}
          {!query && <div className="a-faint a-fs-12" style={{ padding: 16 }}>Type to search all series in your library</div>}
          {results.map(s => (
            <div key={s.id}
              onClick={() => setSelected(sel => sel?.id === s.id ? null : s)}
              className="a-ptr a-flex a-ai-c a-gap-8" style={{ padding: '8px 16px', borderBottom: '1px solid var(--adm-g2)', background: selected?.id === s.id ? 'color-mix(in srgb, var(--om-base) 95%, white)' : 'transparent' }}
            >
              <span className="a-fs-13" style={{ color: selected?.id === s.id ? '#c090e0' : 'var(--om-text)', fontWeight: selected?.id === s.id ? 600 : 400 }}>
                {s.name}
              </span>
              {s.year && <span className="a-faint a-fs-11">{s.year}</span>}
              {s.monitored_id && <span className="a-ok a-fs-10" style={{ padding: '1px 5px', borderRadius: 3, background: '#0e2a1a' }}>monitored</span>}
              <span className="a-dim a-fs-10 a-ml-auto a-mono a-ovh a-ellip a-nowrap" style={{ maxWidth: 200 }}
                title={s.path}>{s.path}</span>
            </div>
          ))}
        </div>
        {selected && (
          <div className="a-flex a-ai-c a-gap-10" style={{ padding: '10px 16px', borderTop: '1px solid var(--adm-g3)' }}>
            <div className="a-grow">
              <div className="a-text a-fs-12">Special of: <strong style={{ color: '#c090e0' }}>{selected.name}</strong></div>
              <div className="a-faint a-fs-10 a-mono a-mt-2">{selected.path}</div>
            </div>
            <button
              onClick={doMerge}
              disabled={merging}
              className="a-fs-12 a-fw6" style={{ padding: '6px 14px', background: '#3a1a4a', border: '1px solid #c090e044', borderRadius: 4, color: '#c090e0', cursor: merging ? 'not-allowed' : 'pointer', opacity: merging ? 0.6 : 1 }}
            >
              {merging ? 'Saving…' : '◈ Make special'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Add-time Parent Picker ──────────────────────────────────────
// Lightweight picker for selecting a parent series when adding a new special series.
// Does NOT merge — just returns the selected scanned_series row.
function AddTimeParentPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!query.trim()) { setResults([]); return; }
      setLoading(true);
      fetch(`/api/specials/scanned-series?q=${encodeURIComponent(query.trim())}`)
        .then(r => r.json())
        .then(d => { setResults(d || []); setLoading(false); })
        .catch(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <Modal title="Select Parent Series" onClose={onClose} width={480}>
      <div className="adm-modal-content">
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--om-base)' }}>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search your library…"
            className="a-w100 a-text a-fs-13 a-bb" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g3)', borderRadius: 4, padding: '6px 10px' }}
          />
        </div>
        <div className="a-grow" style={{ overflowY: 'auto' }}>
          {loading && <div className="a-faint a-fs-12" style={{ padding: 16 }}>Searching…</div>}
          {!query && <div className="a-faint a-fs-12" style={{ padding: 16 }}>Type to search all series in your library</div>}
          {query && !loading && results.length === 0 && <div className="a-faint a-fs-12" style={{ padding: 16 }}>No series found</div>}
          {results.map(s => (
            <div key={s.id}
              onClick={() => onSelect(s)}
              className="a-ptr a-flex a-ai-c a-gap-8" style={{ padding: '8px 16px', borderBottom: '1px solid var(--adm-g2)' }}
              onMouseEnter={e => e.currentTarget.style.background = '#14141a'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span className="a-text a-fs-13">{s.name}</span>
              {s.year && <span className="a-faint a-fs-11">{s.year}</span>}
              {s.monitored_id && <span className="a-ok a-fs-10" style={{ padding: '1px 5px', borderRadius: 3, background: '#0e2a1a' }}>monitored</span>}
              <span className="a-dim a-fs-10 a-ml-auto a-mono a-ovh a-ellip a-nowrap" style={{ maxWidth: 180 }}
                title={s.path}>{s.path}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// "Special of" choice shared by both add dialogs: a one-shot or special that belongs to an existing
// library series. Since 2026-11-14 it gets its own folder beside that series and goes on its
// Specials shelf (earlier specials shared the series' folder and stay that way).
function SpecialOfRow({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="a-flex a-ai-c a-gap-8" style={{ padding: '8px 20px', background: 'var(--adm-g1)', borderTop: '1px solid #2a1a3a', flexWrap: 'wrap' }}>
        <span className="a-muted a-fs-11">◈ Special of:</span>
        {value
          ? <>
              <span className="a-fs-12 a-fw6" style={{ color: '#c090e0' }}>{value.name}</span>
              <span className="a-faint a-fs-10 a-mono">{value.path}</span>
              <button onClick={() => onChange(null)}
                className="a-ml-auto a-faint a-ptr a-fs-12" style={{ background: 'none', border: 'none' }}>✕ Clear</button>
            </>
          : <button onClick={() => setOpen(true)}
              className="a-ptr a-fs-11" style={{ background: 'transparent', border: '1px solid #3a2a4a', borderRadius: 3, color: '#9a80b0', padding: '2px 8px' }}>
              Select parent series (optional)
            </button>
        }
        {value && <span className="a-faint a-fs-10" style={{ width: '100%' }}>Gets its own folder beside {value.name} and goes on its Specials shelf.</span>
        }
      </div>
      {open && (
        <AddTimeParentPicker
          onSelect={s => { onChange(s); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function AddSeriesModal({ onClose, onAdded, initialQuery = '' }) {
  const [query, setQuery]       = useState(initialQuery);
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [parentDir, setParentDir] = useState('');
  const [adding, setAdding]     = useState(false);
  const [error, setError]       = useState('');
  const [filter, setFilter]     = useState('');
  const [sort, setSort]         = useState('relevance');
  const [searchedFor, setSearchedFor] = useState('');
  // Special series — optional parent scanned series
  const [parentScannedSeries, setParentScannedSeries] = useState(null); // { id, name, path }

  const { suggestion, loadingSuggestion } = useSuggestDirectory(selected, setParentDir);

  const search = async (q = query) => {
    if (!q.trim()) return;
    setSearching(true);
    setResults([]);
    setSelected(null);
    setParentDir('');
    setFilter('');
    setSearchedFor(q);
    try {
      const r = await fetch(`/api/comicvine/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'CV search failed');
      } else {
        setResults(d.results || []);
      }
    } catch (e) {
      setError('CV search failed — check your connection');
    }
    setSearching(false);
  };

  // Auto-search when opened with a pre-filled query (deep-link from Events)
  useEffect(() => {
    if (initialQuery) search(initialQuery);
  }, []);

  const add = async () => {
    if (!selected) return;
    // parentDir required unless a parent scanned series is selected (special series)
    if (!parentScannedSeries && !parentDir) return;
    setAdding(true);
    setError('');
    try {
      const r = await fetch('/api/monitor/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: String(selected.id),
          name: selected.name,
          publisher: selected.publisher?.name,
          year: selected.start_year,
          total_issues: selected.count_of_issues,
          image_url: selected.image?.medium_url,
          cv_url: selected.site_detail_url,
          parentDir: parentDir || '/comics', // fallback — unused when parentScannedSeriesId set
          parentScannedSeriesId: parentScannedSeries?.id || null,
        }),
      });
      const d = await r.json();
      if (d.success) { onAdded(d); onClose(); }
      else setError(d.error || 'Failed to add series');
    } catch (e) { setError(e.message); }
    setAdding(false);
  };

  const visible = sortAndFilter(results, filter, sort, searchedFor);
  const COMICS_ROOT = '/comics';

  return (
    <Modal title="Add Series to Monitor" onClose={onClose} width={680} closeOnBackdrop={false}>
      <div className="adm-modal-content">
        {/* Search bar */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
          <div className="a-flex a-gap-8">
            <input
              className="adm-input"
              placeholder="Search Comic Vine…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              autoFocus
            />
            <button className="adm-btn adm-btn-primary" onClick={() => search()} disabled={searching}>
              {searching ? '…' : <SearchIcon />}
            </button>
          </div>
        </div>

        {/* Filter + sort toolbar — only shown once results exist */}
        {results.length > 0 && (
          <div className="a-flex a-gap-8 a-ai-c" style={{ padding: '8px 20px', borderTop: '1px solid var(--adm-g3)', borderBottom: '1px solid var(--adm-g3)', background: 'var(--adm-g1)' }}>
            <input
              className="adm-input a-grow a-fs-12" style={{ padding: '5px 10px' }}
              placeholder="Filter by title or publisher…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <select
              className="a-text2 a-fs-12 a-ptr" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g4)', borderRadius: 5, padding: '5px 8px' }}
              value={sort}
              onChange={e => setSort(e.target.value)}
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span className="a-faint a-fs-11 a-nowrap">
              {visible.length}{visible.length !== results.length ? `/${results.length}` : ''} results
            </span>
          </div>
        )}

        {/* Results list */}
        <div className="a-grow" style={{ overflowY: 'auto', padding: '4px 0' }}>
          {searching && <div className="a-faint a-ta-c" style={{ padding: 20 }}>Searching…</div>}
          {!searching && visible.map(r => (
            <div
              key={r.id}
              className="dm-result-row" style={{ background: selected?.id === r.id ? 'var(--om-base)' : 'transparent', borderLeft: selected?.id === r.id ? '2px solid var(--td-yellow)' : '2px solid transparent' }}
              onClick={() => setSelected(r)}
            >
              <CoverPeek image={r.image} />
              <div className="a-grow a-min0">
                <div className="a-text a-fw6 a-fs-13 a-nowrap a-ovh a-ellip">
                  {r.name}
                </div>
                <div className="a-muted a-fs-11 a-mt-2">
                  {r.publisher?.name || '—'} · {r.start_year || '?'} · {r.count_of_issues ?? '?'} issues
                </div>
              </div>
              {selected?.id === r.id && <CheckIcon />}
            </div>
          ))}
          {!searching && results.length > 0 && visible.length === 0 && (
            <div className="a-faint a-ta-c" style={{ padding: 20 }}>No results match filter</div>
          )}
          {!searching && results.length === 0 && query && (
            <div className="a-faint a-ta-c" style={{ padding: 20 }}>No results</div>
          )}
        </div>

        {/* Directory + confirm */}
        {selected && (
          <>
            {/* Special series option — if set, overrides directory picker */}
            <SpecialOfRow value={parentScannedSeries} onChange={setParentScannedSeries} />
            {/* Directory picker — hidden when special series is selected */}
            {!parentScannedSeries && (
              <DirectorySuggestionPanel
                selected={selected}
                suggestion={suggestion}
                loadingSuggestion={loadingSuggestion}
                parentDir={parentDir}
                setParentDir={setParentDir}
                onBrowse={() => setPickerOpen(true)}
              />
            )}
            <div style={{ padding: '10px 20px 14px', background: '#09090b', borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
              {error && <div className="a-err a-fs-12 a-mb-8">{error}</div>}
              <div className="a-flex a-gap-8 a-jc-e">
                <button className="adm-btn" onClick={onClose}>Cancel</button>
                <button
                  className="adm-btn adm-btn-primary" style={{ opacity: ((!parentDir && !parentScannedSeries) || adding) ? 0.5 : 1 }}
                  onClick={add}
                  disabled={(!parentDir && !parentScannedSeries) || adding}
                >
                  {adding ? 'Adding…' : `Monitor ${selected.name}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Issue row ────────────────────────────────────────────────────
// Build a short, loose query — strip punctuation and common words, keep max 4 terms.
// The user sees and edits this before firing so precision doesn't matter.
// Strip punctuation but keep dotted initialisms ("G.I.", "S.H.I.E.L.D.") —
// otherwise "G.I. Joe" becomes just "Joe". Mirrors the server's buildLooseSeriesName.
function stripPunctKeepInitials(name) {
  return (name || '').split(/\s+/).map(w => {
    const letters = w.replace(/[^A-Za-z.]/g, '');
    return /^(?:[A-Za-z]\.){2,}$/.test(letters) ? letters : w.replace(/[^a-zA-Z0-9]/g, ' ');
  }).join(' ');
}

function buildLooseQuery(seriesName) {
  const stopWords = new Set(['the','a','an','of','in','on','at','to','for','and','or','new','all']);
  return stripPunctKeepInitials(seriesName)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()))
    .slice(0, 4)
    .join(' ');
}

function IssueRow({ issue, seriesId, selectMode = false, selected = false, onSelect, onSkip, onChanged }) {
  const { toast } = useToast();
  const [searchResults, setSearchResults] = useState([]);
  const [sourceStatus, setSourceStatus] = useState(null);
  const [searching, setSearching] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [grabbed, setGrabbed] = useState(false);
  const [query, setQuery] = useState('');
  const [retagging, setRetagging] = useState(false);
  const [retagResult, setRetagResult] = useState(null);
  const [gcLinks, setGcLinks] = useState({});
  const [gcGrabbing, setGcGrabbing] = useState({});
  const [nyaaGrabbing, setNyaaGrabbing] = useState({});
  const [inspecting, setInspecting] = useState(false);
  const isSkipped = issue.status === 'skipped';
  const issueLabel = `${issue.series_name || ''} ${String(issue.issue_number || '').padStart(3,'0')}`;

  const retag = async () => {
    setRetagging(true);
    setRetagResult(null);
    try {
      const r = await fetch(`/api/monitor/series/${seriesId}/issues/${issue.id}/retag`, { method: 'POST' });
      const d = await r.json();
      setRetagResult(d.success ? 'ok' : 'error');
      toast(d.success ? `Retagged ${issueLabel}` : `Retag failed for ${issueLabel}`, d.success ? 'success' : 'error');
    } catch {
      setRetagResult('error');
      toast(`Retag failed for ${issueLabel}`, 'error');
    }
    setRetagging(false);
  };

  const openSearch = () => {
    if (!expanded) {
      const base = buildLooseQuery(issue.series_name);
      const year = (issue.store_date || issue.release_date || '').slice(0, 4);
      let parts;
      if (issue.is_annual) {
        const hasAnnual = /annual/i.test(issue.series_name);
        parts = hasAnnual ? [base, year] : [base, 'Annual', year];
      } else {
        const issueNum = String(parseInt(issue.issue_number || '0', 10));
        parts = [base, issueNum, year];
      }
      setQuery(parts.filter(Boolean).join(' '));
      setSearchResults([]);
    }
    setExpanded(e => !e);
  };

  // Each source's results show as soon as they arrive; a slow source (Prowlarr
  // waiting on its indexers) no longer holds back the others (2026-11-03).
  const runSearch = async (q) => {
    if (!q.trim()) return;
    setSearching(true);
    setGcLinks({});
    setGcGrabbing({});
    setNyaaGrabbing({});
    setSearchResults([]);
    const enc = encodeURIComponent(q.trim());
    const parts = { ddl: [], nzb: [], nyaa: [] };
    const status = {
      Prowlarr: { name: 'Prowlarr', ok: true, pending: true, text: 'searching…' },
      GetComics: { name: 'GetComics', ok: true, pending: true, text: 'searching…' },
      Nyaa: { name: 'Nyaa', ok: true, pending: true, text: 'searching…' },
    };
    const publish = () => {
      setSearchResults([...parts.ddl, ...parts.nzb, ...parts.nyaa]);
      setSourceStatus([status.GetComics, status.Prowlarr, status.Nyaa]);
    };
    publish();
    const source = (name, key, url, listOf, limit) => fetch(url).then(r => r.json())
      .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
      .then(res => {
        const list = res.status === 'fulfilled' ? listOf(res.value) : [];
        parts[key] = list.slice(0, limit).map(r => ({ ...r, _source: key }));
        status[name] = sourceOutcome(name, res, list);
        publish();
      });
    await Promise.all([
      source('GetComics', 'ddl', `/api/getcomics/search?q=${enc}`, v => (Array.isArray(v) ? v : []), 10),
      source('Prowlarr', 'nzb', `/api/prowlarr/search-classified?q=${enc}`, v => (Array.isArray(v) ? v : []), 20),
      source('Nyaa', 'nyaa', `/api/nyaa/search?q=${enc}`, v => (Array.isArray(v?.results) ? v.results.filter(r => r.type !== 'chapter') : []), 15),
    ]).catch(() => {});
    setSearching(false);
  };

  const grabNyaaIssue = async (result) => {
    const key = result.infoHash || result.title;
    setNyaaGrabbing(g => ({ ...g, [key]: 'grabbing' }));
    toast(`Sending to qBittorrent: ${result.title}`, 'info');
    try {
      const r = await fetch('/api/qbittorrent/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: result.magnet, torrentUrl: result.link, issueId: issue.id }),
      });
      const d = await r.json();
      if (d.success) {
        setNyaaGrabbing(g => ({ ...g, [key]: 'done' }));
        setExpanded(false);
        setGrabbed(true);
        toast(`Sent to qBittorrent — ${issueLabel}`, 'success');
      } else {
        setNyaaGrabbing(g => ({ ...g, [key]: 'error' }));
        toast(`qBittorrent error: ${d.error}`, 'error');
      }
    } catch (e) {
      setNyaaGrabbing(g => ({ ...g, [key]: 'error' }));
      toast(`Error: ${e.message}`, 'error');
    }
  };

  const fetchDdlLinks = async (pageUrl) => {
    setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: true, links: [] } }));
    try {
      const r = await fetch(`/api/getcomics/links?url=${encodeURIComponent(pageUrl)}`);
      const d = await r.json();
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: d.links || [] } }));
    } catch {
      setGcLinks(prev => ({ ...prev, [pageUrl]: { loading: false, links: [] } }));
    }
  };

  const grabDdl = async (downloadUrl, filename) => {
    setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'grabbing' }));
    toast(`Starting DDL download for ${issueLabel}…`, 'info');
    try {
      const r = await fetch('/api/getcomics/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId, issueId: issue.id, downloadUrl, filename }),
      });
      const d = await r.json();
      if (d.success) {
        setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'done' }));
        setExpanded(false);
        setGrabbed(true);
        toast(`Download queued for ${issueLabel} — watch progress bottom-left`, 'success');
      } else {
        setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'error' }));
        toast(d.error ? `DDL failed for ${issueLabel}: ${d.error}` : `DDL failed for ${issueLabel}`, 'error');
      }
    } catch (e) {
      setGcGrabbing(prev => ({ ...prev, [downloadUrl]: 'error' }));
      toast(`DDL error: ${e.message}`, 'error');
    }
  };

  const grab = async (result) => {
    setGrabbing(true);
    toast(`Sending ${issueLabel} to SABnzbd…`, 'info');
    try {
      const r = await fetch('/api/sabnzbd/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: result.downloadUrl, name: result.title, issueId: issue.id }),
      });
      const d = await r.json();
      if (d.success) {
        setGrabbed(true);
        setExpanded(false);
        toast(`${issueLabel} sent to SABnzbd`, 'success');
      } else {
        toast(`SABnzbd rejected ${issueLabel}`, 'error');
      }
    } catch (e) {
      toast(`Grab failed: ${e.message}`, 'error');
    }
    setGrabbing(false);
  };

  return (
    <div style={{ borderBottom: '1px solid var(--om-base)', opacity: isSkipped ? (issue.owned_in ? 0.75 : 0.45) : 1 }}>
      <div className={`dm-issue-row a-flex a-ai-c a-gap-10${selected ? ' is-selected' : ''}`} style={{ padding: '6px 12px' }}>
        {selectMode && (
          <button type="button" role="checkbox" aria-checked={selected}
            aria-label={`Select issue ${issue.issue_number}`}
            onClick={(e) => { e.preventDefault(); onSelect?.(issue.id, e.shiftKey); }}
            className="a-noshrink a-ptr a-flex a-ai-c a-jc-c" style={{ width: 24, height: 24, padding: 0, borderRadius: 2, background: selected ? 'var(--td-yellow)' : 'var(--om-base)', border: `2px solid ${selected ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 85%, white)'}` }}
          >
            {selected && <span className="a-fs-10" style={{ color: 'var(--adm-g0)', fontWeight: 900, lineHeight: 1 }}>✓</span>}
          </button>
        )}
        <span className="dm-issue-number a-faint a-fs-11 a-ta-r a-mono" style={{ minWidth: 36 }}>
          {issue.issue_number?.padStart ? issue.issue_number.padStart(3, '0') : issue.issue_number}
        </span>
        <button type="button" className="dm-issue-title a-grow a-text2 a-fs-12 a-ovh a-ellip a-nowrap" title="Inspect issue" onClick={() => setInspecting(true)}>
          {issue.title || `Issue #${issue.issue_number}`}
        </button>
        <span className="dm-issue-date a-faint a-fs-11" title="Release date">{issue.release_date?.slice(0, 7) || '—'}</span>
        <div className="dm-issue-status">
        {issue.file_path && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(issue.file_path);
                toast('File path copied to clipboard', 'info');
              } else {
                toast(issue.file_path, 'info');
              }
            }}
            title={`Linked file: ${issue.file_path}\n(click to copy)`}
            aria-label="Show linked file path"
            className="a-faint a-ptr a-fs-13 a-noshrink" style={{ background: 'transparent', border: 'none', lineHeight: 1, padding: '2px 4px', opacity: 0.6 }}
            onMouseEnter={e => e.currentTarget.style.opacity = 1}
            onMouseLeave={e => e.currentTarget.style.opacity = 0.6}
          >ⓘ</button>
        )}
        {isSkipped && issue.owned_in && !grabbed ? (
          <span title={`Skipped: the library already has this issue in ${issue.owned_in}`} className="a-ok a-fs-10 a-fw6 a-nowrap a-ovh a-ellip" style={{ background: 'rgba(100,180,100,0.08)', border: '1px solid rgba(100,180,100,0.35)', borderRadius: 3, padding: '1px 7px', letterSpacing: '0.04em', maxWidth: 260 }}>OWNED · in {issue.owned_in}</span>
        ) : (
          grabbed ? <StatusBadge status="snatched" />
            : issue.waiting ? <>
                <StatusBadge status="waiting" title={waitingTip(issue.waiting)} />
                <span className="a-fs-11 a-muted a-nowrap a-ovh a-ellip" style={{ maxWidth: 280 }}
                  title={waitingTip(issue.waiting)}>{waitingTip(issue.waiting)}</span>
              </>
            : issue.in_pack ? <StatusBadge status="snatched" title="Covered by a pack that is still downloading." />
            : <StatusBadge status={issue.status === 'processed' && issue.has_comicinfo === 0 ? 'untagged' : issue.status} />
        )}
        </div>
        <div className="dm-issue-actions">
        {issue.status !== 'processed' && issue.status !== 'skipped' && !grabbed && (
          <button
            className="dm-download-action adm-icon-btn a-accent a-fs-11 a-flex a-ai-c a-gap-4" style={{ border: '1px solid color-mix(in srgb, var(--td-yellow) 20%, transparent)', padding: '3px 8px' }}
            onClick={openSearch}
          ><SearchIcon /> Search</button>
        )}
        {issue.status !== 'processed' && issue.status !== 'skipped' && !grabbed && onSkip && (
          <button
            className="adm-icon-btn a-muted a-fs-11" style={{ border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-base) 85%, white) 53%, transparent)', padding: '3px 8px' }}
            onClick={(e) => { e.stopPropagation(); onSkip(issue); }}
            title="Skip this issue"
          >Skip</button>
        )}
        {issue.status === 'skipped' && onSkip && (
          <button
            className="adm-icon-btn a-faint a-fs-11" style={{ border: '1px solid color-mix(in srgb, color-mix(in srgb, var(--om-base) 85%, white) 40%, transparent)', padding: '3px 8px' }}
            onClick={(e) => { e.stopPropagation(); onSkip(issue, 'wanted'); }}
            title="Un-skip this issue"
          >Un-skip</button>
        )}
        {issue.status === 'processed' && issue.has_comicinfo === 0 && isAdmin() && (
          <button
            className="adm-icon-btn a-fs-11 a-flex a-ai-c a-gap-4" style={{ padding: '3px 8px', color: retagResult === 'ok' ? '#4caa60' : retagResult === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : issue.has_comicinfo === 0 ? '#cc80cc' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', border: `1px solid ${retagResult === 'ok' ? '#4caa6033' : retagResult === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : issue.has_comicinfo === 0 ? '#aa60aa55' : 'color-mix(in srgb, var(--om-base) 85%, white)'}`, opacity: retagging ? 0.6 : 1 }}
            onClick={retag} disabled={retagging}
            title={issue.has_comicinfo === 0 ? 'Missing ComicInfo.xml — click to tag' : 'Re-inject ComicInfo.xml with current metadata'}
          >
            {retagResult === 'ok' ? '✓ Retagged' : retagResult === 'error' ? '✕ Failed' : retagging ? '…' : issue.has_comicinfo === 0 ? '↺ Tag' : '↺ Retag'}
          </button>
        )}
        </div>
      </div>

      {inspecting && <DownloadIssueInspector issue={issue} onClose={() => setInspecting(false)} onChanged={onChanged}
        onRetag={retag} onSearch={() => { setInspecting(false); openSearch(); }} />}
      {expanded && (
        <div style={{ background: '#08080a', borderTop: '1px solid var(--om-base)', padding: '8px 12px 10px' }}>
          <div className="a-flex a-gap-6 a-mb-8">
            <input
              className="adm-input a-fs-12 a-grow" style={{ padding: '5px 10px' }}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch(query)}
              placeholder="Edit query and press Enter or click Search…"
              autoFocus
            />
            <button
              className="adm-btn adm-btn-primary a-fs-12" style={{ padding: '5px 12px' }}
              onClick={() => runSearch(query)}
              disabled={searching}
            >
              {searching ? '…' : <SearchIcon />}
            </button>
            <button
              className="adm-btn a-fs-12" style={{ padding: '5px 10px' }}
              onClick={() => setExpanded(false)}
            >
              ✕
            </button>
          </div>

          <SourceStatus items={sourceStatus} />
          {searchResults.length > 0 && searchResults.map((r, i) => {
            if (r._source === 'ddl') {
              // DDL (GetComics) row — needs link expansion
              const linkState = gcLinks[r.url];
              return (
                <div key={i} style={{ borderBottom: '1px solid color-mix(in srgb, var(--om-base) 90%, black)' }}>
                  <div className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0' }}>
                    <span className="a-info a-fs-10 a-noshrink a-fw7" style={{ minWidth: 70 }}>DDL</span>
                    <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                    <button
                      className="adm-icon-btn a-info a-fs-11 a-noshrink" style={{ border: '1px solid #6080cc33', padding: '3px 8px' }}
                      onClick={() => !linkState && fetchDdlLinks(r.url)}
                      disabled={linkState?.loading}
                    >
                      {linkState?.loading ? '…' : linkState ? '▲' : '▼ Links'}
                    </button>
                  </div>
                  {linkState && !linkState.loading && linkState.links.length > 0 && (
                    <div style={{ paddingLeft: 78, paddingBottom: 4 }}>
                      {linkState.links.map((link, j) => {
                        const dlState = gcGrabbing[link.url];
                        // The text above this set of buttons on GetComics (which file it is).
                        const heading = link.packLabel && link.packLabel !== linkState.links[j - 1]?.packLabel ? link.packLabel : null;
                        return (
                          <React.Fragment key={j}>
                          {heading && <div className="a-fs-10 a-muted" style={{ padding: j ? '6px 0 1px' : '0 0 1px' }}>{heading}</div>}
                          <div className="a-flex a-ai-c a-gap-6" style={{ padding: '2px 0' }}>
                            <span className="a-grow a-faint a-fs-10 a-ovh a-ellip a-nowrap">{link.label}</span>
                            <button
                              className="adm-icon-btn a-fs-10 a-noshrink a-flex a-ai-c a-gap-2" style={{ padding: '2px 8px', color: dlState === 'done' ? '#4caa60' : dlState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${dlState === 'done' ? '#4caa6033' : dlState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                              onClick={() => !dlState && grabDdl(link.url, link.label)}
                              disabled={!!dlState}
                            >
                              <DownloadIcon />
                              {dlState === 'done' ? ' Queued' : dlState === 'error' ? ' Error' : dlState === 'grabbing' ? ' …' : ' Grab'}
                            </button>
                          </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}
                  {linkState && !linkState.loading && linkState.links.length === 0 && (
                    <div className="a-faint a-fs-10" style={{ paddingLeft: 78, paddingBottom: 4 }}>No direct links — may need Mediafire/Mega.</div>
                  )}
                </div>
              );
            }
            // NZB row
            if (r._source === 'nzb') return (
              <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                <span className="a-muted a-fs-11 a-noshrink" style={{ minWidth: 70 }}>{r.indexer}</span>
                {r.looksLikePack && (
                  <span className="a-fs-10 a-noshrink a-fw7 a-warn" style={{ padding: '1px 5px', borderRadius: 3, background: 'var(--adm-g3)', border: '1px solid #aa704044' }}>
                    ⚠ pack
                  </span>
                )}
                <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 50 }}>{fmt(r.size)}</span>
                <button
                  className="adm-icon-btn a-ok a-fs-11 a-flex a-ai-c a-gap-4 a-noshrink" style={{ border: '1px solid #4caa6033', padding: '3px 8px' }}
                  onClick={() => grab(r)}
                  disabled={grabbing}
                >
                  <DownloadIcon /> Grab
                </button>
              </div>
            );
            // Nyaa row
            if (r._source === 'nyaa') {
              const key = r.infoHash || r.title;
              const grabState = nyaaGrabbing[key];
              return (
                <div key={i} className="a-flex a-ai-c a-gap-8" style={{ padding: '5px 0', borderBottom: '1px solid var(--adm-g1)' }}>
                  <span className="a-ok a-fs-10 a-noshrink a-fw7" style={{ minWidth: 70 }}>
                    NYAA{r.type === 'pack' ? ' ◈' : r.volumeNumber ? ` v${r.volumeNumber}` : ''}
                  </span>
                  <span className="a-grow a-text2 a-fs-11 a-ovh a-ellip a-nowrap" title={r.title}>{r.title}</span>
                  <span className="a-faint a-fs-11 a-ta-r a-noshrink" style={{ minWidth: 40 }}>{r.size}</span>
                  <span className="a-fs-10 a-ta-r a-noshrink" style={{ color: r.seeders > 5 ? '#4caa60' : r.seeders > 0 ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', minWidth: 28 }}>↑{r.seeders}</span>
                  <button
                    className="adm-icon-btn a-fs-11 a-noshrink a-flex a-ai-c a-gap-4" style={{ padding: '3px 8px', color: grabState === 'done' ? '#4caa60' : grabState === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : '#4caa60', border: `1px solid ${grabState === 'done' ? '#4caa6033' : grabState === 'error' ? 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 75%, white) 20%, transparent)' : '#4caa6033'}` }}
                    onClick={() => !grabState && grabNyaaIssue(r)}
                    disabled={!!grabState}
                  >
                    <DownloadIcon />
                    {grabState === 'done' ? ' Sent' : grabState === 'error' ? ' Error' : grabState === 'grabbing' ? ' …' : ' Grab'}
                  </button>
                </div>
              );
            }
            return null;
          })}

          {!searching && searchResults.length === 0 && (
            <div className="a-faint a-fs-12" style={{ padding: '4px 0' }}>
              Edit the query above and hit Search — try fewer or different words.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Series card ──────────────────────────────────────────────────

function SeriesCard({ series, onRemove, onTypeToggle }) {
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
// ─── Settings panel ───────────────────────────────────────────────
// ─── Import Tab ───────────────────────────────────────────────────
function ConfidenceBadge({ score }) {
  const color = score >= 80 ? '#4caa60' : score >= 50 ? '#f5c518' : '#888';
  const label = score >= 80 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  return (
    <span className="a-fs-10 a-fw7" style={{ padding: '1px 6px', borderRadius: 3, background: color + '22', color, border: `1px solid ${color}44` }}>
      {label} {score}%
    </span>
  );
}

// Loads the first-issue cover from disk via the backend extraction endpoint.
// Must use fetch() + blob URL because <img> tags cannot send the Authorization
// header that requireAuth demands — bare <img src> always gets a 401.
function DiskCoverThumb({ directory, width = 46, height = 66 }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'error'

  useEffect(() => {
    let objectUrl = null;
    const url = `/api/import/disk-cover?directory=${encodeURIComponent(directory)}`;
    fetch(url, { headers: authHeader() })
      .then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.blob();
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setStatus('ok');
      })
      .catch(() => setStatus('error'));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [directory]);

  return (
    <div className="a-rel a-noshrink" style={{ width, height }}>
      {status !== 'ok' && (
        <div className="a-flex a-ai-c a-jc-c" style={{ position: 'absolute', inset: 0, background: 'var(--adm-g1)', borderRadius: 2 }}>
          {status === 'error'
            ? <span className="a-dim a-fs-18">?</span>
            : <span className="a-fs-10" style={{ color: 'var(--adm-g3)' }}>…</span>
          }
        </div>
      )}
      {blobUrl && (
        <img src={blobUrl} alt=""
          className="a-block" style={{ width, height, objectFit: 'cover', borderRadius: 2 }} />
      )}
    </div>
  );
}

function ImportSeriesRow({ item, selected, onToggle, onCvOverride }) {
  const [altOpen, setAltOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [customQuery, setCustomQuery] = useState(item.parsedName);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResults, setRescanResults] = useState(null); // alternatives from manual search
  const cv = item.cvMatch;

  const rescan = async () => {
    setRescanning(true);
    try {
      const r = await fetch('/api/import/rescan-one', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: item.directory, query: customQuery }),
      });
      const d = await r.json();
      if (d.cvMatch?.alternatives) {
        // Show results as a pickable list — don't auto-apply
        setRescanResults(d.cvMatch.alternatives);
        setSearchOpen(false);
        setAltOpen(false); // close old alternatives, show rescan results instead
      }
    } catch {}
    setRescanning(false);
  };

  return (
    <div className="a-mb-6 a-ovh" style={{ background: selected ? 'color-mix(in srgb, var(--om-base) 95%, black)' : '#08080a', border: `1px solid ${selected ? 'color-mix(in srgb, var(--td-yellow) 27%, transparent)' : 'color-mix(in srgb, var(--om-base) 95%, white)'}`, borderRadius: 5 }}>
      {/* Main row */}
      <div className="dm-import-row a-flex a-ai-c a-gap-10" style={{ padding: '10px 12px' }}>
        {/* Checkbox */}
        <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${item.parsedName}`} disabled={item.alreadyAdded || !cv}
          onClick={() => onToggle(item.directory)}
          className="a-noshrink a-flex a-ai-c a-jc-c" style={{ width: 18, height: 18, borderRadius: 3, cursor: item.alreadyAdded ? 'default' : 'pointer', background: selected ? 'var(--td-yellow)' : 'var(--om-base)', border: `2px solid ${selected ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 85%, white)'}` }}
        >
          {selected && <span className="a-fs-12" style={{ color: 'var(--adm-g0)', fontWeight: 900 }}>✓</span>}
        </button>

        {/* Covers: disk issue #1 (left) + CV match (right) */}
        <div className="a-flex a-gap-4 a-noshrink a-ai-e">
          <div className="a-flex a-col a-ai-c a-gap-2">
            <DiskCoverThumb directory={item.directory} width={46} height={66} />
            <span className="a-fs-10 a-mono a-upper" style={{ color: 'var(--adm-g4)', letterSpacing: '0.05em' }}>disk</span>
          </div>
          <div className="a-flex a-col a-ai-c a-gap-2">
            {cv?.image_url
              ? <img src={cv.image_url} alt="" className="a-block" style={{ width: 46, height: 66, objectFit: 'cover', borderRadius: 2 }} />
              : <div style={{ width: 46, height: 66, background: 'var(--om-base)', borderRadius: 2 }} />
            }
            <span className="a-fs-10 a-mono a-upper" style={{ color: 'var(--adm-g4)', letterSpacing: '0.05em' }}>cv</span>
          </div>
        </div>

        {/* Folder + file count */}
        <div className="dm-import-identity a-grow a-min0">
          <div className="a-text a-fw6 a-fs-13">{item.parsedName}</div>
          <div className="a-faint a-fs-11 a-mt-2 a-mono">
            {item.folderName} · {item.fileCount} file{item.fileCount !== 1 ? 's' : ''}
          </div>

        </div>

        {/* CV match */}
        {cv ? (
          <div className="dm-import-match a-ta-r" style={{ minWidth: 180 }}>
            <div className="a-flex a-ai-c a-gap-6 a-jc-e">
              <ConfidenceBadge score={cv.confidence} />
              {item.alreadyAdded && (
                <span className="a-fs-10 a-muted" style={{ padding: '1px 6px', borderRadius: 3, background: 'var(--adm-g3)' }}>
                  Already monitored
                </span>
              )}
            </div>
            {cv.cv_url
              ? <a href={cv.cv_url} target="_blank" rel="noopener noreferrer"
                  className="a-accent a-fs-12 a-mt-2 a-block" style={{ textDecoration: 'none' }}
                  onClick={e => e.stopPropagation()}
                  title="Open on Comic Vine">
                  {cv.name} ↗
                </a>
              : <div className="a-text2 a-fs-12 a-mt-2">{cv.name}</div>
            }
            <div className="a-faint a-fs-11">
              {cv.publisher} · {cv.year} · {cv.total_issues} issues
            </div>
            {cv.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(cv.description) && (
              <div className="a-text2 a-fs-10 a-mt-2">⚠ may be collected edition</div>
            )}
            <div className="a-flex a-gap-6 a-jc-e a-mt-4 a-wrap">
              {(cv.alternatives?.length > 1) && (
                <button
                  className="adm-icon-btn a-fs-10 a-faint"
                  onClick={e => { e.stopPropagation(); setAltOpen(o => !o); setSearchOpen(false); setRescanResults(null); }}
                >
                  {altOpen ? '▲ Hide matches' : `▼ ${cv.alternatives.length - 1} other matches`}
                </button>
              )}
              <button
                className="adm-icon-btn a-fs-10 a-faint"
                onClick={e => { e.stopPropagation(); setSearchOpen(o => !o); setAltOpen(false); }}
                title="Search with custom terms"
              >🔍</button>
            </div>
          </div>
        ) : (
          <div className="dm-import-match a-ta-r">
            <div className="a-faint a-fs-12 a-mb-4">No CV match found</div>
            <button
              className="a-fs-10 a-muted a-ptr" style={{ padding: '2px 8px', borderRadius: 3, background: 'transparent', border: '1px solid var(--adm-g4)' }}
              onClick={e => { e.stopPropagation(); setSearchOpen(o => !o); }}
            >🔍 Search manually</button>
          </div>
        )}
      </div>

      {/* Manual search override */}
      {searchOpen && (
        <div className="a-flex a-gap-6 a-ai-c" style={{ borderTop: '1px solid var(--adm-g2)', background: 'var(--adm-g0)', padding: '8px 12px' }}>
          <input
            value={customQuery}
            onChange={e => setCustomQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !rescanning && rescan()}
            placeholder="Search terms, CV URL, or numeric ID..."
            className="a-grow a-text a-fs-12" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 3, padding: '4px 8px', outline: 'none' }}
            autoFocus
          />
          <button
            onClick={rescan} disabled={rescanning || !customQuery.trim()}
            className="a-fs-11 a-ptr" style={{ padding: '4px 12px', borderRadius: 3, background: rescanning ? 'var(--om-base)' : 'color-mix(in srgb, var(--td-yellow) 13%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 27%, transparent)', color: rescanning ? 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' : 'var(--td-yellow)' }}
          >{rescanning ? 'Searching…' : 'Search'}</button>
          <button onClick={() => setSearchOpen(false)}
            className="a-fs-11 a-ptr a-faint" style={{ padding: '4px 8px', borderRadius: 3, background: 'transparent', border: '1px solid var(--adm-g3)' }}>✕</button>
        </div>
      )}

      {/* Rescan results — shown after manual search, user picks one */}
      {rescanResults && (
        <div style={{ borderTop: '1px solid var(--om-base)', background: '#080808' }}>
          <div className="a-fs-10 a-faint a-mono a-upper" style={{ padding: '6px 12px 4px', letterSpacing: '0.1em' }}>
            Search results — click to select
            <button onClick={() => setRescanResults(null)}
              className="a-dim a-ptr a-fs-11" style={{ float: 'right', background: 'transparent', border: 'none' }}>✕</button>
          </div>
          {rescanResults.length === 0 && (
            <div className="a-faint a-fs-12" style={{ padding: '8px 12px' }}>No results found</div>
          )}
          {rescanResults.map((alt) => (
            <div key={alt.id}
              className="a-flex a-ai-c a-gap-8 a-ptr" style={{ padding: '7px 12px', borderBottom: '1px solid var(--adm-g1)', background: cv?.id === alt.id ? 'color-mix(in srgb, var(--om-base) 95%, black)' : 'transparent' }}
              onClick={() => { onCvOverride(item.directory, alt); setRescanResults(null); }}
            >
              {alt.image_url
                ? <img src={alt.image_url} alt="" className="a-noshrink" style={{ width: 40, height: 56, objectFit: 'cover', borderRadius: 2 }} />
                : <div className="a-noshrink" style={{ width: 40, height: 56, background: 'var(--adm-g1)', borderRadius: 2 }} />
              }
              <div className="a-grow">
                {alt.cv_url
                  ? <a href={alt.cv_url} target="_blank" rel="noopener noreferrer"
                      className="a-accent a-fs-12" style={{ textDecoration: 'none' }}
                      onClick={e => e.stopPropagation()}>{alt.name} ↗</a>
                  : <div className="a-text2 a-fs-12">{alt.name}</div>
                }
                <div className="a-faint a-fs-11">
                  {alt.publisher} · {alt.year} · {alt.total_issues} issues
                  {alt.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(alt.description)
                    && <span className="a-text2 a-ml-6">· TPB?</span>}
                </div>
              </div>
              <ConfidenceBadge score={alt.confidence} />
              {cv?.id === alt.id && <span className="a-accent a-fs-11">✓ current</span>}
            </div>
          ))}
        </div>
      )}

      {/* Alternatives picker */}
      {altOpen && cv?.alternatives && (
        <div style={{ borderTop: '1px solid var(--om-base)', background: '#080808' }}>
          {cv.alternatives.map((alt, i) => (
            <div key={alt.id}
              className="a-flex a-ai-c a-gap-8 a-ptr" style={{ padding: '7px 12px', borderBottom: '1px solid var(--adm-g1)', background: cv.id === alt.id ? 'color-mix(in srgb, var(--om-base) 95%, black)' : 'transparent' }}
              onClick={() => { onCvOverride(item.directory, alt); }}
            >
              {alt.image_url
                ? <img src={alt.image_url} alt="" className="a-noshrink" style={{ width: 40, height: 56, objectFit: 'cover', borderRadius: 2 }} />
                : <div className="a-noshrink" style={{ width: 40, height: 56, background: 'var(--adm-g1)', borderRadius: 2 }} />
              }
              <div className="a-grow">
                {alt.cv_url
                  ? <a href={alt.cv_url} target="_blank" rel="noopener noreferrer"
                      className="a-accent a-fs-12" style={{ textDecoration: 'none' }}
                      onClick={e => e.stopPropagation()} title="Open on Comic Vine">
                      {alt.name} ↗
                    </a>
                  : <div className="a-text2 a-fs-12">{alt.name}</div>
                }
                <div className="a-faint a-fs-11">
                  {alt.publisher} · {alt.year} · {alt.total_issues} issues
                  {alt.description && /trade paperback|collected edition|tpb|hardcover collection/i.test(alt.description)
                    && <span className="a-text2 a-ml-6">· TPB?</span>}
                </div>
              </div>
              <ConfidenceBadge score={alt.confidence} />
              {cv.id === alt.id && <span className="a-accent a-fs-11">✓ selected</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportTab({ onImported }) {
  const [reviewFilter, setReviewFilter] = useState('all');
  const [scanPath, setScanPath] = useState('/comics');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null); // null = not scanned yet
  const [selected, setSelected] = useState(new Set());
  const [cvOverrides, setCvOverrides] = useState({}); // directory → cv object
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState(null);
  const [scanError, setScanError] = useState('');

  const scan = async () => {
    setScanning(true);
    setScanResults(null);
    setScanError('');
    setSelected(new Set());
    setCvOverrides({});
    setImportResults(null);
    try {
      const r = await fetch('/api/import/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanPath }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { setScanError(d.error || 'Scan failed'); }
      else {
        setScanResults(d.series || []);
        // Auto-select all non-already-monitored series with a CV match
        const autoSelect = new Set(
          (d.series || [])
            .filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch))
            .map(s => s.directory)
        );
        setSelected(autoSelect);
      }
    } catch (e) { setScanError(e.message); }
    setScanning(false);
  };

  const toggleAll = () => {
    const eligible = (scanResults || []).filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch)).map(s => s.directory);
    if (selected.size === eligible.length) setSelected(new Set());
    else setSelected(new Set(eligible));
  };

  const toggleOne = (dir) => {
    setSelected(s => {
      const n = new Set(s);
      n.has(dir) ? n.delete(dir) : n.add(dir);
      return n;
    });
  };

  const setCvOverride = (dir, cv) => {
    setCvOverrides(o => ({ ...o, [dir]: cv }));
  };

  const runImport = async () => {
    if (!selectedWithCv.length) return;
    setImporting(true);
    setImportResults(null);

    const selections = selectedWithCv.map(dir => {
      const item = scanResults.find(s => s.directory === dir);
      const cv = cvOverrides[dir] || item?.cvMatch;
      return {
        directory: dir,
        cvId: cv.id, name: cv.name, publisher: cv.publisher,
        year: cv.year, total_issues: cv.total_issues,
        image_url: cv.image_url, cv_url: cv.cv_url,
      };
    });

    try {
      const r = await fetch('/api/import/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      });
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.results)) throw new Error(d.error || 'Import failed');
      setImportResults(d.results);
      if (onImported) onImported();
    } catch (e) {
      setImportResults([{ status: 'error', error: e.message }]);
    }
    setImporting(false);
  };

  const eligible = (scanResults || []).filter(s => !s.alreadyAdded && (cvOverrides[s.directory] || s.cvMatch));
  const selectedWithCv = [...selected].filter(dir => {
    const item = scanResults?.find(s => s.directory === dir);
    return cvOverrides[dir] || item?.cvMatch;
  });

  return (
    <div className="dm-import">
      <div className="dm-workflow-steps" aria-label="Import stages"><strong>1 · Scan folders</strong><strong>2 · Review matches</strong><strong>3 · Import results</strong></div>
      {/* Scan controls */}
      <div className="a-mb-16" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, padding: '14px 16px' }}>
        <div className="a-fs-11 a-muted a-fw7 a-upper a-mb-10" style={{ letterSpacing: '0.08em' }}>
          Scan Directory
        </div>
        <div className="a-flex a-gap-8 a-ai-c">
          <div className="a-mono a-fs-12 a-accent a-grow" style={{ background: 'var(--adm-g0)', border: '1px solid var(--adm-g3)', borderRadius: 4, padding: '6px 10px' }}>
            {scanPath}
          </div>
          <button className="adm-btn a-flex a-ai-c a-gap-6"
            disabled={scanning || importing} onClick={() => setPickerOpen(true)}>
            <FolderIcon /> Browse
          </button>
          <button className="adm-btn adm-btn-primary" style={{ minWidth: 80 }}
            onClick={scan} disabled={scanning || importing}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {scanning && (
          <div className="a-mt-10 a-fs-12 a-faint">
            Searching Comic Vine for each series — this may take a minute…
          </div>
        )}
        {scanError && <div className="a-mt-8 a-err a-fs-12">{scanError}</div>}
      </div>

      {/* Results */}
      {scanResults !== null && (
        <>
          {scanResults.length === 0 ? (
            <div className="adm-empty">No series directories found in {scanPath}</div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="a-flex a-ai-c a-gap-12 a-mb-10">
                <button className="adm-btn a-fs-12" style={{ padding: '4px 10px' }} disabled={importing} onClick={toggleAll}>
                  {selected.size === eligible.length && eligible.length > 0 ? 'Deselect All' : 'Select All'}
                </button>
                <span className="a-faint a-fs-12">
                  {selectedWithCv.length} of {eligible.length} matched series selected
                  {scanResults.filter(s => s.alreadyAdded).length > 0 &&
                    ` · ${scanResults.filter(s => s.alreadyAdded).length} already monitored`}
                </span>
                <div className="a-grow" />
                {selectedWithCv.length > 0 && !importResults && (
                  <button
                    className="adm-btn adm-btn-primary" style={{ opacity: importing ? 0.6 : 1 }}
                    onClick={runImport}
                    disabled={importing}
                  >
                    {importing ? 'Importing…' : `Import ${selectedWithCv.length} Series`}
                  </button>
                )}
              </div>

              {/* Import results summary */}
              {importResults && (
                <div className="a-mb-12" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 5, padding: '10px 14px' }}>
                  <div className="a-fw6 a-fs-13 a-mb-6" role="status">{importResults.some(r => r.status === 'error') ? 'Import finished with errors' : 'Import complete'}</div>
                  {importResults.map((r, i) => (
                    <div key={i} className="a-fs-12 a-mb-2" style={{ color: r.status === 'error' ? 'color-mix(in srgb, var(--td-red) 75%, white)' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))' }}>
                      {r.status === 'imported'
                        ? `✓ ${r.name} — ${r.issues_fetched} issues fetched, ${r.files_matched} files matched`
                        : r.status === 'linked-annual'
                        ? `◈ ${r.name} — linked as annual`
                        : `✕ ${r.name || r.directory} — ${r.error}`}
                    </div>
                  ))}
                </div>
              )}

              <div className="dm-triage-toolbar"><label>Review<select className="adm-input" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)}><option value="all">All folders</option><option value="matched">Matched</option><option value="review">Needs a match</option><option value="added">Already monitored</option></select></label></div>
              {/* Series list */}
              {scanResults.filter(item => reviewFilter === 'all' || (reviewFilter === 'added' ? item.alreadyAdded : reviewFilter === 'matched' ? !item.alreadyAdded && (cvOverrides[item.directory] || item.cvMatch) : !item.alreadyAdded && !(cvOverrides[item.directory] || item.cvMatch))).map(item => (
                <ImportSeriesRow
                  key={item.directory}
                  item={{ ...item, cvMatch: cvOverrides[item.directory]
                    ? { ...cvOverrides[item.directory], alternatives: item.cvMatch?.alternatives }
                    : item.cvMatch }}
                  selected={selected.has(item.directory)}
                  onToggle={importing ? () => {} : toggleOne}
                  onCvOverride={setCvOverride}
                />
              ))}
            </>
          )}
        </>
      )}

      {pickerOpen && (
        <DirectoryPicker
          onSelect={dir => { setScanPath(dir); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>


  );
}

// ─── Weekly releases tab ──────────────────────────────────────────

/** Returns the Monday of the week containing `date` as YYYY-MM-DD */
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // local day: 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  // Return as YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtWeekLabel(monday) {
  const start = new Date(monday + 'T12:00:00Z');
  const end   = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  const opts  = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

const NO_IMAGE_PANELS = [
  { bg: '#1a0a0a', border: '#5a1a1a', lines: ['POW!'],          textColor: '#e05050', font: 'bold 8px serif' },
  { bg: '#0a0a1a', border: '#1a1a5a', lines: ['ZAP!'],           textColor: '#5080e0', font: 'bold 8px serif' },
  { bg: '#0a1a0a', border: '#1a5a1a', lines: ['WHAM!'],          textColor: '#50c050', font: 'bold 7px serif' },
  { bg: '#111118', border: '#5a5a1a', lines: ['KAPOW!'],         textColor: '#f5c518', font: 'bold 7px serif' },
  { bg: '#1a0a1a', border: '#5a1a5a', lines: ['BIFF!'],          textColor: '#c050c0', font: 'bold 8px serif' },
  { bg: '#0a1a1a', border: '#1a5a5a', lines: ['CRUNCH!'],        textColor: '#50c0c0', font: 'bold 7px serif' },
  { bg: '#1a0f0a', border: '#5a3a1a', lines: ['SLAM!'],          textColor: '#e08050', font: 'bold 8px serif' },
  { bg: '#0f0a1a', border: '#3a1a5a', lines: ['THWACK!'],        textColor: '#8050e0', font: 'bold 6px serif' },
  { bg: '#1a0a0f', border: '#5a1a3a', lines: ['ZONK!'],          textColor: '#e05080', font: 'bold 8px serif' },
  { bg: '#0a1a14', border: '#1a5a3a', lines: ['BLAM!'],          textColor: '#50e090', font: 'bold 8px serif' },
];

function NoImagePlaceholder({ seed }) {
  const idx = seed
    ? [...seed].reduce((acc, c) => acc + c.charCodeAt(0), 0) % NO_IMAGE_PANELS.length
    : 0;
  const panel = NO_IMAGE_PANELS[idx];

  return (
    <svg
      width={32} height={48}
      viewBox="0 0 32 48"
      className="a-noshrink a-block" style={{ borderRadius: 2 }}
    >
      {/* halftone-ish background */}
      <rect width={32} height={48} fill={panel.bg} />
      {/* dot pattern */}
      {Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 4 }, (_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={4 + col * 8}
            cy={4 + row * 8}
            r={1.2}
            fill={panel.border}
            opacity={0.5}
          />
        ))
      )}
      {/* border */}
      <rect x={1} y={1} width={30} height={46} fill="none" stroke={panel.border} strokeWidth={1.5} />
      {/* starburst lines */}
      {[0,45,90,135].map(angle => {
        const rad = angle * Math.PI / 180;
        return (
          <line
            key={angle}
            x1={16} y1={24}
            x2={16 + Math.cos(rad) * 18}
            y2={24 + Math.sin(rad) * 24}
            stroke={panel.border}
            strokeWidth={0.8}
            opacity={0.4}
          />
        );
      })}
      {/* speech-bubble style box */}
      <rect x={3} y={16} width={26} height={16} rx={2} fill={panel.border} opacity={0.3} />
      <rect x={3} y={16} width={26} height={16} rx={2} fill="none" stroke={panel.border} strokeWidth={0.8} />
      {/* text */}
      <text
        x={16} y={26}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={panel.textColor}
        style={{ font: panel.font, letterSpacing: '-0.5px', textShadow: 'none' }}
      >
        {panel.lines[0]}
      </text>
    </svg>
  );
}

const STATUS_STYLE = {
  processed: { bg: '#0e2a1a', color: '#4caa70', border: '#4caa7033', label: 'HAVE' },
  downloaded: { bg: '#0e1a2a', color: '#4a80cc', border: '#4a80cc33', label: 'DL\'D' },
  snatched:  { bg: '#111118', color: 'var(--td-yellow)', border: 'color-mix(in srgb, var(--td-yellow) 20%, transparent)', label: 'SNATCHED' },
  wanted:    { bg: '#1a0e0e', color: '#c07070', border: '#c0707033', label: 'WANTED' },
};

// Small external-link icon for LOCG / CV links
function ExtLink({ href, title, children }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      title={title}
      onClick={e => e.stopPropagation()}
      className="a-faint a-fs-10 a-noshrink a-flex a-ai-c" style={{ textDecoration: 'none', lineHeight: 1 }}
      onMouseEnter={e => e.currentTarget.style.color = '#f5c518'}
      onMouseLeave={e => e.currentTarget.style.color = '#555'}
    >{children}</a>
  );
}

// ─── Digital-line detector ────────────────────────────────────────
// Returns a sentinel key (used as publisher group key) if the issue
// belongs to a digital-only line that deserves its own section.
// Returns null for regular print comics.
const DIGITAL_SECTIONS = {
  '__INFINITY_COMICS__': {
    label: 'Marvel Infinity Comics',
    badge: 'Digital • Vertical Scroll',
    color: 'var(--td-red)',        // Marvel red
    borderColor: '#5a1010',
    badgeColor: '#e05050',
  },
  '__DC_GO__': {
    label: 'DC Go!',
    badge: 'Digital • Kids / All-Ages',
    color: '#1a6fb5',        // DC blue
    borderColor: '#0d2d50',
    badgeColor: '#4090d0',
  },
};

function getDigitalSectionKey(issue) {
  const name = (issue.volume?.name || '').toLowerCase();
  if (name.includes('infinity comic')) return '__INFINITY_COMICS__';
  // DC Go series typically end with "Go!" or contain " go!" or "dc go"
  if (/\bgo!\s*$/.test(name) || name.includes('dc go')) return '__DC_GO__';
  return null;
}

function WeeklyIssueCard({ issue, onAddSeries }) {
  const status = issue.issue_status;
  const st = status ? STATUS_STYLE[status] : null;
  return (
    <div className={`dm-weekly-issue${issue.monitored ? ' is-monitored' : ''}`}>
      <div className="dm-weekly-identity">
        <span className="dm-weekly-title">{issue.volume.name}</span>
        <span className="dm-weekly-number">#{issue.issue_number || '—'}</span>
        {String(issue.issue_number).match(/^0*1$/) && <span className="dm-weekly-debut">#1 issue</span>}
      </div>
      <div className="dm-weekly-links">
        <ExtLink href={issue.locg_url} title="View issue on League of Comic Geeks">LOCG ↗</ExtLink>
        <ExtLink href={issue.cv_url} title="View series on Comic Vine">CV ↗</ExtLink>
      </div>
      <div className="dm-weekly-state">
        {issue.monitored && <span className="dm-weekly-monitored">✓ Monitored</span>}
        {status && <span className="dm-weekly-status" style={st ? { color: st.color, background: st.bg, borderColor: st.border } : undefined} title={STATUS_TIPS[status] || status}>{st?.label || status}</span>}
        {!issue.monitored && <button className="adm-btn dm-weekly-monitor" onClick={() => onAddSeries(issue.volume)} title={`Choose and confirm ${issue.volume.name} for site monitoring`}>+ Monitor series</button>}
      </div>
    </div>
  );
}

const ITEMS_PER_PAGE = 100; // items per page across all publishers

function WeeklyTab({ onSeriesAdded }) {
  const todayMonday = getMondayOf(new Date());
  const [week, setWeek]       = useState(todayMonday);
  const [data, setData]       = useState(null);   // { issues, total_singles, start, end }
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [page, setPage]       = useState(0);
  const [addTarget, setAddTarget] = useState(null); // volume obj to pre-fill AddSeriesModal

  const [query, setQuery] = useState('');
  const [publisher, setPublisher] = useState('all');
  const [monitorFilter, setMonitorFilter] = useState('all');
  const requestId = useRef(0);
  useEffect(() => { setPage(0); }, [query, publisher, monitorFilter]);
  const weekRefreshFired = useRef(new Set()); // track weeks already refreshed this session

  const load = async (monday) => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    setData(null);
    setPage(0);
    try {
      const r = await fetch(`/api/weekly?start=${monday}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Release request failed (${r.status})`);
      if (request !== requestId.current) return;
      setData(d);
    } catch (e) {
      if (request !== requestId.current) return;
      setError(e.message);
    }
    setLoading(false);

    // Trigger CV refresh for monitored series only when viewing the current week,
    // and only once per week per session to avoid hammering CV on tab flips.
    if (monday === todayMonday && !weekRefreshFired.current.has(monday)) {
      weekRefreshFired.current.add(monday);
      fetch('/api/monitor/refresh-current-week', { method: 'POST' }).catch(() => {});
    }
  };

  // Load on mount and week change
  useEffect(() => { load(week); }, [week]);

  const shiftWeek = (delta) => {
    const d = new Date(week + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta * 7);
    setWeek(d.toISOString().slice(0, 10));
  };

  const releases = data?.issues || [];
  const publisherOptions = [...new Set([...releases.map(i => i.volume?.publisher || 'Unknown'), ...(publisher !== 'all' ? [publisher] : [])])].sort((a,b) => a.localeCompare(b));
  const filteredReleases = filterWeeklyIssues(releases, query, publisher, monitorFilter);
  const monitoredCount = releases.filter(i => i.monitored).length;

  // Group issues by publisher (or digital-section sentinel) for display.
  // Digital-only lines (Infinity Comics, DC Go) get their own sentinel keys
  // so they render in separate named sections at the bottom of the list.
  const grouped = data ? filteredReleases.reduce((acc, issue) => {
    const key = getDigitalSectionKey(issue) || issue.volume.publisher || 'Unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(issue);
    return acc;
  }, {}) : {};

  // Sort: regular publishers alphabetically first, digital sentinels last
  const sortGroupKeys = (a, b) => {
    const aDigital = a in DIGITAL_SECTIONS;
    const bDigital = b in DIGITAL_SECTIONS;
    if (aDigital !== bDigital) return aDigital ? 1 : -1; // digital goes to end
    return a.localeCompare(b);
  };

  // Flatten for pagination (preserve publisher grouping order)
  const publishers = Object.keys(grouped).sort(sortGroupKeys);
  const allIssues  = publishers.flatMap(p => grouped[p]);
  const totalPages = Math.ceil(allIssues.length / ITEMS_PER_PAGE);
  const displayPage = Math.min(page, Math.max(0, totalPages - 1));
  const pageIssues = allIssues.slice(displayPage * ITEMS_PER_PAGE, (displayPage + 1) * ITEMS_PER_PAGE);

  // Re-group the current page's issues by the same key scheme
  const pageGrouped = pageIssues.reduce((acc, issue) => {
    const key = getDigitalSectionKey(issue) || issue.volume.publisher || 'Unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(issue);
    return acc;
  }, {});
  const pagePublishers = Object.keys(pageGrouped).sort(sortGroupKeys);

  const isCurrentWeek = week === todayMonday;

  return (
    <div className="dm-weekly">
      {/* Week navigator */}
      <div className="dm-week-navigation a-flex a-ai-c a-gap-10 a-mb-16">
        <button
          className="adm-btn a-fs-13" style={{ padding: '5px 12px' }}
          onClick={() => shiftWeek(-1)}
          disabled={loading}
         aria-label="Previous release week">← Previous week</button>

        <div className="a-grow a-ta-c">
          <span className="a-text a-fw6 a-fs-13">{fmtWeekLabel(week)}</span>
          {isCurrentWeek && <span className="a-ml-8 a-fs-11 a-accent">This week</span>}
        </div>

        <button
          className="adm-btn a-fs-13" style={{ padding: '5px 12px' }}
          onClick={() => shiftWeek(1)}
          disabled={loading}
         aria-label="Next release week">Next week →</button>

        {!isCurrentWeek && (
          <button
            className="adm-btn a-fs-11" style={{ padding: '5px 10px' }}
            onClick={() => setWeek(todayMonday)}
            disabled={loading}
          >This week</button>
        )}
      </div>

      <div className="dm-weekly-controls">
        <label>Find releases<input className="adm-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Series or issue number…" /></label>
        <label>Publisher<select aria-label="Publisher" className="adm-input" value={publisher} onChange={e => setPublisher(e.target.value)}><option value="all">All publishers</option>{publisherOptions.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Show<select aria-label="Show" className="adm-input" value={monitorFilter} onChange={e => setMonitorFilter(e.target.value)}><option value="all">All releases</option><option value="unmonitored">Not monitored</option><option value="monitored">Monitored</option><option value="wanted">Wanted issues</option><option value="first">#1 issues</option></select></label>
        <label>Jump to week<input className="adm-input" type="date" value={week} onChange={e => { if (e.target.value) setWeek(getMondayOf(new Date(e.target.value + 'T12:00:00'))); }} /></label>
        {(query || publisher !== 'all' || monitorFilter !== 'all') && <button className="adm-btn" onClick={() => { setQuery(''); setPublisher('all'); setMonitorFilter('all'); }}>Clear filters</button>}
      </div>
      {/* Loading / error */}
      {loading && <div className="adm-empty">Loading releases…</div>}
      {error && <div className="a-err a-fs-13 a-ta-c" style={{ padding: '20px 0' }}>Error: {error} <button className="adm-btn" onClick={() => load(week)}>Retry</button></div>}

      {/* Results summary + pagination */}
      {data && !loading && (
        <>
          <div className="dm-weekly-summary" role="status"><strong>{filteredReleases.length} releases shown</strong><span>{monitoredCount} monitored · {releases.length - monitoredCount} not monitored this week</span></div>
          {releases.length > 0 && filteredReleases.length === 0 && <div className="adm-empty">No releases match these filters.</div>}
          <div className="dm-weekly-source a-flex a-ai-c a-gap-12 a-mb-12 a-wrap">
            <span className="a-faint a-fs-12">
              {data.total_singles} single issues
              {data.total_tpbs_filtered > 0 && (
                <span className="a-dim"> ({data.total_tpbs_filtered} TPBs/GNs excluded)</span>
              )}
              {data.source && (
                <span className="a-ml-8 a-fs-10" style={{ padding: '1px 6px', borderRadius: 8, background: data.source === 'previewsworld' ? 'var(--om-base)' : 'var(--om-base)', color: data.source === 'previewsworld' ? '#4caa70' : 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))', border: `1px solid ${data.source === 'previewsworld' ? '#4caa7033' : 'color-mix(in srgb, var(--om-base) 90%, white)'}` }}>
                  {data.source === 'previewsworld' ? '📋 PreviewsWorld' : '🔍 ComicVine'}
                </span>
              )}
              {data.source === 'comicvine' && data.total_from_store_date != null && (
                <span className="a-ml-6 a-fs-11" style={{ color: 'var(--adm-g4)' }}
                  title={`${data.total_from_store_date} from store date, ${data.total_from_cover_date} from cover date`}>
                  [{data.total_from_store_date}+{data.total_from_cover_date}]
                </span>
              )}
            </span>
            {data._debug?.release_source === 'locg' && (
              <span title="Release data sourced from League of Comic Geeks"
                className="a-fs-11 a-ok" style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--adm-g0)', border: '1px solid #003a18', cursor: 'default' }}>
                ✓ LOCG
              </span>
            )}
            {data._debug?.release_source === 'freshcomics' && (
              <span title="Release data sourced from FreshComics.us. Add LOCG credentials in Settings for richer data."
                className="a-fs-11 a-accent" style={{ padding: '2px 8px', borderRadius: 8, background: 'color-mix(in srgb, var(--td-yellow) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 30%, transparent)', cursor: 'default' }}>
                ⚠ FreshComics
              </span>
            )}
            {totalPages > 1 && (
              <div className="a-ml-auto a-flex a-ai-c a-gap-6">
                <button className="adm-btn a-fs-12" style={{ padding: '3px 10px' }} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={displayPage === 0}>‹</button>
                <span className="a-muted a-fs-12">Page {displayPage + 1} / {totalPages}</span>
                <button className="adm-btn a-fs-12" style={{ padding: '3px 10px' }} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={displayPage === totalPages - 1}>›</button>
              </div>
            )}
          </div>

          {data.total_singles === 0 && (
            <div className="adm-empty">
              <div className="a-fs-22 a-mb-8" style={{ opacity: 0.2 }}>◈</div>
              <div className="a-faint">No single issues found for this week.</div>
              {data._debug && (
                <div className="a-mt-10 a-fs-11 a-dim a-flex a-col a-gap-2 a-ta-l" style={{ maxWidth: 480, margin: '10px auto 0' }}>
                  {data._debug.raw_count === 0 ? (
                    <span style={{ color: '#884444' }}>
                      All sources returned 0 items — LOCG, FreshComics, and Walksoftly may be unreachable, or this week's list isn't published yet.
                    </span>
                  ) : (
                    <span className="a-faint">
                      {data._debug.raw_count} items were fetched but all {data._debug.tpbs_filtered} were filtered as TPBs/GNs.
                    </span>
                  )}
                  {data._debug.release_source && data._debug.release_source !== 'none' && (
                    <span className="a-dim a-breakall">
                      Source used: <strong className="a-faint">{data._debug.release_source}</strong>
                    </span>
                  )}
                  <span className="a-dim">Check Docker logs for details.</span>
                </div>
              )}
            </div>
          )}

          {/* Publisher sections (regular + digital-only sentinels) */}
          {pagePublishers.map(groupKey => {
            const digital = DIGITAL_SECTIONS[groupKey] || null;
            return (
              <div key={groupKey} className="dm-weekly-publisher">
                {digital ? (
                  // Digital-line header — distinct color + badge
                  <div className="a-mb-8 a-flex a-ai-c a-gap-8" style={{ padding: '5px 8px', borderBottom: `1px solid ${digital.borderColor}`, background: `${digital.borderColor}55`, borderRadius: '4px 4px 0 0' }}>
                    <span className="a-fs-11 a-fw7 a-upper" style={{ color: digital.color, letterSpacing: '0.08em' }}>
                      {digital.label}
                    </span>
                    <span className="a-fs-10 a-fw6" style={{ padding: '1px 6px', borderRadius: 8, background: `${digital.borderColor}`, color: digital.badgeColor, border: `1px solid ${digital.color}44`, letterSpacing: '0.04em' }}>
                      {digital.badge}
                    </span>
                    <span className="a-ml-auto a-dim a-fs-11">({pageGrouped[groupKey].length})</span>
                  </div>
                ) : (
                  // Regular publisher header
                  <div className="dm-weekly-publisher-title a-muted a-fs-11 a-fw7 a-upper a-mb-8" style={{ letterSpacing: '0.08em', padding: '4px 0', borderBottom: '1px solid var(--adm-g3)' }}>
                    {groupKey}
                    <span className="a-ml-8 a-dim a-fw4">({pageGrouped[groupKey].length})</span>
                  </div>
                )}
                <div className="a-flex a-col a-gap-2">
                  {pageGrouped[groupKey].map(issue => (
                    <WeeklyIssueCard
                      key={`${groupKey}-${issue.volume?.id || issue.volume?.name}-${issue.issue_number}-${issue.locg_url || issue.id || ''}`}
                      issue={issue}
                      onAddSeries={vol => setAddTarget(vol)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Bottom pagination */}
          {totalPages > 1 && (
            <div className="a-flex a-jc-c a-gap-6 a-mt-8">
              <button className="adm-btn a-fs-12" style={{ padding: '4px 14px' }} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={displayPage === 0}>‹ Prev</button>
              <span className="a-muted a-fs-12" style={{ alignSelf: 'center' }}>Page {displayPage + 1} / {totalPages}</span>
              <button className="adm-btn a-fs-12" style={{ padding: '4px 14px' }} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={displayPage === totalPages - 1}>Next ›</button>
            </div>
          )}
        </>
      )}

      {/* Add Series modal pre-filled from weekly release */}
      {addTarget && (
        <AddSeriesFromWeekly
          volume={addTarget}
          onClose={() => setAddTarget(null)}
          onAdded={() => { setAddTarget(null); onSeriesAdded(); load(week); }}
        />
      )}
    </div>
  );
}

/** Weekly monitor modal — auto-searches CV by series name on open,
 *  pre-selects the best match (by comicid or name+publisher), but shows
 *  all results so the user can correct a wrong match before confirming. */
function AddSeriesFromWeekly({ volume, onClose, onAdded }) {
  const [parentScannedSeries, setParentScannedSeries] = useState(null); // special of an existing series
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const [selected, setSelected]     = useState(null);
  const [parentDir, setParentDir]   = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [adding, setAdding]         = useState(false);
  const [error, setError]           = useState('');

  const { suggestion, loadingSuggestion } = useSuggestDirectory(selected, setParentDir);

  // Auto-search CV on mount using the series name from the weekly entry.
  // Pass publisher so the backend can sort publisher-matching volumes first.
  useEffect(() => {
    const doSearch = async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: volume.name });
        if (volume.publisher) params.set('publisher', volume.publisher);
        const r = await fetch(`/api/comicvine/search?${params}`);
        const d = await r.json();
        if (!r.ok) { setError(d.error || 'CV search failed'); setSearching(false); return; }
        const res = d.results || [];
        setResults(res);

        const locgId   = volume.id ? String(volume.id) : null;
        const normName = volume.name.toLowerCase().trim();
        const normPub  = (volume.publisher || '').toLowerCase().trim();
        const currentYear = new Date().getFullYear();

        // Known English-language publishers — prefer these over foreign republishers
        const ENGLISH_PUBLISHERS = new Set([
          'dc comics', 'marvel', 'image comics', 'dark horse comics', 'idw publishing',
          'boom! studios', 'dynamite entertainment', 'valiant entertainment', 'archie comics',
          'oni press', 'fantagraphics', 'drawn and quarterly', 'aftershock comics',
          'vault comics', 'scout comics', 'titan comics', 'avatar press',
        ]);
        const isForeignPub = (r) => {
          const p = (r.publisher?.name || '').toLowerCase().trim();
          if (!p) return false;
          if (ENGLISH_PUBLISHERS.has(p)) return false;
          return /panini|urban comics|planeta|glenat|ehapa|tokyopop|kazé|kana|delcourt|dargaud|lombard|dupuis|standaard|carlsen|bonnier|norma|ivrea|ovni|yoyo|soleil|semic|comics-x|toth|geppi|hachette|bajirao/i.test(p);
        };

        const englishResults = res.filter(r => !isForeignPub(r));
        const pool = englishResults.length > 0 ? englishResults : res;

        // Pre-select best match. Priority:
        // 1. Exact CV ID match (LOCG/Walksoftly data — always correct)
        // 2. Exact name + publisher match, most recent start year
        //    (avoids picking the 1963 run when the 2022 run is what's shipping)
        // 3. Exact name match, most recent start year (publisher didn't match cleanly)
        // 4. First result from the (backend-sorted) pool
        const nameMatches = pool.filter(r => r.name?.toLowerCase().trim() === normName);
        const byRecency = arr =>
          [...arr].sort((a, b) => Math.min(parseInt(b.start_year)||0, currentYear)
                                - Math.min(parseInt(a.start_year)||0, currentYear));

        const pubMatches    = nameMatches.filter(r => r.publisher?.name?.toLowerCase().trim() === normPub);
        const recentPubMatch = byRecency(pubMatches)[0] || null;
        const recentNameMatch = byRecency(nameMatches)[0] || null;

        let best = (locgId && pool.find(r => String(r.id) === locgId))
          || recentPubMatch
          || recentNameMatch
          || pool[0]
          || null;

        setSelected(best);
      } catch (e) {
        setError('CV search failed');
      }
      setSearching(false);
    };
    doSearch();
  }, []);

  const add = async () => {
    if (!selected || (!parentDir && !parentScannedSeries)) return;
    setAdding(true);
    setError('');
    try {
      const r = await fetch('/api/monitor/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:           String(selected.id),
          name:         selected.name,
          publisher:    selected.publisher?.name,
          year:         selected.start_year,
          total_issues: selected.count_of_issues || 0,
          image_url:    selected.image?.medium_url || null,
          cv_url:       selected.site_detail_url || null,
          parentDir: parentDir || '/comics', // unused when parentScannedSeriesId is set
          parentScannedSeriesId: parentScannedSeries?.id || null,
          // Store the original FreshComics series name so future weekly loads
          // match this series by exact source name instead of fuzzy CV-name matching.
          // This is how we recreate Walksoftly's unambiguous CV-ID-based matching.
          source_name:  volume.name || null,
        }),
      });
      const d = await r.json();
      if (d.success) onAdded(d);
      else setError(d.error || 'Failed to add');
    } catch (e) { setError(e.message); }
    setAdding(false);
  };

  return (
    <Modal title="Monitor Series" onClose={onClose} width={580}>
      <div className="adm-modal-content">
        {/* Searching indicator */}
        {searching && (
          <div className="a-faint a-ta-c a-fs-13" style={{ padding: '20px' }}>
            Searching Comic Vine for "{volume.name}"…
          </div>
        )}

        {/* Results list — scrollable */}
        {!searching && results.length > 0 && (
          <div className="a-grow" style={{ overflowY: 'auto', padding: '4px 0', borderBottom: '1px solid var(--adm-g3)' }}>
            {results.map(r => (
              <div
                key={r.id}
                className="dm-result-row a-ptr" style={{ background: selected?.id === r.id ? 'var(--om-base)' : 'transparent', borderLeft: selected?.id === r.id ? '2px solid var(--td-yellow)' : '2px solid transparent' }}
                onClick={() => setSelected(r)}
              >
                <CoverPeek image={r.image} />
                <div className="a-grow a-min0">
                  <div className="a-text a-fw6 a-fs-13 a-nowrap a-ovh a-ellip">
                    {r.name}
                  </div>
                  <div className="a-muted a-fs-11 a-mt-2">
                    {r.publisher?.name || '—'} · {r.start_year || '?'} · {r.count_of_issues ?? '?'} issues
                  </div>
                </div>
                {selected?.id === r.id && <CheckIcon />}
              </div>
            ))}
          </div>
        )}

        {!searching && results.length === 0 && (
          <div className="a-faint a-ta-c a-fs-13" style={{ padding: 20 }}>No results found</div>
        )}

        {/* Directory + confirm — only once something is selected */}
        {!searching && selected && (
          <>
            <SpecialOfRow value={parentScannedSeries} onChange={setParentScannedSeries} />
            {!parentScannedSeries && (
              <DirectorySuggestionPanel
                selected={selected}
                suggestion={suggestion}
                loadingSuggestion={loadingSuggestion}
                parentDir={parentDir}
                setParentDir={setParentDir}
                onBrowse={() => setPickerOpen(true)}
              />
            )}
            <div style={{ padding: '10px 20px 14px', background: '#09090b', borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
              {error && <div className="a-err a-fs-12 a-mb-8">{error}</div>}
              <div className="a-flex a-gap-8 a-jc-e">
                <button className="adm-btn" onClick={onClose}>Cancel</button>
                <button
                  className="adm-btn adm-btn-primary" style={{ opacity: ((!parentDir && !parentScannedSeries) || adding) ? 0.5 : 1 }}
                  onClick={add}
                  disabled={(!parentDir && !parentScannedSeries) || adding}
                >
                  {adding ? 'Adding…' : `Monitor ${selected.name}`}
                </button>
              </div>
            </div>
          </>
        )}

        {pickerOpen && (
          <DirectoryPicker
            onSelect={dir => { setParentDir(dir); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </Modal>
  );
}


// ─── Mass JSON Panel ──────────────────────────────────────────────
function MassJsonPanel({ onClose }) {
  const [state, setState]     = useState(null);
  const [running, setRunning] = useState(false);
  const logRef = React.useRef(null);

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/monitor/mass-json/status');
      const d = await r.json();
      setState(d);
      if (d.running) setRunning(true);
      else setRunning(false);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    const iv = setInterval(loadStatus, 1500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.log]);

  const start = async () => {
    setRunning(true);
    await fetch('/api/monitor/mass-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  };

  const pct = state && state.queued > 0 ? Math.round((state.done / state.queued) * 100) : 0;

  return (
    <Modal title="Create Missing series.json" onClose={onClose} width={620}>
      <div className="adm-modal-content">
<div style={{ padding: '14px 18px', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
          <div className="a-muted a-fs-12 a-mb-12">
            Creates <code className="a-accent">series.json</code> for every monitored series that is missing one. Existing files are left alone — they're refreshed automatically each week.
          </div>

          <button
            className="adm-btn adm-btn-primary" style={{ opacity: running ? 0.6 : 1 }}
            onClick={start}
            disabled={running}
          >
            {running ? '⟳ Running…' : '▶ Start'}
          </button>
        </div>

        {/* Progress */}
        {state && (
          <div className="a-fs-12" style={{ padding: '10px 18px', borderBottom: '1px solid var(--adm-g1)' }}>
            {state.running && (
              <>
                <div className="a-flex a-jc-b a-mb-4">
                  <span className="a-accent">
                    {state.currentSeries || '…'} — {state.done}/{state.queued}
                  </span>
                  <span className="a-faint">{pct}%</span>
                </div>
                <div className="a-ovh a-mb-8" style={{ height: 3, background: 'var(--adm-g1)', borderRadius: 2 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--td-yellow)', transition: 'width 0.4s' }} />
                </div>
              </>
            )}
            <div className="a-flex a-gap-16 a-wrap">
              <span className="a-ok">✓ {state.created} created</span>
              {state.enriched > 0 && <span className="a-info">✦ {state.enriched} enriched</span>}
              <span className="a-faint">{state.skipped} skipped</span>
              {state.errors > 0 && <span className="a-err">✗ {state.errors} errors</span>}
              {state.lastRun && !state.running && (
                <span className="a-dim a-ml-auto">
                  Last run: {new Date(state.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Log */}
        <div ref={logRef} className="a-grow a-mono a-fs-11 a-faint" style={{ overflowY: 'auto', padding: '8px 18px', background: 'var(--adm-g0)', minHeight: 140 }}>
          {state?.log?.length > 0
            ? state.log.map((line, i) => (
                <div key={i} style={{ color: line.startsWith('✓') ? '#4caa60' : line.startsWith('✗') ? 'color-mix(in srgb, var(--td-red) 75%, white)' : line.startsWith('SKIP') ? 'color-mix(in srgb, var(--om-base) 80%, white)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))' }}>
                  {line}
                </div>
              ))
            : <div className="a-dim">No output yet — click Start to begin.</div>
          }
        </div>
      </div>
    </Modal>
  );
}

// ─── Wanted tab ───────────────────────────────────────────────────
function WantedTab({ initialSearch = '' }) {
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

// ─── Logs panel (Download Manager tab) ───────────────────────────
const DM_LOG_LEVEL_COLORS = { error: '#cc5050', warn: '#f5c518', info: '#7aaa88', debug: '#555' };

function LogsPanel() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [copyStatus, setCopyStatus] = useState('');
  const viewport = useRef(null);
  useEffect(() => {
    const es = new EventSource('/api/logs/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onopen = () => setConnection('Live');
    es.onerror = () => setConnection('Reconnecting');
    es.onmessage = e => {
      try { const entry = JSON.parse(e.data); setEntries(prev => [...prev, entry].slice(-500)); } catch {}
    };
    return () => es.close();
  }, []);
  const displayed = entries.filter(e => (filter === 'all' || e.level === filter) && `${e.category} ${e.message}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [entries, following, filter, search]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(displayed.map(e => `${e.ts || ''} ${e.level || ''} [${e.category || ''}] ${e.message || ''}${e.data ? ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : ''}`).join('\n')); setCopyStatus('Copied'); }
    catch { setCopyStatus('Could not copy. Select and copy the log text instead.'); }
  };
  return <div className="dm-logs">
    <div className="dm-triage-toolbar">
      <input className="adm-input" aria-label="Filter logs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Category or message…" />
      <select className="adm-input" aria-label="Log level" value={filter} onChange={e => setFilter(e.target.value)}>{['all','error','warn','info','debug'].map(level => <option key={level} value={level}>{level === 'all' ? 'All levels' : level}</option>)}</select>
      <button className="adm-btn" aria-pressed={following} onClick={() => setFollowing(v => !v)}>{following ? 'Pause following' : 'Follow live'}</button>
      <button className="adm-btn" disabled={!displayed.length} onClick={copy}>Copy filtered logs</button>
      <button className="adm-btn" onClick={() => { setEntries([]); setCopyStatus(''); }}>Clear view</button>
    </div>
    <div className="dm-log-summary" role="status">{connection} · {displayed.length} shown · latest 500 entries retained{!following && ' · Following paused; new entries still collected'}{copyStatus && ` · ${copyStatus}`}</div>
    <div ref={viewport} className="dm-log-viewport" tabIndex={0} aria-label="Log entries" onScroll={() => { const el = viewport.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollowing(false); }}>
      {!displayed.length && <div className="adm-empty">{entries.length ? 'No entries match these filters.' : 'Waiting for log entries…'}</div>}
      {displayed.map((entry,i) => <div key={i} className={`dm-log-entry dm-log-${entry.level}`}>
        <time title={entry.ts}>{entry.ts?.slice(11,19)}</time><strong style={{color: DM_LOG_LEVEL_COLORS[entry.level] || 'var(--om-text)'}}>{entry.level?.toUpperCase()}</strong><span className="dm-log-category">{entry.category}</span>
        <span>{entry.message}{entry.data && <span className="a-muted"> {' '}{typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}</span>}</span>
      </div>)}
    </div>
  </div>;
}

// ─── Styles ───────────────────────────────────────────────────────
// ── Prune ended series (admin) ─────────────────────────────────────
// Lists ended monitored series; ticked by default unless something is still
// wanted or it is the annual of an ongoing series. Removing only drops the
// download tracking (as Remove does); files and the library stay. A series
// can be brought back with + Add Series.
export function PruneEndedModal({ onClose, onDone }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    fetch('/api/monitor/prune/candidates', { headers: authHeader() }).then(r => r.json()).then(d => {
      if (d.error) throw new Error(d.error);
      setData(d); setSel(new Set(d.candidates.filter(c => c.suggested).map(c => c.id)));
    }).catch(e => setError(e.message));
  }, []);
  const rows = (data?.candidates || []).filter(c => !q || `${c.name} ${c.year} ${c.publisher || ''}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = id => setSel(s0 => { const s1 = new Set(s0); s1.has(id) ? s1.delete(id) : s1.add(id); return s1; });
  const chosen = (data?.candidates || []).filter(c => sel.has(c.id));
  const annuals = chosen.reduce((t, c) => t + (c.annuals || 0), 0);
  const run = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/monitor/prune', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ ids: [...sel] }) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Failed (${r.status})`);
      onDone(d);
    } catch (e) { setError(e.message); setBusy(false); setConfirm(false); }
  };
  const cell = { padding: '5px 8px', borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', fontSize: 13, color: 'var(--om-text)' };
  return (
    <Modal title="✂ Prune ended series" onClose={onClose} width={760} closeOnBackdrop={false}>
      <div className="adm-modal-content">
        <div className="a-text2 a-fs-13" style={{ padding: '12px 20px', borderBottom: '1px solid var(--adm-g3)', lineHeight: 1.45 }}>
          Removes ended series from the download manager: their issue tracking and linked annual series. <b className="a-text">Files and the library are not touched</b>;
          the series stays in your library and on its series page. Bring one back any time with + Add Series.
          Unticked by default: series with wanted issues, and annuals of a series that is still ongoing.
        </div>
        {!data ? <div className="a-text2" style={{ padding: 20 }}>{error || 'Loading…'}</div> : (
          <>
            <div className="a-flex a-gap-10 a-ai-c" style={{ padding: '10px 20px' }}>
              <input className="form-input a-grow" placeholder="Filter by name…" value={q} onChange={e => setQ(e.target.value)} />
              <button className="btn btn-ghost a-fs-12" onClick={() => setSel(new Set(data.candidates.filter(c => c.suggested).map(c => c.id)))}>Suggested</button>
              <button className="btn btn-ghost a-fs-12" onClick={() => setSel(new Set())}>None</button>
            </div>
            <div className="a-grow" style={{ overflowY: 'auto', padding: '0 20px' }}>
              <table className="a-w100" style={{ borderCollapse: 'collapse' }}>
                <thead><tr className="a-muted a-fs-12 a-ta-l">
                  <th style={{ padding: '4px 8px', width: 28 }} /><th style={{ padding: '4px 8px' }}>Series</th>
                  <th style={{ padding: '4px 8px' }}>Owned / tracked</th><th style={{ padding: '4px 8px' }}>Note</th>
                </tr></thead>
                <tbody>
                  {rows.map(c => (
                    <tr key={c.id} onClick={() => toggle(c.id)} className="a-ptr" style={{ opacity: sel.has(c.id) ? 1 : 0.6 }}>
                      <td style={cell}><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} /></td>
                      <td style={cell}>{c.name} <span className="a-muted">({c.year || '?'}){c.special ? ' · special' : ''}{c.annuals ? ` · +${c.annuals} annual${c.annuals > 1 ? 's' : ''}` : ''}</span></td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{c.processed} / {c.issues - c.skipped}</td>
                      <td style={{ ...cell, color: c.keep_reasons.length ? '#e0a050' : 'color-mix(in srgb, var(--om-text) 50%, var(--om-base))' }}>{c.keep_reasons.join('; ') || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="a-flex a-gap-10 a-ai-c" style={{ padding: '12px 20px', borderTop: '1px solid var(--adm-g3)' }}>
              <span className="a-text2 a-fs-13 a-grow">
                {chosen.length} of {data.candidates.length} ended series selected{annuals ? ` (+${annuals} linked annual series)` : ''} · {data.total_monitored} monitored in total
              </span>
              {error && <span className="a-err a-fs-13">{error}</span>}
              {!confirm
                ? <button className="btn btn-primary" disabled={!chosen.length || busy} onClick={() => setConfirm(true)}>Remove {chosen.length} from download manager</button>
                : <>
                    <span className="a-text a-fs-13">Sure? This can't be undone (re-add to bring one back).</span>
                    <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
                    <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Removing…' : 'Yes, remove'}</button>
                  </>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

