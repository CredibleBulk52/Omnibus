import PageHeader from '../components/PageHeader';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useLibrary, isAdmin, useAppSettings } from '../App';
import RequestSeriesDialog from '../components/RequestSeries';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import '../readingLists.css';
import '../searchPage.css';
import SeriesCardMenu from '../components/SeriesCardMenu';

// ─── Icons ────────────────────────────────────────────────────────
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const BookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
  </svg>
);
const SeriesIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
    <rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>
    <rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>
  </svg>
);

function SeriesCover({ series }) {
  const [err, setErr] = useState(false);
  const thumb = series.id && !err ? `/api/series/${series.id}/thumbnail` : null;
  return (
    <div className="search-cover">
      {thumb ? <img src={thumb} alt="" onError={() => setErr(true)} /> : <span>{series.name?.slice(0, 4)}</span>}
    </div>
  );
}
function BookCover({ id }) {
  const [err, setErr] = useState(false);
  return <div className="search-cover">{id && !err ? <img src={`/api/books/${id}/thumbnail`} alt="" onError={() => setErr(true)} /> : null}</div>;
}

const META = { enriched: 'Enriched', basic: 'Basic', none: 'No metadata' };
function MetaBadge({ status }) {
  const key = META[status] ? status : 'none';
  return <span className={`search-meta search-meta--${key}`}>{META[key]}</span>;
}

