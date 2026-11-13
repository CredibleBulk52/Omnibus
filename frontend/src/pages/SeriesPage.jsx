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

  // Series grouping (2026-11-13): series shelved under a home (tie-ins) leave the browser; the
  // filter row shows them again, and admins can list the one-shots that have no shelf yet.
  // A search shows everything, with each grouped series labelled with its home.
  const [groupView, setGroupView] = useViewState('series:group', 'main');
  const issuesOf = s => s.displayTotalIssues ?? s.seriesJson?.total_issues ?? s.book_count ?? 0;
  const groupCounts = useMemo(() => ({
    hidden: characterFiltered.filter(s => s.group?.hidden).length,
    grouped: characterFiltered.filter(s => s.group).length,
    homeless: characterFiltered.filter(s => !s.group && issuesOf(s) === 1).length,
  }), [characterFiltered]);
  const groupFiltered = useMemo(() => {
    if (search.trim()) return characterFiltered;
    if (groupView === 'grouped') return characterFiltered.filter(s => s.group);
    if (groupView === 'homeless') return characterFiltered.filter(s => !s.group && issuesOf(s) === 1);
    return characterFiltered.filter(s => !s.group?.hidden);
  }, [characterFiltered, groupView, search]);
  const currentSeries = activeTab === 'all' ? groupFiltered : noMetaSeries;
  // The view switch sits in the toolbar beside the count (2026-11-13).
  const views = [['main', 'Series', null, 'Your series, without the tie-ins kept on a home series\' Specials tab'],
    ['grouped', 'Shelved', groupCounts.grouped, 'Series shown on another series\' Specials tab'],
    ...(isAdmin() ? [['homeless', 'No shelf', groupCounts.homeless, 'One-shots not on any Specials shelf yet']] : [])];
  const viewSwitch = activeTab === 'all' && (groupCounts.grouped > 0 || (isAdmin() && groupCounts.homeless > 0)) && !search.trim()
    ? <div className="csb-view-switch" role="radiogroup" aria-label="Which series to show">
        {views.map(([k, label, n, tip]) => <button key={k} type="button" role="radio" aria-checked={groupView === k} title={tip}
          onClick={() => { setGroupView(k); setPage(0); }}>{label}{n != null && <b>{n.toLocaleString()}</b>}</button>)}
      </div>
    : null;
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
          viewKey={`series:${activeTab}:${filterKey}:${groupView}`}
          selectable={selectable}
          selected={selected}
          onSelectionChange={setSelected}
          viewSwitch={viewSwitch}
          moreMenu={<>
            {!selectable && <button type="button" onClick={() => { setSelectable(true); setSelected([]); }}>☐ Select series</button>}
            {canDownload
              ? <button type="button" onClick={() => navigate(`/downloads${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`)}>+ Add a series</button>
              : <button type="button" onClick={() => setAsking(true)}>✉ Request a series</button>}
          </>}
          extraControls={<>
            {activeTab === 'no-metadata' && isAdmin() && <CreateFromFiles libraryId={activeLibrary?.id || null}
              onFinished={() => { setNoMetaLoaded(false); setNoMetaSeries([]); fetch('/api/series/no-metadata' + (activeLibrary ? `?libraryId=${activeLibrary.id}` : ''))
                .then(r => r.json()).then(d => { setNoMetaSeries(d.content || []); setNoMetaLoaded(true); }).catch(() => {}); }} />}
            {/* Select lives in the ⋯ menu; while selecting, its actions and Cancel show here. */}
            {selectable && <SeriesSelectControls selectable={selectable} setSelectable={setSelectable} selected={selected} setSelected={setSelected} />}
          </>}
        />
    </div>
  );
}


// Series without details › "Create from files" (2026-11-13): for every folder without a series.json,
// the Comic Vine volume of its comics (Metron first), then the normal create and enrich, one at a time.
function CreateFromFiles({ libraryId, onFinished }) {
  const { invalidate } = useSeriesCache();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const poll = () => fetch('/api/series/no-metadata/create-from-files').then(r => r.json()).then(setJob).catch(() => {});
  useEffect(() => { poll(); }, []);
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(async () => {
      const d = await fetch('/api/series/no-metadata/create-from-files').then(r => r.json()).catch(() => null);
      if (!d) return;
      setJob(d);
      if (!d.running) { clearInterval(t); invalidate(null); onFinished?.(); }
    }, 3000);
    return () => clearInterval(t);
  }, [job?.running]);
  const start = async () => {
    setError('');
    const r = await fetch('/api/series/no-metadata/create-from-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ libraryId }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error || `HTTP ${r.status}`); else setJob(d);
  };
  const running = !!job?.running;
  return <span className="create-from-files">
    {running
      ? <><small>Creating {job.done} of {job.total}{job.current ? ` · ${job.current}` : ''}</small>
          <button type="button" className="btn btn-ghost" onClick={() => fetch('/api/series/no-metadata/create-from-files/stop', { method: 'POST' }).then(poll)}>Stop</button></>
      : <button type="button" className="btn btn-ghost" onClick={start}
          title="For each folder here: find its Comic Vine series from the comics inside (Metron first), then create and enrich its series.json, one folder at a time">✦ Create from files</button>}
    {!running && job?.finishedAt && <small> Last run: {job.created} created{job.skipped?.length ? `, ${job.skipped.length} skipped` : ''}{job.note ? ` · ${job.note}` : ''}</small>}
    {!running && job?.skipped?.length > 0 && <details className="create-from-files-skipped"><summary>Skipped</summary>
      {job.skipped.map(x => <div key={x.id}>{x.name}: {x.reason}</div>)}</details>}
    {error && <small style={{ color: 'var(--td-red, #e55)' }}> {error}</small>}
    <style>{`.create-from-files { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; } .create-from-files small { color: var(--text-muted); }
      .create-from-files-skipped { font-size: 0.8rem; color: var(--text-muted); max-height: 200px; overflow: auto; }`}</style>
  </span>;
}
