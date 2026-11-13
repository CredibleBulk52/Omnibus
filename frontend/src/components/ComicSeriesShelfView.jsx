import AddToBoxModal from './AddToBoxModal';
import SeriesCardMenu from './SeriesCardMenu';
import { useCoverSize } from './CoverSizeControl';
import SharedShelfRow from './ShelfRow';
import SeriesControls from './ComicSeriesControls';
import { seriesLabel } from './seriesBrowserLabels.mjs';
import '../comicSeriesBrowser.css';
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Loading, Empty } from './StateMessage';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { isAdmin } from '../App';
import { useViewState } from '../hooks/useViewState';
import PageStats from './PageStats';
import PageHeader from './PageHeader';

const ALPHA = ['#','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];

const BOOK_W  = 150;  // fixed book width — never changes
const BOOK_H  = 225;  // fixed book height
const MIN_GAP = 4;    // minimum gap between books
const PAD     = 20;   // shelf horizontal padding each side
const PLANK_H = 58;

// ─── Layout hook ─────────────────────────────────────────────────
// Uses window.innerWidth as the source of truth — this is the ONLY
// value that correctly shrinks when zooming in, because offsetWidth
// on any content div can be stuck wide by overflowing children.
// Sidebar width (80px CSS var --sidebar-w) is subtracted manually.
const SIDEBAR_W = 80;

function useShelfLayout() {
  const { width } = useCoverSize();
  const containerRef = useRef(null); // kept for API compatibility, not used for measurement
  const [layout, setLayout] = useState({ cols: 8, gap: MIN_GAP });

  useEffect(() => {
    const compute = () => {
      // window.innerWidth always reflects current zoom level correctly
      const sidebar = window.innerWidth <= 767 ? 0 : SIDEBAR_W;
      const W = window.innerWidth - sidebar - PAD * 2;
      if (W <= 0) return;

      const cols = Math.max(1, Math.floor((W + MIN_GAP) / (width + MIN_GAP)));
      const leftover = W - cols * width;
      const gap = cols > 1 ? leftover / (cols - 1) : 0;

      setLayout(prev =>
        prev.cols === cols && Math.abs(prev.gap - gap) < 0.5 ? prev : { cols, gap }
      );
    };

    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [width]);

  return [containerRef, layout];
}

// ─── Phone detection ─────────────────────────────────────────────
// At < 600px the shelf switches to a cover grid
function useIsPhone() {
  const [isPhone, setIsPhone] = useState(window.innerWidth < 600);
  useEffect(() => {
    const h = () => setIsPhone(window.innerWidth < 600);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return isPhone;
}

export function AlphaBar({ active, onSelect, available = [] }) {
  return (
    <div className="alpha-bar">
      <button className={`alpha-btn ${active === null ? 'active' : ''}`}
        onClick={() => onSelect(null)}>All</button>
      {ALPHA.map(l => (
        <button key={l}
          className={`alpha-btn ${active === l ? 'active' : ''} ${!available.includes(l) ? 'dim' : ''}`}
          onClick={() => available.includes(l) && onSelect(l)}
          disabled={!available.includes(l)}
        >{l}</button>
      ))}
    </div>
  );
}

export function getAlphaKey(title = '') {
  const t = title.replace(/^(the |a |an )/i, '').trim().toUpperCase();
  const first = t.charAt(0);
  if (/[0-9]/.test(first)) return '#';
  if (/[A-Z]/.test(first)) return first;
  return '#';
}

// Reviews (2026-10-23): the Comic Book Roundup critic score (out of 10) for sort and filter.
const criticScore = s => (s.displayRating && s.displayRating.cbr_score != null ? Number(s.displayRating.cbr_score) : null);
const REVIEW_OPTIONS = ['9+', '8+', '7+', 'Has a score', 'No score'];
function reviewsMatch(s, value) {
  const v = criticScore(s);
  if (value === 'No score') return v == null;
  if (v == null) return false;
  if (value === 'Has a score') return true;
  const min = parseFloat(value);
  return Number.isFinite(min) ? v >= min : true;
}

export default function ShelfView({
  series = [],
  loading = false,
  page = 0,
  onPageChange,
  searchValue = '',
  onSearchChange,
  showSearch = true,
  compactControls = false,
  title,
  extraControls,
  headerStats,
  pageStatsKey,
  pageStatsLibraryId,
  selectable = false,
  selected = [],
  onSelectionChange,
  pageSize = 60,
  onSeriesClick,
  viewKey,          // when set, filters/sort and scroll are remembered for the Back button
  seriesMenu = null, // ⋮ on each cover (SeriesCardMenu): {} for the menu, { onRemove } on your own box (2026-11-04)
}) {
  const navigate = useNavigate();
  const [alphaFilter, setAlphaFilter] = useViewState(viewKey && `${viewKey}:alpha`, null);
  const [sortBy, setSortBy] = useViewState(viewKey && `${viewKey}:sort`, 'az'); // 'az' | 'recent' | 'rating' (critic score)
  const [containerRef, layout] = useShelfLayout();
  const { width } = useCoverSize();
  const [addToCollModal, setAddToCollModal] = useState(false);
  const [collections, setCollections] = useState([]);
  const isPhone = useIsPhone();

  // ─── Chip filters ─────────────────────────────────────────────────
  // Each chip filter is a { field, value } pair — AND logic between chips
  const [chips, setChips] = useViewState(viewKey && `${viewKey}:chips`, []);
  const [allTags, setAllTags] = useState([]);
  React.useEffect(() => { fetch('/api/tags').then(r=>r.json()).then(t=>setAllTags(Array.isArray(t)?t:[])).catch(()=>{}); }, []);
  const addChip   = (field, value) => { if (value && !chips.some(c => c.field === field && c.value === value)) setChips(prev => [...prev, { field, value }]); onPageChange?.(0); };
  const removeChip = (field, value) => { setChips(prev => prev.filter(c => !(c.field === field && c.value === value))); onPageChange?.(0); };
  const clearChips = () => { setChips([]); onPageChange?.(0); };

  const searched = useMemo(() => {
    if (!searchValue) return series;
    const q = searchValue.toLowerCase();
    // Helper: checks if a name matches query in either "First Last" or "Last, First" format
    const nameMatches = (name) => {
      const n = name.toLowerCase();
      if (n.includes(q)) return true;
      // Try reversing "Last, First" → "First Last"
      if (n.includes(',')) {
        const parts = n.split(',').map(p => p.trim());
        if (parts.length === 2) {
          const reversed = `${parts[1]} ${parts[0]}`;
          if (reversed.includes(q)) return true;
        }
      }
      return false;
    };
    return series.filter(s => {
      const title      = (s.displayTitle || s.metadata?.title || s.name || '').toLowerCase();
      const publisher  = (s.displayPublisher || '').toLowerCase();
      const era        = (s.displayEra || '').toLowerCase();
      const genres     = (s.displayGenres || []).map(g => g.toLowerCase());
      const tags       = (s.displayTags || []).map(t => t.toLowerCase());
      const characters = (s.displayCharacters || []).map(c => c.toLowerCase());
      return (
        title.includes(q) ||
        String(s.displayYear || s.seriesJson?.year || '').includes(q) ||
        publisher.includes(q) ||
        era.includes(q) ||
        genres.some(g => g.includes(q)) ||
        tags.some(t => t.includes(q)) ||
        characters.some(c => c.includes(q)) ||
        (s.displayWriters || []).some(w => nameMatches(w)) ||
        (s.displayArtists || []).some(a => nameMatches(a))
      );
    });
  }, [series, searchValue]);

  // Apply chip filters on top of text search
  const chipFiltered = useMemo(() => {
    if (chips.length === 0) return searched;
    return searched.filter(s => chips.every(chip => {
      switch (chip.field) {
        case 'genre':     return (s.displayGenres || []).some(g => g.toLowerCase() === chip.value.toLowerCase());
        case 'publisher': return (s.displayPublisher || '').toLowerCase() === chip.value.toLowerCase();
        case 'status':    return (s.displayStatus || '').trim().toLowerCase() === chip.value.trim().toLowerCase();
        case 'tag':       return (s.displayTags || []).some(t => t.toLowerCase() === chip.value.toLowerCase());
        case 'award':
          if (chip.value === 'Eisner Winner')    return s.displayAwards?.some(a => a.winner == 1 && a.award === 'eisner');
          if (chip.value === 'Harvey Winner')    return s.displayAwards?.some(a => a.winner == 1 && a.award === 'harvey');
          if (chip.value === 'Eisner Nominated') return s.displayAwards?.some(a => a.award === 'eisner');
          if (chip.value === 'Harvey Nominated') return s.displayAwards?.some(a => a.award === 'harvey');
          return true;
        case 'reviews': return reviewsMatch(s, chip.value);
        default:          return true;
      }
    }));
  }, [searched, chips]);

  const filtered = useMemo(() => {
    if (!alphaFilter) return chipFiltered;
    return chipFiltered.filter(s =>
      getAlphaKey(s.displayTitle || s.metadata?.title || s.name || '') === alphaFilter
    );
  }, [chipFiltered, alphaFilter]);

  const sorted = useMemo(() => {
    if (sortBy === 'rating') {
      // Highest Comic Book Roundup critic score first; more reviews wins a tie; unscored last.
      return [...filtered].sort((a, b) => {
        const sa = criticScore(a), sb = criticScore(b);
        if (sa == null && sb == null) return 0;
        if (sa == null) return 1;
        if (sb == null) return -1;
        return sb - sa || (b.displayRating?.cbr_count || 0) - (a.displayRating?.cbr_count || 0);
      });
    }
    if (sortBy === 'recent') {
      return [...filtered].sort((a, b) => {
        const da = a.latestReleaseDate || '';
        const db_ = b.latestReleaseDate || '';
        if (!da && !db_) return 0;
        if (!da) return 1;
        if (!db_) return -1;
        return da < db_ ? 1 : da > db_ ? -1 : 0;
      });
    }
    return filtered; // 'az' — server already returns A-Z
  }, [filtered, sortBy]);

  // Build facet option lists from the searched (pre-chip) series so dropdowns always show all options
  const facets = useMemo(() => {
    const genres = new Set(), publishers = new Set(), statuses = new Set(), awards = new Set();
    searched.forEach(s => {
      (s.displayGenres || []).forEach(g => g && genres.add(g));
      if (s.displayPublisher) publishers.add(s.displayPublisher);
      const st = (s.displayStatus || '').trim();
      if (st) statuses.add(st.charAt(0).toUpperCase() + st.slice(1).toLowerCase());
      if (s.displayAwards?.some(a => a.winner == 1 && a.award === 'eisner')) awards.add('Eisner Winner');
      if (s.displayAwards?.some(a => a.winner == 1 && a.award === 'harvey')) awards.add('Harvey Winner');
      if (s.displayAwards?.some(a => a.award === 'eisner')) awards.add('Eisner Nominated');
      if (s.displayAwards?.some(a => a.award === 'harvey')) awards.add('Harvey Nominated');
    });
    const reviews = REVIEW_OPTIONS.filter(o => searched.some(s => reviewsMatch(s, o)));
    return {
      genre:     [...genres].sort(),
      publisher: [...publishers].sort(),
      status:    [...statuses].sort(),
      tag:       allTags,
      award:     [...awards].sort(),
      reviews:   reviews.length > 1 || (reviews.length === 1 && reviews[0] !== 'No score') ? reviews : [],
    };
  }, [searched, allTags]);

  const available = useMemo(() => {
    const letters = new Set(['all']);
    chipFiltered.forEach(s => letters.add(getAlphaKey(s.displayTitle || s.metadata?.title || s.name || '')));
    return letters;
  }, [chipFiltered]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  useEffect(() => {
    if (!loading && page > Math.max(0, totalPages - 1)) onPageChange?.(Math.max(0, totalPages - 1));
  }, [loading, page, totalPages, onPageChange]);
  const pageItems = sorted.slice(page * pageSize, (page + 1) * pageSize);

  // Return to the same scroll position when coming Back to this list

  // Shift+click selects everything between the last clicked series and this
  // one, in the current sort order (across pages too).
  const anchorRef = useRef(null);
  const handleBookClick = useCallback((s, e) => {
    if (selectable) {
      e.preventDefault();
      const idx = sorted.findIndex(x => x.id === s.id);
      const anchor = anchorRef.current != null ? sorted.findIndex(x => x.id === anchorRef.current) : -1;
      if (e.shiftKey && anchor >= 0 && idx >= 0) {
        try { window.getSelection()?.removeAllRanges(); } catch {}
        const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
        const range = sorted.slice(a, b + 1).map(x => x.id);
        onSelectionChange?.([...new Set([...selected, ...range])]);
        anchorRef.current = s.id;
        return;
      }
      anchorRef.current = s.id;
      const isSelected = selected.includes(s.id);
      onSelectionChange?.(isSelected
        ? selected.filter(id => id !== s.id)
        : [...selected, s.id]);
      return;
    }
    if (onSeriesClick) { onSeriesClick(s); return; }
    navigate(`/series/${s.id}`);
  }, [selectable, selected, onSelectionChange, navigate, sorted]);

  const openAddToCollection = async () => {
    const cols = await fetch('/api/collections').then(r => r.json());
    // Library boxes (no owner) are admin-managed; other users see only their own.
    setCollections((Array.isArray(cols) ? cols : []).filter(c => isAdmin() || c.owner_id));
    setAddToCollModal(true);
  };

  const addToCollection = async (collectionId) => {
    await Promise.all(selected.map(sid =>
      fetch(`/api/collections/${collectionId}/series`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId: sid }),
      })
    ));
    onSelectionChange?.([]);
    setAddToCollModal(false);
  };

  return (
    <div className="page-bg comic-series-browser" style={{ "--shelf-cover-width": `${width}px` }} ref={containerRef}>

      {(title || headerStats || pageStatsKey) && (
        <PageHeader title={title}>
          {headerStats}
          {pageStatsKey && <PageStats page={pageStatsKey} libraryId={pageStatsLibraryId} />}
        </PageHeader>
      )}

      <SeriesControls compact={compactControls} viewKey={viewKey}
        resultCount={sorted.length} selectionControls={<div className="csb-selection-controls">              {selectable && selected.length > 0 && (
                <>
                  <span style={{ fontSize:'0.82rem', color:'var(--color-accent)', fontFamily:'Boogaloo,cursive' }}>
                    {selected.length} selected
                  </span>
                  <button className="btn btn-primary" onClick={openAddToCollection}>+ Add to Collection</button>
                  <button className="btn btn-ghost" onClick={() => onSelectionChange?.([])}>Clear</button>
                </>
              )}
              {extraControls}</div>}
        activeCount={chips.length + (searchValue.trim() ? 1 : 0) + (alphaFilter ? 1 : 0)} recent={sortBy === 'recent' ? 'Recent issue release' : sortBy === 'rating' ? 'Critic score' : null}
        onClear={() => { clearChips(); setAlphaFilter(null); onSearchChange?.(''); setSortBy('az'); onPageChange?.(0); }}
        alpha={<AlphaBar
        active={alphaFilter}
        onSelect={l => { setAlphaFilter(l); onPageChange?.(0); }}
        available={Array.from(available)}
      />}
      >
        {showSearch && (<FilterBar
          searchValue={searchValue}
          onSearchChange={v => { onSearchChange?.(v); onPageChange?.(0); }}
          facets={facets}
          chips={chips}
          addChip={addChip}
          removeChip={removeChip}
          clearChips={clearChips}
          count={sorted.length}
          sortBy={sortBy}
          onSortChange={v => { setSortBy(v); onPageChange?.(0); }}
          selectable={selectable}
          selected={selected}
          pageItems={pageItems}
          onSelectionChange={onSelectionChange}
        />)}
      </SeriesControls>

      {loading && series.length === 0 ? (
        <Loading label="Loading series…" />
      ) : filtered.length === 0 ? (
        <Empty title="No series found" action={<button className="btn btn-secondary" onClick={() => { clearChips(); setAlphaFilter(null); onSearchChange?.(''); setSortBy('az'); onPageChange?.(0); }}>Show all series</button>}>
          Try another title or clear your filters.
        </Empty>
      ) : (
        isPhone ? (
          <CoverGrid
            items={pageItems}
            selected={selected}
            selectable={selectable}
            onBookClick={handleBookClick}
            seriesMenu={seriesMenu}
          />
        ) : (
          <ShelfGrid
            items={pageItems}
            selected={selected}
            selectable={selectable}
            onBookClick={handleBookClick}
            layout={layout}
            seriesMenu={seriesMenu}
          />
        )
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button className="page-btn" onClick={() => onPageChange?.(Math.max(0, page - 1))} disabled={page === 0}>‹</button>
          {Array.from({ length: totalPages }, (_, i) => {
            if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 2)
              return <button key={i} className={`page-btn ${i === page ? 'active' : ''}`} onClick={() => onPageChange?.(i)}>{i + 1}</button>;
            if (Math.abs(i - page) === 3)
              return <span key={i} className="page-ellipsis">…</span>;
            return null;
          })}
          <button className="page-btn" onClick={() => onPageChange?.(Math.min(totalPages - 1, page + 1))} disabled={page === totalPages - 1}>›</button>
        </div>
      )}

      {addToCollModal && (
        <AddToBoxModal intro={`Adding ${selected.length} series to:`} collections={collections}
          onAdd={addToCollection} onClose={() => setAddToCollModal(false)} />
      )}
    </div>
  );
}

// ─── FilterBar ────────────────────────────────────────────────────
// Unified single-row filter: search + facet pill-buttons + active chips
function FilterBar({ searchValue, onSearchChange, facets, chips, addChip, removeChip, clearChips,
                     count, sortBy, onSortChange, selectable, selected, pageItems, onSelectionChange }) {
  const [openDropdown, setOpenDropdown] = useState(null);

  // Close dropdown on outside click
  React.useEffect(() => {
    if (!openDropdown) return;
    const close = () => setOpenDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openDropdown]);

  const filterDefs = [
    { field:'genre',     label:'Genre'     },
    { field:'publisher', label:'Publisher' },
    { field:'status',    label:'Status'    },
    { field:'tag',       label:'User Tags' },
    { field:'award',     label:'Awards'    },
    { field:'reviews',   label:'Reviews'   },
  ].filter(({ field }) => facets[field]?.length > 0);

  const hasChips = chips.length > 0;

  return (
    <div className="filter-bar-wrap">
      {/* ── Main row ── */}
      <div className="filter-bar">
        {/* Search */}
        <div className="filter-search find-box find-box-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:0.45, flexShrink:0 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            className="filter-search-input"
            aria-label="Find a series, creator or character"
            placeholder="Find a series, creator or character…"
            value={searchValue}
            onChange={e => onSearchChange(e.target.value)}
          />
          {searchValue && (
            <button className="filter-search-clear" onClick={() => onSearchChange('')}>✕</button>
          )}
        </div>

        {/* Divider */}
        <div className="filter-bar-divider" />

        {/* Facet pill buttons */}
        <div className="filter-pills">
          {filterDefs.map(({ field, label }) => {
            const activeCount = chips.filter(c => c.field === field).length;
            const isOpen = openDropdown === field;
            return (
              <FacetDropdown
                key={field}
                field={field}
                label={label}
                options={facets[field]}
                chips={chips}
                activeCount={activeCount}
                isOpen={isOpen}
                onToggle={e => { e.stopPropagation(); setOpenDropdown(isOpen ? null : field); }}
                onSelect={val => { addChip(field, val); setOpenDropdown(null); }}
                onRemove={val => removeChip(field, val)}
              />
            );
          })}
        </div>

        {/* Sort toggles — lives alongside facet pills */}
        <div className="filter-bar-divider" />
        <div className="sort-toggle-group">
          <button
            className={`sort-toggle${sortBy === 'az' ? ' active' : ''}`}
            onClick={() => onSortChange?.('az')}
          >A – Z</button>
          <button
            className={`sort-toggle${sortBy === 'recent' ? ' active' : ''}`}
            onClick={() => onSortChange?.('recent')}
          >Recent issue release</button>
          <button
            className={`sort-toggle${sortBy === 'rating' ? ' active' : ''}`}
            title="Comic Book Roundup critic score, highest first"
            onClick={() => onSortChange?.('rating')}
          >Critic score</button>
        </div>

        {/* Spacer + count + optional select-all */}
        <div className="filter-bar-spacer" />
        {selectable && (
          <button className="btn btn-secondary" style={{ fontSize:'0.78rem', padding:'4px 12px', whiteSpace:'nowrap' }}
            onClick={() => pageItems.every(s => selected.includes(s.id)) ? onSelectionChange(selected.filter(id => !pageItems.some(s => s.id === id))) : onSelectionChange([...new Set([...selected, ...pageItems.map(s => s.id)])])}>
            {pageItems.every(s => selected.includes(s.id)) ? 'Deselect page' : 'Select page'}
          </button>
        )}
        <span className="filter-count">{count.toLocaleString()} series</span>
      </div>

      {/* ── Active chip row ── */}
      {hasChips && (
        <div className="filter-chips">
          {chips.map(chip => (
            <span key={`${chip.field}:${chip.value}`} className="filter-chip">
              <span className="filter-chip-field">{chip.field}</span>
              <span className="filter-chip-value">{chip.value}</span>
              <button className="filter-chip-remove" onClick={() => removeChip(chip.field, chip.value)}>✕</button>
            </span>
          ))}
          <button className="filter-chip-clear" onClick={clearChips}>Clear all</button>
        </div>
      )}
    </div>
  );
}

// ─── FacetDropdown ────────────────────────────────────────────────
// The menu is rendered via a React portal to document.body so it
// escapes the overflow-y:auto on .main-content that would otherwise
// clip any absolutely-positioned descendant regardless of z-index.
function FacetDropdown({ field, label, options, chips, activeCount, isOpen, onToggle, onSelect, onRemove }) {
  const active    = activeCount > 0;
  const btnRef    = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  // Recalculate position whenever the menu opens or window resizes/scrolls
  useEffect(() => {
    if (!isOpen || !btnRef.current) return;
    const place = () => {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: Math.min(r.bottom + 6, window.innerHeight - 100), left: Math.max(8, Math.min(r.left, window.innerWidth - 288)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true); // capture scroll on any ancestor
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);

  const menu = isOpen ? ReactDOM.createPortal(
    <div
      className="facet-menu csb-facet-menu"
      style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: Math.min(280, window.innerWidth - 16), maxHeight: Math.max(80, window.innerHeight - menuPos.top - 8), overflowY: 'auto' }}
      onClick={e => e.stopPropagation()}
    >
      <div className="facet-menu-inner">
        {options.map(o => {
          const selected = chips.some(c => c.field === field && c.value === o);
          return (
            <button
              key={o}
              className={`facet-menu-item ${selected ? 'facet-menu-item--active' : ''}`}
              onClick={() => selected ? onRemove(o) : onSelect(o)}
            >
              <span className="facet-menu-check">{selected ? '✓' : ''}</span>
              {o}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className="facet-dropdown">
      <button
        ref={btnRef}
        className={`facet-pill ${active ? 'facet-pill--active' : ''}`}
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        {label}
        {active && <span className="facet-pill-count">{activeCount}</span>}
        <span className="facet-pill-caret" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {menu}
    </div>
  );
}

// ─── ShelfGrid ────────────────────────────────────────────────────
// Receives layout computed from page-bg ref (always viewport-width,
// never affected by content overflow).
function ShelfGrid({ items, selected, selectable, onBookClick, layout, seriesMenu }) {
  const { cols, gap } = layout;

  const rows = useMemo(() => {
    const out = [];
    for (let i = 0; i < items.length; i += cols) out.push(items.slice(i, i + cols));
    return out;
  }, [items, cols]);

  return (
    <div className="shelf-content">
      {rows.map((row, ri) => (
        <ShelfRow
          key={ri}
          books={row}
          cols={cols}
          gap={gap}
          selected={selected}
          selectable={selectable}
          onBookClick={onBookClick}
          seriesMenu={seriesMenu}
        />
      ))}
    </div>
  );
}

// ─── Single shelf row ─────────────────────────────────────────────
function ShelfRow({ books, cols, gap, selected, selectable, onBookClick, seriesMenu }) {
  const { width } = useCoverSize();
  return <SharedShelfRow bookWidth={width} bookHeight={width * 1.5} renderLabel={s => <SeriesLabel series={s} onClick={e => onBookClick(s, e)} />} books={books} cols={cols} gap={gap} renderBook={s => <ShelfBook series={s} isSelected={selected.includes(s.id)} selectable={selectable} seriesMenu={seriesMenu} onClick={e => onBookClick(s, e)} />} />;
}

export function ShelfBook({ series, onClick, isSelected, selectable, seriesMenu = null }) {
  const { width } = useCoverSize();
  const title = series.displayTitle || series.metadata?.title || series.name || '';
  const open = (
    <button type="button" aria-label={`${selectable ? 'Select' : 'Open'} ${title}`} aria-pressed={selectable ? !!isSelected : undefined}
      className={`shelf-book ${isSelected ? 'selected' : ''}`}
      title={title}
      onClick={onClick}
      style={{ width, flexShrink: 0 }}
    >
      <div className="shelf-book-cover" style={{ width, height: width * 1.5 }}>
        {selectable && <div className="shelf-book-check" aria-hidden="true">{isSelected ? '✓' : ''}</div>}
        <img
          src={`/api/series/${series.id}/thumbnail`}
          alt=""
          onError={e => {
            e.target.style.display = 'none';
            e.target.nextSibling.style.display = 'flex';
          }}
        />
        <div className="shelf-book-placeholder" style={{ display:'none' }}><span>{title}<small>Cover unavailable</small></span></div>
        {/* Award badge — top-right corner */}
        {series.displayAwards && series.displayAwards.some(a => a.winner) && (
          <div className="thumb-award-badge" title={series.displayAwards.filter(a=>a.winner).map(a=>`${a.award==='eisner'?'Eisner':'Harvey'} Winner – ${a.category} (${a.year})`).join('\n')}>
            {series.displayAwards.some(a => a.winner && a.award === 'eisner') ? '🏆' : '🥇'}
          </div>
        )}
        {/* CBR score badge — bottom-right corner */}
        {series.displayRating && series.displayRating.cbr_score && (
          <div className="thumb-cbr-badges">
            <div className="thumb-cbr-badge thumb-cbr-badge--critic" title={`CBR: ${series.displayRating.cbr_score} (${series.displayRating.cbr_count} reviews)`}>
              ★ {series.displayRating.cbr_score}
            </div>
            {series.displayRating.user_score && (
              <div className="thumb-cbr-badge thumb-cbr-badge--user" title={`User: ${series.displayRating.user_score}`}>
                👤 {series.displayRating.user_score}
              </div>
            )}
          </div>
        )}
      </div>
    </button>
  );
  if (!seriesMenu || selectable) return open;
  // With the ⋮ menu: the card and the menu button side by side in one lifted frame
  // (a button cannot hold another button).
  return (
    <div className="shelf-book-menu-frame" style={{ width, flexShrink: 0 }}>
      {open}
      <SeriesCardMenu series={series} title={title} onRemove={seriesMenu.onRemove || null} />
    </div>
  );
}

// ─── CoverGrid — phone-only alternative to shelf rows ────────────
function SeriesLabel({ series, onClick }) {
  const { title, year, fullTitle } = seriesLabel(series);
  return <button type="button" className="csb-label" onClick={onClick} title={fullTitle} aria-label={`Open ${fullTitle}`}>
    <span className="csb-title">{title}</span>
    <span className="csb-meta">{year && <span className="csb-year">{year}</span>}{series.book_count > 0 && <span>{series.book_count} issue{series.book_count !== 1 ? 's' : ''}</span>}</span>
    {series.group?.homeName && <span className="csb-home" title={`On the Specials shelf of ${series.group.homeName}`}>in {series.group.homeName}</span>}
  </button>;
}
function CoverGrid({ items, onBookClick, selected, selectable, seriesMenu }) {
  return <div className="cover-grid">{items.map(s => <div key={s.id} className="cover-grid-item">
    <ShelfBook series={s} isSelected={selected.includes(s.id)} selectable={selectable} seriesMenu={seriesMenu} onClick={e => onBookClick(s, e)} />
    <SeriesLabel series={s} onClick={e => onBookClick(s, e)} />
  </div>)}</div>;
}
