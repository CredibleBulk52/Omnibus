import CoverSizeControl, { useCoverSize } from '../components/CoverSizeControl';
import PageHeader from '../components/PageHeader';
import HomeFeatures, { ReleasePanel } from '../components/HomeFeatures';
import '../homePanels.css';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loading, ErrorNote } from '../components/StateMessage';
import { Link, useNavigate } from 'react-router-dom';
import { useLibrary, isAdmin, authHeader } from '../App';

const PAD     = 16; // horizontal padding each side of the track
const MIN_GAP = 6;  // minimum gap between books (matches .home-shelf-track gap)

// ─── Hook: computes gap to spread books evenly across shelf width ──
// CSS handles book *sizing* via clamp(80px, 8vw, 160px).
// JS handles *gap* — CSS can't know itemCount vs available width.
// We replicate the clamp formula in JS so gap matches actual rendered width.
//
// Two regimes:
//   1. itemCount fits → distribute leftover space evenly (the "airy" look
//      Favorites and Continue Reading get).
//   2. itemCount overflows → row scrolls horizontally. We still give the
//      books a comfortable gap that scales with book width, so dense rows
//      like Recently Released don't read as a tight strip next to the
//      airier rows above them. The wider gap means more total scroll
//      width, which is fine — that's the whole point of a scroll row.
function useSpreadGap(itemCount) {
  const { width } = useCoverSize();
  const [gap, setGap] = useState(MIN_GAP);

  useEffect(() => {
    const compute = () => {
      const vw        = window.innerWidth;
      const sidebarW  = vw >= 768 ? 80 : 0;  // sidebar absent on mobile
      const bookW     = width; // mirrors CSS clamp
      const available = vw - sidebarW - PAD * 2;
      if (available <= 0 || itemCount <= 1) { setGap(MIN_GAP); return; }

      // Comfortable scroll-row gap: ~20% of book width, clamped so
      // mobile (bookW≈80) gets ~14–16px and desktop (bookW≈160) gets ~28–32px.
      // Tablet sits in the middle, all without overwhelming small screens
      // or looking sparse on big ones.
      const scrollGap = Math.round(Math.min(32, Math.max(14, bookW * 0.20)));

      const maxFit = Math.floor((available + MIN_GAP) / (bookW + MIN_GAP));
      if (itemCount <= maxFit) {
        // All books fit — distribute leftover space evenly as gap
        const computed = (available - itemCount * bookW) / (itemCount - 1);
        setGap(Math.max(MIN_GAP, computed));
      } else {
        // More books than fit — give a comfortable gap, let overflow-x scroll
        setGap(scrollGap);
      }
    };

    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [itemCount, width]);

  return gap;
}

export default function HomePageComic() {
  const { width } = useCoverSize();
  const navigate = useNavigate();
  const { activeLibrary } = useLibrary();
  const [data, setData] = useState(null);
  const [discoverSeries, setDiscoverSeries] = useState([]);
  const [defaultPassword, setDefaultPassword] = useState(false);
  useEffect(() => { if (!isAdmin()) return; fetch('/api/auth/me', { headers: authHeader() }).then(r => (r.ok ? r.json() : null)).then(u => setDefaultPassword(!!u?.default_password)).catch(() => {}); }, []);
  const [topCharacters, setTopCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [spotlightControls, setSpotlightControls] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    setDiscoverSeries([]);
    setTopCharacters([]);
    const libParam = activeLibrary ? `?libraryId=${activeLibrary.id}` : '';

    fetch(`/api/home/v2${libParam}`)
      .then(r => r.json())
      .then(d => { if (active) { setData(d); setLoading(false); } })
      .catch(() => { if (active) setLoading(false); });

    fetch(`/api/home/discover${libParam}`)
      .then(r => r.json())
      .then(d => {
        if (!active) return;
        setDiscoverSeries(d.discoverSeries || []);
        setTopCharacters(d.topCharacters || []);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [activeLibrary]);

  if (loading) return (
    <div className="home-page home-cover-sizing" style={{ "--shelf-cover-width": `${width}px` }}>
      <Loading label="Loading your library…" />
    </div>
  );
  if (!data) return (
    <div className="home-page home-cover-sizing" style={{ "--shelf-cover-width": `${width}px` }}>
      <ErrorNote title="Couldn't load your library." onRetry={() => window.location.reload()}>Check that the Omnibus server is running.</ErrorNote>
    </div>
  );

  const { inProgress = [], recentlyReleased = [], stats = {} } = data;

  const fmtNum = n => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

  // Remove a series from Continue Reading. Optimistic local update,
  // then POST to server. Re-surfaces on next meaningful reading activity.
  const dismissContinueReading = (seriesId) => {
    setData(prev => prev ? {
      ...prev,
      inProgress: prev.inProgress.filter(it => it.seriesId !== seriesId),
    } : prev);
    fetch('/api/home/continue-reading/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ seriesId }),
    })
      .then(r => {
        if (!r.ok) console.warn('Continue Reading dismiss failed', r.status, seriesId);
      })
      .catch(err => console.warn('Continue Reading dismiss error', err));
  };

  // Hide an event / run / list card until that context is read again.
  const dismissContext = (item) => {
    const key = item.fromContext.key;
    setData(prev => prev ? { ...prev, inProgress: prev.inProgress.filter(it => it.fromContext?.key !== key) } : prev);
    fetch('/api/home/continue-reading/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ context: key }),
    }).then(r => { if (!r.ok) console.warn('Continue Reading dismiss failed', r.status, key); })
      .catch(err => console.warn('Continue Reading dismiss error', err));
  };

  // Clear the shown issue's progress (mark it unread), e.g. a book opened only
  // to test something. The series leaves Continue Reading unless other reading
  // in it still qualifies, which the reload shows.
  const clearContinueReading = (item) => {
    setData(prev => prev ? { ...prev, inProgress: prev.inProgress.filter(it => it.id !== item.id) } : prev);
    fetch('/api/books/batch/mark-read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ bookIds: [item.id], completed: false }),
    }).then(r => {
      if (!r.ok) { console.warn('Clear progress failed', r.status, item.id); return; }
      // Refresh Continue Reading: the series may still qualify on other issues.
      const libParam = activeLibrary ? `?libraryId=${activeLibrary.id}` : '';
      return fetch(`/api/home/v2${libParam}`).then(x => x.json()).then(d => setData(prev => prev ? { ...prev, inProgress: d.inProgress || [] } : d));
    })
      .catch(err => console.warn('Clear progress error', err));
  };

  return (
    <div className="home-page home-cover-sizing home-panels" style={{ "--shelf-cover-width": `${width}px` }}>
      <PageHeader title="Your next chapter" borderSeed={5}>
        <span className="hp-stats">{activeLibrary?.name || 'All libraries'} · {fmtNum(stats.seriesCount || 0)} series · {fmtNum(stats.issuesCount || 0)} issues · {fmtNum(stats.readCount || 0)} read</span>
        <span className="hp-banner-refresh" ref={setSpotlightControls} />
        <CoverSizeControl />
      </PageHeader>
      <div className="hp-content">
        {/* A new install with backups available: point the admin at restore (Settings › Backups, 2026-11-02). */}
        {/* First run (2026-11-11): add a comics folder, or restore a backup; and change the default admin password. */}
        {isAdmin() && defaultPassword && <p className="hp-fresh-install">You are still using the default admin password. Change it in <Link to="/settings?tab=people">Settings › People</Link> before anyone else can reach Omnibus.</p>}
        {isAdmin() && !activeLibrary && stats.seriesCount === 0 && <p className="hp-fresh-install">New install? Add your comics folder in <Link to="/library">Library</Link> › Libraries &amp; scanning › + Add Library, then scan it. Moving from another install? Restore a backup in <Link to="/settings?tab=backups">Settings › Backups</Link>.</p>}
        {inProgress.length > 0 && <div className="hp-continue"><HomeShelf label="Continue Reading" items={inProgress} type="book"
          onItemClick={item => item.fromContext ? navigate(item.fromContext.to) : item.fromEvent ? navigate(`/events/${item.eventId}`) : navigate(`/series/${item.seriesId}`)}
          onItemDismiss={item => item.fromContext ? dismissContext(item) : !item.fromEvent ? dismissContinueReading(item.seriesId) : undefined}
          onItemClear={item => !item.fromEvent && !item.fromContext ? clearContinueReading(item) : undefined} /></div>}
        <HomeFeatures controlsTarget={spotlightControls} discoverSeries={discoverSeries} releases={<ReleasePanel items={recentlyReleased} />} />
        {topCharacters.length > 0 && <CharacterShelf characters={topCharacters} navigate={navigate} />}
      </div>
    </div>
  );
}

