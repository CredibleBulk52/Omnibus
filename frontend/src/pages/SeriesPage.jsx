import React, { useState, useEffect, useMemo } from 'react';
import { useLibrary, useSeriesCache, isAdmin, useAppSettings } from '../App';
import RequestSeriesDialog from '../components/RequestSeries';
import { useLocation, useNavigate } from 'react-router-dom';
import ShelfView from '../components/ComicSeriesShelfView';
import SeriesSelectControls from '../components/SeriesSelectControls';
import { Navigate } from 'react-router-dom';
import { useViewState } from '../hooks/useViewState';

// ⋮ on each cover: mark read/unread, add to a box (2026-11-04).
const SERIES_MENU = {};

export default function SeriesPage({maintenance}) {
  if(maintenance==='no-cv-id' && isAdmin())return <Navigate to="/cv-admin?tab=no-cv-id" replace/>;
  return <SeriesLibraryPage maintenance={maintenance}/>;
}
function SeriesLibraryPage({ maintenance }) {
  const { activeLibrary } = useLibrary();
  const { fetchSeries } = useSeriesCache();
  const location = useLocation();
  const navigate = useNavigate();
  const characterFilter = new URLSearchParams(location.search).get('character');
  // ?creator=Name (Top Shelf's Notable Creators; replaced the Authors page 2026-10-26).
  const creatorFilter = new URLSearchParams(location.search).get('creator');
  const filterKey = characterFilter || (creatorFilter ? `creator:${creatorFilter}` : '');
  const activeTab = isAdmin() && ['no-metadata'].includes(maintenance) ? maintenance : 'all';
  const [allSeries, setAllSeries] = useState([]);
  const [noMetaSeries, setNoMetaSeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [noMetaLoading, setNoMetaLoading] = useState(false);
  const [noMetaLoaded, setNoMetaLoaded] = useState(false);
  // Page, tab and search survive the Back button (see hooks/useViewState)
  const [page, setPage] = useViewState('series:page', 0);
  const [noMetaPage, setNoMetaPage] = useViewState('series:nometa-page', 0);
  const [search, setSearch] = useViewState('series:search', '');
  const [seenLibrary, setSeenLibrary] = useViewState('series:lib', null);
  const [selectable, setSelectable] = useViewState(`series:${activeTab}:${filterKey}:selecting`, false);
  const [selected, setSelected] = useViewState(`series:${activeTab}:${filterKey}:selected`, []);
  useEffect(() => {
    setLoading(true);
    // Only reset to page 1 when the library actually changed — not when
    // returning to this page with Back.
    const libId = activeLibrary?.id ?? null;
    if (libId !== seenLibrary) { setPage(0); setNoMetaPage(0); setSeenLibrary(libId); setSelected([]); setSelectable(false); }

    setNoMetaLoaded(false);
    setNoMetaSeries([]);
    fetchSeries(activeLibrary)
      .then(data => { setAllSeries(data); setLoading(false); })
      .catch(() => setLoading(false));
    if (activeTab === 'no-metadata') loadNoMeta();
  }, [activeLibrary, fetchSeries]);

  const loadNoMeta = () => {
    if (noMetaLoaded) return;
    setNoMetaLoading(true);
    const url = '/api/series/no-metadata' + (activeLibrary ? `?libraryId=${activeLibrary.id}` : '');
    fetch(url)
      .then(r => r.json())
      .then(d => { setNoMetaSeries(d.content || []); setNoMetaLoading(false); setNoMetaLoaded(true); })
      .catch(() => setNoMetaLoading(false));
  };

  const characterFiltered = useMemo(() => {
    if (activeTab !== 'all' || (!characterFilter && !creatorFilter)) return allSeries;
    if (characterFilter) return allSeries.filter(s =>
      (s.displayCharacters || s.metadata?.characters || [])
        .some(c => c.toLowerCase() === characterFilter.toLowerCase())
    );
    // Creators are stored as "First Last" or "Last, First"; compare both ways.
    const norm = name => {
      const n = String(name || '').toLowerCase().trim();
      const parts = n.split(',').map(p => p.trim());
      return parts.length === 2 ? `${parts[1]} ${parts[0]}` : n;
    };
    const want = norm(creatorFilter);
    return allSeries.filter(s => [...(s.displayWriters || []), ...(s.displayArtists || [])].some(n => norm(n) === want));
  }, [allSeries, characterFilter, creatorFilter, activeTab]);
  const filterName = characterFilter || creatorFilter;
  const filterPhrase = characterFilter ? 'featuring' : 'by';

  const currentSeries = activeTab === 'all' ? characterFiltered : noMetaSeries;
  const currentLoading = activeTab === 'all' ? loading : noMetaLoading;
  const appSettings = useAppSettings();
  const canDownload = isAdmin() || appSettings.download_manager_admin_only !== 'true';
  const [asking, setAsking] = useState(false);
  const currentPage = activeTab === 'all' ? page : noMetaPage;
  const setCurrentPage = activeTab === 'all'
    ? p => { setPage(p); window.scrollTo(0,0); }
    : p => { setNoMetaPage(p); window.scrollTo(0,0); };

  return (
    <div className="page-bg" style={{ padding: 0 }}>
      {asking && <RequestSeriesDialog initialName={search.trim()} onClose={() => setAsking(false)} />}
      {filterName && activeTab === 'all' && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 24px',
          background:'color-mix(in srgb, var(--td-yellow) 8%, transparent)', borderBottom:'1px solid color-mix(in srgb, var(--td-yellow) 20%, transparent)' }}>
          <span style={{ color:'var(--color-accent)', fontSize:'0.85rem' }}>
            Showing series {filterPhrase}: <strong>{filterName}</strong>
          </span>
          <span style={{ color:'var(--text-muted)', fontSize:'0.82rem' }}>
            ({characterFiltered.length} series)
          </span>
          <button onClick={() => navigate('/series')}
            style={{ marginLeft:'auto', padding:'4px 12px', borderRadius:4, fontSize:'0.78rem',
              background:'transparent', border:'1px solid var(--border-subtle)',
              color:'var(--text-muted)', cursor:'pointer' }}>
            ✕ Clear filter
          </button>
        </div>
      )}

        <ShelfView
          seriesMenu={SERIES_MENU}
          compactControls={activeTab === 'all'}
          series={currentSeries}
          loading={currentLoading}
          page={currentPage}
          onPageChange={setCurrentPage}
          searchValue={search}
          onSearchChange={s => { setSearch(s); setPage(0); setNoMetaPage(0); }}
          title={activeTab==='all'
            ? (filterName ? `${filterName} — Series` : (activeLibrary?.name || 'All Series'))
            : 'Series Without Metadata'}
          pageStatsKey={activeTab==='all' && !filterName ? 'series' : undefined}
          pageStatsLibraryId={activeLibrary?.id}
          pageSize={60}
          viewKey={`series:${activeTab}:${filterKey}`}
          selectable={selectable}
          selected={selected}
          onSelectionChange={setSelected}
          extraControls={<>
            <SeriesSelectControls selectable={selectable} setSelectable={setSelectable} selected={selected} setSelected={setSelected} />
            {/* Not in the library: users who may download add it; others ask the admin (2026-10-28). */}
            {canDownload
              ? <button type="button" className="btn btn-ghost" onClick={() => navigate(`/downloads${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`)}>+ Add a series</button>
              : <button type="button" className="btn btn-ghost" onClick={() => setAsking(true)}>✉ Request a series</button>}
          </>}
        />
    </div>
  );
}

