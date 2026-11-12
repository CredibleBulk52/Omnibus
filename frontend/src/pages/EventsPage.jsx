import { PublisherLogo } from '../components/Branding';
import AdminBar from '../components/AdminBar';
import { ImportButton } from '../components/CuratedTransfer';
import CuratedMast from '../components/CuratedMast';
import PageHeader from '../components/PageHeader';
import { NewEntryButton, NewEntryDialog } from '../components/NewEntry';
import { CreateEventForm } from './EventGenerator';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import PageStats from '../components/PageStats';
import React, {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  memo,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLibrary, isAdmin } from '../App';
import { preferenceKey, readPreference, writePreference } from '../components/eventReadingPath';
import TierNotesRefresh from '../components/TierNotesRefresh';
import '../timeline.css';
import '../comicTimelineNavigation.css';

export const EVENT_TIERS = {
  1: {
    label: 'Crisis-Level Event',
    short: 'Crisis',
    color: 'color-mix(in srgb, var(--td-red) 80%, white)',
    border: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 40%, transparent)',
    bg: 'color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 12%, transparent)',
    gradient:
      'linear-gradient(180deg, color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 22%, transparent) 0%, color-mix(in srgb, color-mix(in srgb, var(--td-red) 80%, white) 5%, transparent) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #e05555 0%, #a83838 100%)',
    stars: 3,
  },
  2: {
    label: 'Major Event',
    short: 'Major',
    color: 'var(--td-yellow)',
    border: 'color-mix(in srgb, var(--td-yellow) 40%, transparent)',
    bg: 'color-mix(in srgb, var(--td-yellow) 10%, transparent)',
    gradient:
      'linear-gradient(180deg, color-mix(in srgb, var(--td-yellow) 20%, transparent) 0%, color-mix(in srgb, var(--td-yellow) 4%, transparent) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #f5c518 0%, #b58a10 100%)',
    stars: 2,
  },
  3: {
    label: 'Crossover Arc',
    short: 'Crossover',
    color: '#4a8ccc',
    border: 'rgba(74,140,204,0.4)',
    bg: 'rgba(74,140,204,0.10)',
    gradient:
      'linear-gradient(180deg, rgba(74,140,204,0.20) 0%, rgba(74,140,204,0.04) 65%, transparent 100%), var(--bg-surface)',
    stripe: 'linear-gradient(180deg, #4a8ccc 0%, #2a5a8c 100%)',
    stars: 1,
  },
};

// Publishers (2026-10-26): "DC Comics", "DC" and "Marvel comics" are one publisher.
export const publisherKey = p => String(p || '').trim().toLowerCase().replace(/\s+comics?$/, '');
const publisherLabel = p => String(p || '').trim().replace(/\s+comics?$/i, '');
// A colour per publisher for the filter; any other publisher uses the page yellow.
const PUBLISHER_COLORS = { dc: '#2f7de1', marvel: '#e2322f', image: '#9aa0a6', 'dark horse': '#b9b9b9', idw: '#3fa7a0', boom: '#f08a24', valiant: '#c33' };

