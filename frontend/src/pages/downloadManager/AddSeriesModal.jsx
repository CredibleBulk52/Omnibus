import Modal from '../../components/Modal';
import CoverPeek from '../../components/CoverPeek';
import React, { useState, useEffect, useCallback } from 'react';
import { CheckIcon, FolderIcon, SearchIcon, useToast } from './shared';

// ─── Directory Picker Modal ───────────────────────────────────────
export function DirectoryPicker({ onSelect, onClose }) {
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
export function useSuggestDirectory(selected, setParentDir) {
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
export function DirectorySuggestionPanel({ selected, suggestion, loadingSuggestion, parentDir, setParentDir, onBrowse }) {
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
export function MergeSeriesPicker({ sourceScannedSeriesId, sourceName, onClose, onMerged }) {
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
export function SpecialOfRow({ value, onChange }) {
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