// ─── CbrBadge ─────────────────────────────────────────────────────
// Compact overlay badge showing critic and/or user score from CBR.
function CbrBadge({ rating }) {
  if (!rating) return null;
  const hasCritic = rating.cbr_score != null;
  const hasUser   = rating.user_score != null;
  if (!hasCritic && !hasUser) return null;

  return (
    <div style={{
      position: 'absolute', bottom: 6, left: 4, zIndex: 10,
      display: 'flex', flexDirection: 'column', gap: 2,
      pointerEvents: 'none',
    }}>
      {hasCritic && (
        <div title={`${rating.cbr_count || 0} critic reviews on Comic Book Roundup`}
          style={{
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid color-mix(in srgb, var(--td-yellow) 70%, transparent)', borderRadius: 3,
            padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 3,
          }}>
          <span style={{ color: 'var(--td-yellow)', fontSize: 10, lineHeight: 1 }}>★</span>
          <span style={{ color: 'color-mix(in srgb, var(--td-yellow) 35%, var(--om-text))', fontSize: 11, fontWeight: 700, lineHeight: 1 }}>
            {rating.cbr_score.toFixed(1)}
          </span>
        </div>
      )}
      {hasUser && (
        <div title={`${rating.user_count || 0} user ratings on Comic Book Roundup`}
          style={{
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid rgba(74,140,204,0.7)', borderRadius: 3,
            padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 3,
          }}>
          <span style={{ color: '#4a8ccc', fontSize: 10, lineHeight: 1 }}>★</span>
          <span style={{ color: '#a8d0f0', fontSize: 11, fontWeight: 700, lineHeight: 1 }}>
            {rating.user_score.toFixed(1)}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── HomeShelf ────────────────────────────────────────────────────
function HomeShelf({ label, items, type, onItemClick, onItemDismiss, onItemClear }) {
  const [menuFor, setMenuFor] = useState(null);   // item key with the ✕ choices open
  const gap = 22;
  const trackRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft]   = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Recompute which arrows should appear based on current scroll position.
  const updateScrollState = useCallback(() => {
    const t = trackRef.current;
    if (!t) return;
    setCanScrollLeft(t.scrollLeft > 4);
    setCanScrollRight(t.scrollLeft + t.clientWidth < t.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const t = trackRef.current;
    if (!t) return;
    updateScrollState();
    t.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('resize', updateScrollState);

    return () => {
      t.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);

    };
  }, [updateScrollState, items.length, gap]);

  const scrollByPage = (dir) => {
    const t = trackRef.current;
    if (!t) return;
    t.scrollBy({ left: dir * t.clientWidth * 0.85, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  return (
    <div className="shelf-section">
      <div className="bookshelf">
        <HomePlank label={label} />
        {canScrollLeft && (
          <button className="home-shelf-arrow home-shelf-arrow--left"
            aria-label="Scroll left" onClick={() => scrollByPage(-1)}>‹</button>
        )}
        {canScrollRight && (
          <button className="home-shelf-arrow home-shelf-arrow--right"
            aria-label="Scroll right" onClick={() => scrollByPage(1)}>›</button>
        )}
        <div className="shelf-wall">
          {/* gap is JS-computed for even spreading; CSS clamp handles book width */}
          <div className="home-shelf-track" ref={trackRef} style={{ gap }} tabIndex={0} role="region" aria-label={label}>
            {items.map(item => {
              const isEventEntry = !!item.fromEvent;
              // An event / run / list being read: its name, and the next issue in its order.
              const ctx = item.fromContext || null;
              const seriesTitle = ctx ? ctx.name : isEventEntry
                ? item.eventName
                : type === 'book'
                  ? (item.seriesName || item.name || '')
                  : (item.displayTitle || item.metadata?.title || item.name || '');
              const issueLabel = ctx ? `Next: ${item.seriesName || ''}${item.issue_number ? ` #${item.issue_number}` : ''}`
                : !isEventEntry && type === 'book' && item.issue_number ? ` #${item.issue_number}` : '';
              const dateLabel  = !isEventEntry && type === 'book' && item.effective_date
                ? ` · ${item.effective_date.slice(0, 10)}` : '';
              const page = Math.max(0, Number(item.page ?? item.readProgress?.page) || 0);
              const pages = Number(item.pagesCount || item.media?.pagesCount) || 0;
              const percent = pages > 0 ? Math.min(100, page / pages * 100) : 0;
              const tooltip = ctx ? `${ctx.label}: ${ctx.name} · ${issueLabel}` : `${seriesTitle}${issueLabel}${dateLabel}`;
              const thumb   = type === 'book'
                ? `/api/books/${item.id}/thumbnail`
                : `/api/series/${item.id}/thumbnail`;
              return (
                <div key={ctx ? `ctx-${ctx.key}` : isEventEntry ? `event-${item.eventId}` : item.id} className={`home-book${ctx ? ' home-book--context' : ''}`} title={tooltip}
                  role="link" tabIndex={0} onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') onItemClick(item); }}
                  onClick={() => onItemClick(item)}
                  style={{ position: 'relative' }}>
                  <div className="home-book-cover">
                    <img src={thumb} alt=""
                      onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                    <div className="shelf-book-placeholder" style={{ display:'none' }}>◈</div>
                    {(isEventEntry || ctx) && (
                      <div style={{ position:'absolute', bottom:0, left:0, right:0, background:'rgba(0,0,0,0.65)', backdropFilter:'blur(2px)', fontSize:'0.55rem', fontFamily:"'Bangers',cursive", letterSpacing:'0.08em', color:'var(--td-yellow,var(--td-yellow))', textTransform:'uppercase', textAlign:'center', padding:'2px 4px', lineHeight:1.3, pointerEvents:'none' }}>
                        {ctx ? ctx.label : 'Event'}
                      </div>
                    )}
                  </div>
                  <div className="hp-book-copy"><strong>{seriesTitle}</strong><span>{isEventEntry ? 'Event reading order' : issueLabel}{dateLabel}</span>{ctx && <small className="hp-context-pos">{ctx.label} · {ctx.read} of {ctx.total} read</small>}{type === 'book' && <><small>{page ? `Page ${page}${pages ? ` of ${pages}` : ''}` : 'Ready to read'}</small><div className="hp-reading-meter" role="progressbar" aria-label="Issue progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pages || !page ? Math.round(percent) : undefined} aria-valuetext={page ? `Page ${page}${pages ? ` of ${pages}` : ''}` : 'Not started'}><i style={{width:`${percent}%`}} /></div>{!isEventEntry && <Link className="hp-read-action" to={`/read/${item.id}${ctx ? ctx.readQs : ''}`} onClick={e=>e.stopPropagation()}>{page ? 'Resume' : 'Read now'} ▶</Link>}{(ctx || (isEventEntry ? item.eventId : item.seriesId)) && <Link className="hp-series-link" to={ctx ? ctx.to : isEventEntry ? `/events/${item.eventId}` : `/series/${item.seriesId}`} onClick={e=>e.stopPropagation()}>{ctx ? `View ${ctx.label === 'Top Shelf run' ? 'run' : ctx.label.toLowerCase()}` : isEventEntry ? 'View event' : 'View series'} →</Link>}</>}</div>
                  <CbrBadge rating={item.rating} />
                  {onItemDismiss && !isEventEntry && (
                    <button
                      className="home-book-dismiss"
                      title={ctx ? `Hide ${ctx.name} until you read it again` : 'Remove from Continue Reading'}
                      onClick={e => { e.stopPropagation(); onItemClear && !ctx ? setMenuFor(menuFor === item.id ? null : item.id) : onItemDismiss(item); }}
                    >✕</button>
                  )}
                  {menuFor === item.id && (
                    <div className="home-book-menu" onClick={e => e.stopPropagation()}>
                      <button title="Hide this series until you read it again" onClick={() => { setMenuFor(null); onItemDismiss(item); }}>Hide</button>
                      <button title="Mark this issue unread and clear its progress" onClick={() => { setMenuFor(null); onItemClear(item); }}>Clear progress</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── CharacterShelf ───────────────────────────────────────────────
function CharacterShelf({ characters, navigate }) {
  const [cvImages, setCvImages] = useState({});
  const gap = useSpreadGap(characters.length);

  useEffect(() => {
    if (!characters.length) return;
    const names = characters.map(c => c.name).join(',');
    fetch(`/api/comicvine/character-search-batch?names=${encodeURIComponent(names)}`)
      .then(r => r.json())
      .then(d => { if (d.results) setCvImages(d.results); })
      .catch(() => {});
  }, [characters]);

  return (
    <div className="shelf-section">
      <div className="bookshelf">
        <HomePlank label="Characters" />
        <div className="shelf-wall">
          <div className="home-shelf-track" style={{ gap }}>
            {characters.map(char => (
              <div key={char.name} className="home-book char-book" title={char.name}
                onClick={() => navigate(`/series?character=${encodeURIComponent(char.name)}`)}>
                <div className="home-book-cover">
                  {cvImages[char.name]
                    ? <img src={cvImages[char.name]} alt={char.name} style={{ borderRadius:4 }} />
                    : <div className="shelf-book-placeholder char-placeholder"
                        style={{ display:'flex', fontSize:'2.5rem', fontFamily:"'Boogaloo', cursive" }}>
                        {char.name.charAt(0)}
                      </div>
                  }
                  <div className="char-name-overlay">
                    <span>{char.name}</span>
                    <span className="char-series-count">{char.count} series</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Plank ────────────────────────────────────────────────────────
function HomePlank({ label }) { return <h2 className="hp-caption hp-shelf-heading">{label}</h2>; }
