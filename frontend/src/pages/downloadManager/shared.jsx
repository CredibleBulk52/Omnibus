import React, { useState, useEffect } from 'react';

// One search source's outcome in words, so a failed source never looks like an
// empty search (2026-11-03). res: a Promise.allSettled entry; list: its results.
const searchError = msg => (/timeout/i.test(String(msg)) ? `timed out after ${(String(msg).match(/(\d+)ms/) || [0, 45000])[1] / 1000} s` : String(msg || 'failed').slice(0, 80));
export function sourceOutcome(name, res, list) {
  if (res.status === 'rejected') return { name, ok: false, text: 'could not be reached' };
  const err = res.value && !Array.isArray(res.value) && res.value.error;
  if (err) return { name, ok: false, text: searchError(err) };
  return { name, ok: true, text: `${list.length} found` };
}
export function SourceStatus({ items }) {
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


export const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
export const ChevronDown = ({ open }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
export const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
  </svg>
);
export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
export const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
export const CheckIcon = () => (
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
export const STATUS_TIPS = {
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
export function waitingTip(w) {
  if (!w) return '';
  let t = w.reason || 'Waiting to be processed';
  if (w.until) {
    const d = new Date(String(w.until).replace(' ', 'T') + 'Z');
    if (!isNaN(d)) t += d > new Date() ? ` · resumes at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' · retrying shortly';
  }
  return t;
}
export const StatusBadge = ({ status, title }) => {
  const s = STATUS_COLORS[status] || STATUS_COLORS.skipped;
  return (
    <span className="a-fs-10 a-fw6 a-upper a-nowrap" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, borderRadius: 3, padding: '1px 7px', letterSpacing: '0.06em' }} title={title || STATUS_TIPS[status] || status}>{status}</span>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────
export const fmt = bytes => {
  if (!bytes) return '—';
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return (bytes / 1e6).toFixed(0) + ' MB';
};

// Small external-link icon for LOCG / CV links
export function ExtLink({ href, title, children }) {
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