export default function EventsPage() {
  const navigate = useNavigate();
  const { activeLibrary } = useLibrary();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  // New event dialog: null (closed) | 'generate' | 'manual'. /events?new=1 opens it (old /events/new links).
  const [newTab, setNewTab] = useState(() => (searchParams.get('new') && isAdmin() ? 'generate' : null));
  useEffect(() => {
    if (!searchParams.get('new')) return;
    const next = new URLSearchParams(searchParams); next.delete('new'); setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const filterKey = preferenceKey('timeline.' + (activeLibrary?.id || activeLibrary?.name || 'all'));
  const savedFilters = readPreference(filterKey, {});
  const fromUrl = searchParams.has('filters');
  const filterTitle = fromUrl ? searchParams.get('q') || '' : savedFilters.q || '';
  const filterYear = fromUrl ? searchParams.get('year') || '' : savedFilters.year || '';
  const savedPub = fromUrl ? searchParams.get('pub') : savedFilters.pub;   // undefined: not chosen yet
  const updateFilters = patch => {
    const value = { q: filterTitle, year: filterYear, pub: filterPub, ...patch };
    writePreference(filterKey, value);
    const q = new URLSearchParams(searchParams); q.set('filters', '1');
    value.q ? q.set('q', value.q) : q.delete('q');
    value.year ? q.set('year', value.year) : q.delete('year');
    q.set('pub', value.pub || '');
    setSearchParams(q, { replace: true });
  };
  const [activeDecade, setActiveDecade] = useState(null);
  const yearsRef = useRef(null);
  const navRef = useRef(null);
  const publisher = activeLibrary?.name;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    // Every publisher's events; the publisher filter below picks (2026-10-26).
    fetch('/api/events', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Unable to load events.');
        return r.json();
      })
      .then((d) => {
        if (!controller.signal.aborted) setEvents(Array.isArray(d) ? d : []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setEvents([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [publisher]);
  // Back from an event returns to the same place: hooks/scrollMemory (App).
  // Publisher filter: one button per publisher on the timeline. Before a choice is
  // made, the active library's publisher (e.g. the DC Comics library) is selected.
  const publishers = [];
  for (const e of events) {
    const k = publisherKey(e.publisher);
    if (!k) continue;
    const have = publishers.find(x => x.key === k);
    if (have) have.count++; else publishers.push({ key: k, label: publisherLabel(e.publisher), count: 1 });
  }
  publishers.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const libraryPub = publisherKey(publisher);
  const filterPub = savedPub !== undefined && savedPub !== null
    ? (savedPub === '' || publishers.some(x => x.key === savedPub) || !events.length ? savedPub : '')
    : (publishers.some(x => x.key === libraryPub) ? libraryPub : '');
  const pubMatch = e => !filterPub || !e.publisher || publisherKey(e.publisher) === filterPub;
  const sortYears = (a, b) => (Number(a) || Infinity) - (Number(b) || Infinity);
  const allYears = Array.from(
    new Set(events.filter(pubMatch).map((e) => String(e.year || 'Unknown'))),
  ).sort(sortYears);
  const filtered = events.filter(
    (e) =>
      pubMatch(e) &&
      (!filterTitle ||
        e.name.toLowerCase().includes(filterTitle.toLowerCase())) &&
      (!filterYear || String(e.year || 'Unknown') === filterYear),
  );
  const byYear = filtered.reduce((acc, e) => {
    const y = String(e.year || 'Unknown');
    (acc[y] ||= []).push(e);
    return acc;
  }, {});
  const years = Object.keys(byYear).sort(sortYears);
  const yearKey = years.join('|');
  const numericYears = allYears.filter((y) => Number(y));
  const decades = [
    ...new Set(
      years
        .filter((y) => Number(y))
        .map((y) => Math.floor(Number(y) / 10) * 10),
    ),
  ];
  useEffect(() => {
    const update = () => {
      const sections = Array.from(
        yearsRef.current?.querySelectorAll('[data-year]') || [],
      );
      const edge = (navRef.current?.getBoundingClientRect().bottom || 180) + 25;
      const section = sections.find(
        (el) => el.getBoundingClientRect().bottom > edge,
      );
      setActiveDecade(
        section && Number(section.dataset.year)
          ? Math.floor(Number(section.dataset.year) / 10) * 10
          : null,
      );
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [yearKey, loading]);
  const jump = (d) => {
    const year = years.find((y) => Math.floor(Number(y) / 10) * 10 === d);
    const el = document.getElementById(`tl-y-${year}`);
    if (el) {
      const offset = (navRef.current?.offsetHeight || 140) + 68;
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - offset,
        behavior: 'instant',
      });
      setActiveDecade(d);
    }
  };
  const reset = () => updateFilters({ q: '', year: '', pub: '' });
  return (
    <div className="events-outer tl-outer">
      <PageHeader title="The Omnibus Chronicle" note={numericYears.length ? `${numericYears[0]} — ${numericYears[numericYears.length - 1]}` : 'Every era'} borderSeed={1} />
      <div className="chron curated-page">
        <CuratedMast title="Worlds collide." titleEm="History unfolds." label="Timeline"
          intro={<>The crossovers, crises, and turning points that changed everything.<br />Follow the years. Find your next reading order.</>}
          stamp={['Every era.', 'One epic', 'Timeline.']}>
          <PageStats page="events" libraryId={activeLibrary?.id} />
        </CuratedMast>
        {isAdmin() && (
          <AdminBar>
            <NewEntryButton label="New event" onClick={() => setNewTab('generate')} />
            <ImportButton />
            <TierNotesRefresh />
          </AdminBar>
        )}
        {!loading && events.length > 0 && (
          <nav
            ref={navRef}
            className="chron-nav chron-nav-refined find-bar"
            aria-label="Timeline controls"
          >
              <div className="chron-nav-primary">
            {publishers.length > 1 && (
              <div className="chron-pubs" role="group" aria-label="Publisher">
                <span>PUBLISHER</span>
                {[{ key: '', label: 'All', count: events.length }, ...publishers].map(p => (
                  <button
                    key={p.key || 'all'}
                    aria-pressed={filterPub === p.key}
                    style={{ '--pub': PUBLISHER_COLORS[p.key] || 'var(--yellow)' }}
                    onClick={() => updateFilters({ pub: p.key, year: '' })}
                  >
                    {p.key ? <PublisherLogo name={p.label} size="filter" /> : p.label}<small>{p.count}</small>
                  </button>
                ))}
              </div>
            )}
              <div className="chron-tools">
              <input
                className="find-box"
                aria-label="Find an event"
                placeholder="Find an event…"
                value={filterTitle}
                onChange={(e) => updateFilters({ q: e.target.value })}
              />
              <select
                aria-label="Year"
                value={filterYear}
                onChange={(e) => updateFilters({ year: e.target.value })}
              >
                <option value="">All years</option>
                {allYears.map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
              <button className="chron-reset" onClick={reset}>
                Reset
              </button>
              <output aria-live="polite">
                {filtered.length} event{filtered.length === 1 ? '' : 's'}
              </output>
            </div>
              </div>
              <div className="chron-nav-secondary">
            <div className="chron-decades">
              <span>JUMP TO AN ERA</span>
              {decades.map((d) => (
                <button
                  key={d}
                  className={activeDecade === d ? 'active' : ''}
                  aria-current={activeDecade === d ? 'true' : undefined}
                  onClick={() => jump(d)}
                >
                  {d}s
                </button>
              ))}
            </div>

              </div>
          </nav>
        )}
        {loading && <Loading label="Loading the Timeline…" />}
        {error && <ErrorNote title="Couldn't load the Timeline." onRetry={() => window.location.reload()}>{error}</ErrorNote>}
        {!loading && !error && !events.length && (
          <Empty title="No events yet">{isAdmin() ? 'Use + New event to create a reading order.' : 'Events appear here once they are added.'}</Empty>
        )}
        {!loading && events.length > 0 && !filtered.length && (
          <Empty title="No events match your filters" action={<button className="btn btn-secondary" onClick={reset}>Reset filters</button>} />
        )}
        <div className="chron-years" ref={yearsRef}>
          {!loading &&
            years.map((y) => (
              <section
                key={y}
                id={`tl-y-${y}`}
                data-year={y}
                className="chron-year"
                aria-label={y}
              >
                <header className="chron-year-label">
                  <b>{y}</b>
                  <span>
                    {byYear[y].length} event{byYear[y].length === 1 ? '' : 's'}
                  </span>
                </header>
                <div className="chron-panels">
                  {/* The API orders by year, saved position, then name.
                      Preserve that order through filtering and year grouping. */}
                  {byYear[y].map((e) => (
                      <EventPanel key={e.id} event={e} />
                    ))}
                </div>
              </section>
            ))}
        </div>
      </div>
      {newTab && (
        <NewEntryDialog title="New event" tab={newTab} onTab={setNewTab} onClose={() => setNewTab(null)}>
          {tab => (
            <div className="new-entry-pad">
              {/* writeNotes: the updated generator leaves tier notes out; the editor opens Write tier notes. */}
              <CreateEventForm mode={tab} onCreated={(id, o) => navigate(`/events/${id}/edit${o && o.writeNotes ? '?tool=annotate' : ''}`)} />
            </div>
          )}
        </NewEntryDialog>
      )}
    </div>
  );
}

// ─── Tier Badge ───────────────────────────────────────────────────
// Comic-style label — Bangers font + clip-path bevel, matches .tag treatment.
export function TierBadge({ tier }) {
  const t = EVENT_TIERS[tier];
  if (!t) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 13px 3px 9px',
        fontFamily: "'Bangers', cursive",
        fontSize: 11,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'color-mix(in srgb, var(--om-base) 70%, black)',
        background: t.color,
        clipPath: 'polygon(0 0, 100% 0, 94% 100%, 0 100%)',
        border: '2px solid #000',
        lineHeight: 1.2,
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: 0, color: 'color-mix(in srgb, var(--om-base) 70%, black)' }}>
        {'★'.repeat(t.stars)}
      </span>
      {t.short}
    </span>
  );
}

const EventPanel = memo(function EventPanel({ event }) {
  const navigate = useNavigate();
  const t = EVENT_TIERS[event.event_tier] ? Number(event.event_tier) : 2;
  const img = event.thumbnail_book_id
    ? `/api/books/${event.thumbnail_book_id}/thumbnail`
    : event.cover_image || null;
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const descRef = useRef(null);
  useEffect(() => {
    setFailed(false);
  }, [img]);
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el || open) return;
    let active = true;
    const check = () => {
      if (active) setOverflows(el.scrollHeight > el.clientHeight + 2);
    };
    check();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    observer?.observe(el);
    window.addEventListener('resize', check);
    document.fonts?.ready.then(check);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [open, event.description]);
  const pct =
    event.total_issues > 0
      ? Math.min(
          100,
          Math.round((event.owned_issues / event.total_issues) * 100),
        )
      : 0;
  const pub = String(event.publisher || '').replace(/\s*comics$/i, '');
  const hasArt = img && !failed;
  const go = () => navigate(`/events/${event.id}`);
  return (
    <article
      className={`chron-card chron-tier-${t}${hasArt ? '' : ' chron-no-art'}${open ? ' expanded' : ''}`}
    >
      <a
        className="chron-art"
        href={`/events/${event.id}`}
        aria-label={`Open ${event.name}`}
        onClick={(e) => {
          if (
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey &&
            !e.altKey &&
            e.button === 0
          ) {
            e.preventDefault();
            go();
          }
        }}
      >
        {hasArt ? (
          <img
            src={img}
            alt={`${event.name} cover`}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        ) : (
          <span>{event.year || '—'}</span>
        )}
      </a>
      <div className="chron-copy">
        <div className="chron-meta">
          <span>
            {'★'.repeat(EVENT_TIERS[t].stars)} {EVENT_TIERS[t].short}
            {t === 1 ? ' event' : ''}
          </span>
          <b className="chron-publisher"><PublisherLogo name={event.publisher || pub} size={t === 1 ? 'event-large' : 'event'} /></b>
        </div>
        {event.source === 'manual' && (
          <small className="chron-manual">✎ Manual</small>
        )}
        <h2>
          <a
            href={`/events/${event.id}`}
            onClick={(e) => {
              if (
                !e.ctrlKey &&
                !e.metaKey &&
                !e.shiftKey &&
                !e.altKey &&
                e.button === 0
              ) {
                e.preventDefault();
                go();
              }
            }}
          >
            {event.name}
          </a>
          {event.draft ? <span className="chron-draft" title="Imported and not yet published: only admins see it. Publish it in the editor's Details.">Draft</span> : null}
        </h2>
        {event.description && (
          <p ref={descRef} className="chron-description">
            {event.description}
          </p>
        )}
        {(overflows || open) && (
          <button
            className="chron-more"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Read less ↑' : 'Read more ↓'}
          </button>
        )}
        <footer>
          <span>
            {event.owned_issues || 0}/{event.total_issues || 0}{' '}
            <small>in library</small>
          </span>
          <i aria-hidden="true">
            <b style={{ width: `${pct}%` }} />
          </i>
        </footer>
      </div>
    </article>
  );
});