export default function SearchPage() {
  const appSettings = useAppSettings();
  const canDownload = isAdmin() || appSettings.download_manager_admin_only !== 'true';
  const [asking, setAsking] = useState(false);
  const location  = useLocation();
  const navigate  = useNavigate();
  const inputRef  = useRef(null);

  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [activeTab, setActiveTab] = useState('series');
  const { activeLibrary } = useLibrary();

  const requestId = useRef(0);
  const runSearch = useCallback(async (q) => {
    const trimmed = (q ?? query).trim();
    const id = ++requestId.current;
    if (!trimmed) { setResults(null); setLoading(false); setError(''); return; }
    setLoading(true); setError(''); setResults(null);
    try {
      const r  = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}${activeLibrary?.id ? `&libraryId=${encodeURIComponent(activeLibrary.id)}` : ''}`);
      const d  = await r.json();
      if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
      if (id !== requestId.current) return;
      d.essentials = (d.lists || []).filter(x => x.visibility === 'essential');
      d.lists = (d.lists || []).filter(x => x.visibility !== 'essential');
      setResults(d);
      setActiveTab(['series', 'books', 'events', 'runs', 'essentials', 'lists'].find(k => (d[k]?.length || 0) > 0) || 'series');
    } catch (e) { if (id === requestId.current) setError('Search failed: ' + e.message); }
    if (id === requestId.current) setLoading(false);
  }, [query, navigate, activeLibrary]);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q') || '';
    setQuery(q); runSearch(q);
    return () => { requestId.current++; };
  }, [location.search, activeLibrary?.id]);
  const handleSubmit = (e) => { e.preventDefault(); const next = `?q=${encodeURIComponent(query.trim())}`; if (location.search === next) runSearch(query); else navigate(`/search${next}`); };

  const seriesCount = results?.series?.length ?? 0;
  const bookCount   = results?.books?.length  ?? 0;
  const eventCount  = results?.events?.length ?? 0;
  const runCount    = results?.runs?.length   ?? 0;
  const essentialCount = results?.essentials?.length ?? 0;
  const listCount   = results?.lists?.length  ?? 0;
  const issueHits   = results?.issues || [];
  const totalCount  = seriesCount + bookCount + eventCount + runCount + essentialCount + listCount + issueHits.length;

  const tabs = [
    { id: 'series', icon: <SeriesIcon />, label: 'Series', n: seriesCount },
    { id: 'books',  icon: <BookIcon />,   label: 'Issues', n: bookCount },
    { id: 'events', icon: null, label: 'Events', n: eventCount },
    { id: 'runs',   icon: null, label: 'Top Shelf', n: runCount },
    { id: 'essentials', icon: null, label: 'Essentials', n: essentialCount },
    { id: 'lists',  icon: null, label: 'Lists', n: listCount },
  ].filter(t => t.id === 'series' || t.id === 'books' || t.n > 0);

  // Search (2026-10-27): the shared page width, find bar, comic tabs and comic result cards.
  return (
    <div className="page-bg search-page">
      <PageHeader title="Search" borderSeed={2} />
      <div className="curated-page search-content">
        <form onSubmit={handleSubmit} className="find-bar search-bar" role="search">
          <span className="search-bar-icon" aria-hidden="true"><SearchIcon /></span>
          <input ref={inputRef} className="find-box" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search the library"
            placeholder="Search series, issues, events, Top Shelf, lists… (try “Batman 1940” or “Batman 497”)" />
          {query && (
            <button type="button" className="search-clear" aria-label="Clear search"
              onClick={() => { requestId.current++; setQuery(''); setResults(null); setLoading(false); navigate('/search'); inputRef.current?.focus(); }}>✕</button>
          )}
          <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>{loading ? '…' : 'Search'}</button>
        </form>

        {error && <ErrorNote>{error}</ErrorNote>}

        {results !== null && !loading && (totalCount === 0 ? (
          <Empty title={`No results for “${query}”`}
            action={canDownload
              ? <Link className="btn btn-secondary" to={`/downloads?search=${encodeURIComponent(query.trim())}`}>+ Add “{query.trim()}” in Downloads</Link>
              : <button type="button" className="btn btn-secondary" onClick={() => setAsking(true)}>✉ Request “{query.trim()}”</button>}>
            {isAdmin() ? <>Try broader terms, or rescan your library in Library → Libraries &amp; scanning.</> : 'Try broader terms. Not in the library yet? Ask for it below.'}
          </Empty>
        ) : (
          <>
            {issueHits.length > 0 && (
              <div className="search-list search-list--hits">
                {issueHits.map(i => (
                  <Link key={i.id} to={`/read/${i.id}`} className="search-row search-row--hit">
                    <BookCover id={i.id} />
                    <div className="search-row-body">
                      <div className="search-row-title">{i.sub_name || i.series_name} #{i.issue_number}
                        {(i.sub_name ? i.sub_year : i.series_year) ? <span className="search-row-year"> ({i.sub_name ? i.sub_year : i.series_year})</span> : null}</div>
                      {i.sub_name && <div className="search-row-sub">{i.kind === 'annual' ? 'Annual' : 'Special'} · in {i.series_name}{i.series_year ? ` (${i.series_year})` : ''}</div>}
                      {i.title && <div className="search-row-sub search-row-quote">“{i.title}”</div>}
                    </div>
                    <span className="btn btn-primary search-read">▶ Read</span>
                  </Link>))}
              </div>
            )}

            <div className="search-tabs" role="tablist" aria-label="Result types">
              {tabs.map(t => (
                <button key={t.id} type="button" role="tab" aria-selected={activeTab === t.id}
                  className={`rl-tab ${activeTab === t.id ? 'rl-tab--active' : ''}`} onClick={() => setActiveTab(t.id)}>
                  {t.icon}{t.icon ? ' ' : ''}{t.label}<span className="rl-tab-count">{t.n}</span>
                </button>
              ))}
              <span className="search-count">{totalCount} result{totalCount !== 1 ? 's' : ''}</span>
            </div>

            {activeTab === 'series' && (
              <div className="search-list">
                {seriesCount === 0 ? <p className="search-none">No matching series.</p> : results.series.map(s => (
                  <div key={s.id} className="search-row-wrap">
                  <Link to={`/series/${s.id}`} className="search-row">
                    <SeriesCover series={s} />
                    <div className="search-row-body">
                      <div className="search-row-title">{s.name}{s.year && <span className="search-row-year"> ({s.year})</span>}</div>
                      <div className="search-row-meta">
                        {isAdmin() && <MetaBadge status={s.metadata_status} />}
                        <span>{s.book_count ?? 0} issue{s.book_count !== 1 ? 's' : ''}</span>
                        {s.library_name && <span className="search-row-library">{s.library_name}</span>}
                      </div>
                    </div>
                    <span className="search-row-go" aria-hidden="true">›</span>
                  </Link>
                  {/* ⋮ beside the link (a link cannot hold a button): read, unread, add to a box (2026-11-04). */}
                  <SeriesCardMenu series={s} title={s.year ? `${s.name} (${s.year})` : s.name} className="scm-toggle--row" />
                  </div>
                ))}
              </div>
            )}

            {['events', 'runs', 'essentials', 'lists'].includes(activeTab) && (
              <div className="search-list">
                {(results[activeTab] || []).map(x => {
                  const url = activeTab === 'events' ? `/events/${x.id}` : activeTab === 'runs' ? `/canon/run/${x.id}` : x.visibility === 'essential' ? `/essentials/${x.id}` : `/reading-lists/${x.id}`;
                  const title = activeTab === 'runs' ? x.title : x.name;
                  const sub = activeTab === 'events' ? [x.publisher, x.year, `${x.total || 0} issues`].filter(Boolean).join(' · ')
                    : activeTab === 'runs' ? [x.parent_series, `${x.total || 0} issues`].filter(Boolean).join(' · ')
                    : x.visibility === 'essential' ? 'Essentials' : x.mine ? 'Your reading list' : 'Reading list';
                  return (
                    <Link key={x.id} to={url} className="search-row">
                      <BookCover id={x.book_id} />
                      <div className="search-row-body">
                        <div className="search-row-title">{title}</div>
                        <div className="search-row-sub">{sub}</div>
                      </div>
                      <span className="search-row-go" aria-hidden="true">›</span>
                    </Link>);
                })}
              </div>
            )}

            {activeTab === 'books' && (
              <div className="search-table-wrap">
                <table className="search-table">
                  <thead><tr><th>Series</th><th>Issue</th><th>Title</th><th>Actions</th></tr></thead>
                  <tbody>
                    {bookCount === 0
                      ? <tr><td colSpan={4} className="search-none">No matching issues.</td></tr>
                      : results.books.map(b => (
                        <tr key={b.id}>
                          <td className="search-table-series">{b.series_name}{b.series_year && <span className="search-row-year"> ({b.series_year})</span>}</td>
                          <td className="search-table-num">{b.sub_name ? `${b.sub_name}${b.sub_year ? ` (${b.sub_year})` : ''} #${b.issue_number ?? '?'}` : b.issue_number ? `#${b.issue_number}` : '—'}</td>
                          <td className="search-table-title" title={b.filename}>{b.title || b.filename}</td><td className="search-issue-actions"><Link to={`/read/${b.id}`}>Read issue ↗</Link><Link to={`/series/${b.series_id}`}>View series</Link></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ))}

        {results === null && !loading && !error && (
          <Empty title="Search your library">Series, issues, Timeline events, Top Shelf runs and reading lists.</Empty>
        )}
        {loading && <Loading label="Searching…" />}
      </div>
      {asking && <RequestSeriesDialog initialName={query.trim()} onClose={() => setAsking(false)} />}
    </div>
  );
}
