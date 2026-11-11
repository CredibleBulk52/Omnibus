// OfflineLibraryPage.jsx
// Route: /offline
// Shows comics saved for offline reading. Lets users delete saved comics
// and see how much storage is being used.

import { useConfirm } from '../components/Confirm';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import '../curatedPage.css';
import './offlinePage.css';
import PageHeader from '../components/PageHeader';
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listOfflineComics,
  removeOfflineComic,
  getStorageInfo,
  isOfflineSupported,
} from '../offlineStorage';

function fmtBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

export default function OfflineLibraryPage() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [comics, setComics]         = useState([]);
  const [storageInfo, setStorageInfo] = useState(null);
  const [loading, setLoading]       = useState(true);
  const [deleting, setDeleting]     = useState({}); // { [bookId]: true }
  const [covers, setCovers]         = useState({}); // { [bookId]: objectURL }
  const supported = isOfflineSupported();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, info] = await Promise.all([listOfflineComics(), getStorageInfo()]);
      setComics(list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)));
      setStorageInfo(info);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load cover images from OPFS (first page of each comic)
  useEffect(() => {
    if (!supported || comics.length === 0) return;
    let cancelled = false;
    async function loadCovers() {
      const { getOfflinePage } = await import('../offlineStorage');
      for (const comic of comics) {
        if (cancelled) break;
        try {
          const url = await getOfflinePage(comic.bookId, 0);
          if (url && !cancelled) {
            setCovers(prev => ({ ...prev, [comic.bookId]: url }));
          }
        } catch {}
      }
    }
    loadCovers();
    return () => {
      cancelled = true;
      // Revoke all object URLs on unmount
      setCovers(prev => {
        Object.values(prev).forEach(url => { try { URL.revokeObjectURL(url); } catch {} });
        return {};
      });
    };
  }, [comics, supported]);

  async function handleDelete(bookId, title) {
    if (!(await confirm({ title: 'Remove offline copy?', message: `Remove "${title}" from this device? It stays in your library.`, confirmLabel: 'Remove', danger: true }))) return;
    setDeleting(d => ({ ...d, [bookId]: true }));
    try {
      await removeOfflineComic(bookId);
      // Revoke cover URL
      if (covers[bookId]) {
        try { URL.revokeObjectURL(covers[bookId]); } catch {}
        setCovers(prev => { const n = { ...prev }; delete n[bookId]; return n; });
      }
      await load();
    } finally {
      setDeleting(d => { const n = { ...d }; delete n[bookId]; return n; });
    }
  }

  const usedPct = storageInfo?.quotaBytes
    ? (storageInfo.usedBytes / storageInfo.quotaBytes) * 100
    : 0;

  return (
    <div className="offline-page">
      <PageHeader title="OFFLINE LIBRARY" borderSeed={5}>
        {comics.length > 0 && (
          <div className="home-stats">
            <div className="home-stat">
              <div className="home-stat-n">{comics.length}</div>
              <div className="home-stat-l">Issues</div>
            </div>
          </div>
        )}
      </PageHeader>

      <div className="curated-page offline-content">
        {!supported && (
          <ErrorNote>
            <strong>Offline reading isn't supported in this browser.</strong><br />
            Use Chrome or Safari on iOS 16.4+ for offline comic reading.
            {window.location.protocol !== 'https:' && (
              <><br /><br />Note: HTTPS is required for offline storage to work.</>
            )}
          </ErrorNote>
        )}

        {supported && storageInfo && (
          <div className="offline-storage">
            <div className="offline-storage-label">
              <span>
                {comics.length} comic{comics.length !== 1 ? 's' : ''} saved
                {' · '}{fmtBytes(storageInfo.usedBytes)} used
              </span>
              {storageInfo.quotaBytes > 0 && (
                <span>{fmtBytes(storageInfo.quotaBytes)} available</span>
              )}
            </div>
            {storageInfo.quotaBytes > 0 && (
              <div className="offline-storage-track">
                <div className={`offline-storage-fill${usedPct > 80 ? ' is-full' : ''}`} style={{ width: `${Math.min(usedPct, 100)}%` }} />
              </div>
            )}
          </div>
        )}

        {loading && (
          <Loading label="Loading offline comics…" />
        )}

        {!loading && supported && comics.length === 0 && (
          <Empty title="No offline comics yet">
            Open any comic in your library and tap <strong>📥 Save Offline</strong> to read it without an internet connection.
          </Empty>
        )}

        {!loading && comics.length > 0 && (
          <div className="offline-grid">
            {comics.map(comic => (
              <div key={comic.bookId} className="offline-card">
                <button type="button" className="offline-cover" onClick={() => navigate(`/read/${comic.bookId}`)} aria-label={`Read ${comic.title}`}>
                  {covers[comic.bookId]
                    ? <img src={covers[comic.bookId]} alt="" />
                    : <span className="offline-cover-blank">📖</span>
                  }
                </button>
                <div className="offline-card-body">
                  <div className="offline-card-title">{comic.title}</div>
                  {comic.seriesTitle && comic.seriesTitle !== comic.title && (
                    <div className="offline-card-meta">{comic.seriesTitle}</div>
                  )}
                  <div className="offline-card-meta">
                    {comic.pageCount} pages · {fmtBytes(comic.sizeBytes)}
                  </div>
                  <div className="offline-card-meta">Saved {fmtDate(comic.savedAt)}</div>
                </div>
                <div className="offline-card-actions">
                  <button type="button" className="offline-read" onClick={() => navigate(`/read/${comic.bookId}`)}>
                    Read
                  </button>
                  <button
                    type="button"
                    className="offline-remove"
                    disabled={deleting[comic.bookId]}
                    onClick={() => handleDelete(comic.bookId, comic.title)}
                    title="Remove from offline storage"
                    aria-label="Remove from offline storage"
                  >
                    {deleting[comic.bookId] ? '…' : '🗑'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
