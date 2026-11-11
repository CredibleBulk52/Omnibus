import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import CuratedMast from '../components/CuratedMast';
import PageHeader from '../components/PageHeader';
import BackLink from '../components/BackLink';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useViewState } from '../hooks/useViewState';
import '../topShelf.css';
import '../topShelfBrowsing.css';
import ShelfScroller from '../components/ShelfScroller';
import { isAdmin } from '../App';
import TopShelfAdmin from '../components/TopShelfAdmin';
import useCreatorPhotoRefresh from '../hooks/useCreatorPhotoRefresh';

const META = {
  recommended: {
    label: 'Staff Picks',
    icon: '★',
    kicker: 'The staff picks',
    color: 'var(--td-yellow)',
    rgb: '255,212,59',
    description: 'Hand-picked runs. A good place to start browsing.',
  },
  adapted_to_screen: {
    label: 'Adapted to Screen',
    icon: '↗',
    kicker: 'From page to screen',
    color: '#7cc0f5',
    rgb: '124,192,245',
    description: 'From page to screen. Start with the source.',
  },
  award_winning: {
    label: 'Award Winning',
    icon: '★',
    kicker: 'The award winners',
    color: 'color-mix(in srgb, var(--td-yellow) 75%, white)',
    rgb: '239,196,92',
    description: 'Stories recognised by the industry.',
  },
  critically_acclaimed: {
    label: 'Critically Acclaimed',
    icon: '✦',
    kicker: 'Landmark stories',
    color: 'color-mix(in srgb, var(--td-red) 65%, white)',
    rgb: '237,121,110',
    description: 'Landmark runs with lasting reputations.',
  },
  creators: {
    label: 'Notable Creators',
    icon: '✎',
    kicker: 'Behind the books',
    color: '#b9acd9',
    rgb: '185,172,217',
  },
};
const ORDER = ['adapted_to_screen', 'award_winning', 'critically_acclaimed'];
const PAGE_SIZE = 30;
const theme = (meta) => ({
  '--shelf-colour': meta.color,
  '--shelf-rgb': meta.rgb,
});
const runUrl = (run) =>
  run.event_id ? `/events/${run.event_id}` : `/canon/run/${run.id}`;
const AWARD_NAMES = { eisner: 'Eisner', harvey: 'Harvey', kirby: 'Kirby', hugo: 'Hugo', stoker: 'Bram Stoker' };
const awardText = (a) =>
  [
    a.year,
    AWARD_NAMES[a.award] || a.award,
    a.category && `— ${a.category}`,
  ]
    .filter(Boolean)
    .join(' ');
const runNote = (run, category) =>
  run.categories?.find((c) => c.category === category)?.adaptation_notes ||
  (run.awards || []).map(awardText).join(' · ');

// Preserve the existing daily selection; six covers fit the approved display.
function getDailySlice(runs, count = 6) {
  if (runs.length <= count) return runs;
  let seed = Math.floor(Date.now() / 86400000);
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [...runs].sort(() => rand() - 0.5).slice(0, count);
}

function Cover({ run, className = '', eager = false }) {
  const src = run.coverBookId ? `/api/books/${run.coverBookId}/thumbnail` : '';
  const [failed, setFailed] = useState(null);
  return src && failed !== src ? (
    <img
      className={className}
      src={src}
      alt={run.title || 'Untitled run'}
      loading={eager ? 'eager' : 'lazy'}
      onError={() => setFailed(src)}
    />
  ) : (
    <span
      className={`ts-cover-placeholder ${className}`}
      role="img"
      aria-label={`No cover for ${run.title || 'this run'}`}
    >
      ◈
    </span>
  );
}

function Ownership({ run }) {
  const { owned = 0, total = 0 } = run.issueCounts || {};
  return total > 0 ? (
    <span className="ts-owned">
      {owned}/{total} owned{run.event_id ? ' · Timeline' : ''}
    </span>
  ) : run.event_id ? (
    <span className="ts-owned">Timeline event ↗</span>
  ) : null;
}

function ShelfHeader({ meta, category, count, controls }) {
  return (
    <div className="ts-section-head">
      <div className="ts-shelf-kicker">{meta.kicker}</div>
      <span className="ts-section-index" aria-hidden="true">
        {meta.icon}
      </span>
      <h2>{meta.label}</h2>
      <span className="ts-rule" />
      {category && <Link to={`/canon/${category}`}>Browse {count} runs ↗</Link>}
      {controls}
    </div>
  );
}

function fullDailyShelf(items) {
  const first = getDailySlice(items);
  const selected = new Set(first);
  return [...first, ...items.filter((item) => !selected.has(item))];
}

function RunShelf({ runs, category }) {
  const meta = META[category];
  return (
    <section className="ts-shelf" id={`ts-${category}`} style={theme(meta)}>
      <ShelfScroller label={`${meta.label} shelf`} id={`ts-scroll-${category}`} count={runs.length}
        renderHeader={(controls) => <ShelfHeader meta={meta} category={category} count={runs.length} controls={controls} />}>
        {fullDailyShelf(runs).map((run) => {
          const note = runNote(run, category);
          return (
            <article className="ts-book" key={run.id}>
              <Link className="ts-book-link" to={runUrl(run)}>
                <Cover run={run} />
                <div className="ts-book-text">
                  <h3>{run.title || 'Untitled run'}</h3>
                </div>
              </Link>
              {note && (
                <p className="ts-book-note" title={note}>
                  {note}
                </p>
              )}
              <Ownership run={run} />
            </article>
          );
        })}
        {!runs.length && <p className="ts-empty">No runs added yet.</p>}
      </ShelfScroller>
    </section>
  );
}

function Portrait({ creator }) {
  const [failed, setFailed] = useState(null);
  return creator.image_url && failed !== creator.image_url ? (
    <img
      src={creator.image_url}
      alt={creator.name}
      loading="lazy"
      onError={() => setFailed(creator.image_url)}
    />
  ) : (
    <span className="ts-cover-placeholder" role="img" aria-label={creator.name}>
      {creator.name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}

function CreatorsShelf({ creators }) {
  if (!creators.length) return null;
  return (
    <section
      className="ts-shelf ts-shelf-creators"
      style={theme(META.creators)}
    >
      <ShelfScroller label="Notable Creators shelf" id="ts-scroll-creators" count={creators.length}
        renderHeader={(controls) => <ShelfHeader meta={META.creators} controls={controls} />}>
        {fullDailyShelf(creators).map((c) => (
          <article className="ts-book" key={c.id || c.name}>
            <Link
              className="ts-book-link"
              to={`/series?creator=${encodeURIComponent(c.name)}`}
            >
              <Portrait creator={c} />
              <div className="ts-book-text">
                <h3>{c.name}</h3>
              </div>
            </Link>
            {c.run_count > 1 && (
              <span className="ts-creator-count">{c.run_count} runs</span>
            )}
          </article>
        ))}
      </ShelfScroller>
    </section>
  );
}

function Spotlight({ runs }) {
  const picks = getDailySlice(runs);
  const feature = picks[0];
  if (!feature) return null;
  return (
    <section className="ts-feature">
      <div className="ts-feature-copy">
        <span className="ts-stamp">★ From the staff picks</span>
        <h2>
          <Link to={runUrl(feature)}>{feature.title}</Link>
        </h2>
        <div className="ts-tags">
          {feature.categories?.map(
            (c) =>
              META[c.category] && (
                <span key={c.category}>{META[c.category].label}</span>
              ),
          )}
        </div>
        <p>
          One of {runs.length} hand-picked runs.
          <br />A good place to start browsing.
        </p>
        <a className="ts-cta" href="#ts-recommended">
          Explore staff picks <b aria-hidden="true">↗</b>
        </a>
        <small>Today's shelf spotlight</small>
      </div>
      <Link
        className="ts-feature-art"
        to={runUrl(feature)}
        aria-label={`Open ${feature.title}`}
      >
        {picks.slice(1, 5).map((run, index) => (
          <span aria-hidden="true" key={run.id}>
            <Cover run={run} className={`ts-pile-cover ts-pile-${index}`} eager />
          </span>
        ))}
        <Cover run={feature} className="ts-front-cover" eager />
        <span className="ts-seal" aria-hidden="true">
          STAFF
          <br />
          PICK
        </span>
      </Link>
    </section>
  );
}

// Find a run on the shelf by title, series or creator, whatever it is tagged with (user 2026-10-18).
// Searches the runs already loaded for the page; nothing else on the page changes.
const SHORT_TAG = { adapted_to_screen: 'Adapted', award_winning: 'Award', critically_acclaimed: 'Acclaimed' };
const fold = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function ShelfSearch({ shelf }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const navigate = useNavigate();
  useEffect(() => {
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, []);
  const all = React.useMemo(() => {
    const byId = new Map();
    for (const key of ['recommended', ...ORDER]) for (const run of Array.isArray(shelf?.[key]) ? shelf[key] : []) {
      const cur = byId.get(run.id) || { run, tags: new Set() };
      if (key !== 'recommended') cur.tags.add(key);
      byId.set(run.id, cur);
    }
    return [...byId.values()].map(({ run, tags }) => ({
      run, tags: [...tags],
      title: fold(run.title), series: fold(run.parent_series),
      people: fold((run.creators || []).map((c) => c.person_name).join(' ')),
    }));
  }, [shelf]);
  const term = fold(q.trim());
  const hits = React.useMemo(() => {
    if (term.length < 2) return [];
    const words = term.split(/\s+/);
    const score = (r) => {
      const hay = `${r.title} ${r.series} ${r.people}`;
      if (!words.every((w) => hay.includes(w))) return 0;
      if (r.title.startsWith(term) || r.title.includes(`: ${term}`)) return 4;
      if (r.title.includes(term)) return 3;
      if (r.series.includes(term)) return 2;
      return 1;
    };
    return all.map((r) => [score(r), r]).filter(([n]) => n)
      .sort((a, b) => b[0] - a[0] || a[1].run.title.localeCompare(b[1].run.title)).slice(0, 8).map(([, r]) => r);
  }, [all, term]);
  const go = (r) => { setOpen(false); setQ(''); navigate(runUrl(r.run)); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]); }
    else if (e.key === 'Escape') { if (!q) e.currentTarget.blur(); setQ(''); setOpen(false); }
  };
  return (
    <div className="ts-search" ref={box}>
      <input
        type="text" className="find-box" value={q} placeholder="Find a run…" aria-label="Find a run on Top Shelf"
        role="combobox" aria-expanded={open && hits.length > 0} aria-controls="ts-search-list" aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)} onKeyDown={onKey}
      />
      {open && term.length >= 2 && (
        <div className="ts-search-list" id="ts-search-list" role="listbox">
          {hits.length === 0 && <div className="ts-search-none">No run matches “{q.trim()}”.</div>}
          {hits.map((r, i) => (
            <Link key={r.run.id} to={runUrl(r.run)} role="option" aria-selected={i === active}
              className={`ts-search-hit${i === active ? ' on' : ''}`} onMouseEnter={() => setActive(i)}
              onClick={() => { setOpen(false); setQ(''); }}>
              {r.run.coverBookId ? <img src={`/api/books/${r.run.coverBookId}/thumbnail`} alt="" loading="lazy" /> : <span className="ts-search-blank" />}
              <span>
                <b>{r.run.title}</b>
                <small>{[r.run.parent_series !== r.run.title && r.run.parent_series, r.tags.map((t) => SHORT_TAG[t]).join(' · ')].filter(Boolean).join(' — ')}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const CATEGORY_SHELF = {
  recommended: 'The staff picks',
  adapted_to_screen: 'From page to screen',
  award_winning: 'The winners’ circle',
  critically_acclaimed: 'Landmark stories',
};

function CategoryNote({ note, label }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (open || !ref.current) return;
    const el = ref.current;
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
  }, [note, open]);
  return (
    <div className={`tc-recognition${open ? ' open' : ''}`}>
      <span>{label}</span>
      <p ref={ref}>{note}</p>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Less ↑' : 'More ↓'}
        </button>
      )}
    </div>
  );
}

function CategoryRuns({ runs, category, page, setPage, collectionCount }) {
  const meta = META[category];
  const totalPages = Math.ceil(runs.length / PAGE_SIZE);
  const current = Math.min(
    Math.max(0, Number(page) || 0),
    Math.max(0, totalPages - 1),
  );
  const go = (next) => {
    setPage(next);
    window.scrollTo(0, 0);
  };
  return (
    <>
      <section className="tc-shelf">
        <header className="tc-shelf-head">
          <span aria-hidden="true">{meta.icon}</span>
          <h2>{CATEGORY_SHELF[category]}</h2>
          <div />
          <small>
            {collectionCount} RUN{collectionCount === 1 ? '' : 'S'} IN THE
            COLLECTION
          </small>
        </header>
        <div className="tc-grid">
          {runs
            .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
            .map((run) => {
              const note = runNote(run, category);
              return (
                <article className="tc-book" key={run.id}>
                  <Link className="tc-cover" to={runUrl(run)}>
                    <Cover run={run} />
                  </Link>
                  <h3>
                    <Link to={runUrl(run)}>{run.title || 'Untitled run'}</Link>
                  </h3>
                  {note && (
                    <CategoryNote
                      note={note}
                      label={
                        category === 'award_winning'
                          ? '★ The recognition'
                          : meta.kicker
                      }
                    />
                  )}
                  <footer>
                    <Ownership run={run} />
                    {run.issueCounts?.total > 0 &&
                      run.issueCounts.owned === run.issueCounts.total && (
                        <i>✓ Complete</i>
                      )}
                  </footer>
                </article>
              );
            })}
        </div>
        {!runs.length && <Empty title="No runs match your filters" />}
      </section>
      {totalPages > 1 && (
        <nav className="pagination" aria-label="Run pages">
          <button
            className="page-btn"
            aria-label="First page"
            disabled={current === 0}
            onClick={() => go(0)}
          >
            «
          </button>
          <button
            className="page-btn"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => go(current - 1)}
          >
            ‹
          </button>
          {Array.from({ length: totalPages }, (_, i) =>
            totalPages <= 7 ||
            Math.abs(i - current) <= 2 ||
            i === 0 ||
            i === totalPages - 1 ? (
              <button
                className={`page-btn${i === current ? ' active' : ''}`}
                key={i}
                aria-label={`Page ${i + 1}`}
                aria-current={i === current ? 'page' : undefined}
                onClick={() => go(i)}
              >
                {i + 1}
              </button>
            ) : Math.abs(i - current) === 3 ? (
              <span key={i}>…</span>
            ) : null,
          )}
          <button
            className="page-btn"
            aria-label="Next page"
            disabled={current === totalPages - 1}
            onClick={() => go(current + 1)}
          >
            ›
          </button>
          <button
            className="page-btn"
            aria-label="Last page"
            disabled={current === totalPages - 1}
            onClick={() => go(totalPages - 1)}
          >
            »
          </button>
        </nav>
      )}
    </>
  );
}

// Remount per category so saved filters, pagination and scroll belong to that route.
export default function CanonPage() {
  const { category } = useParams();
  return <CanonView key={category || 'main'} category={category} />;
}

function CanonView({ category }) {
  const [shelf, setShelf] = useState({});
  const [runs, setRuns] = useState([]);
  const [creators, setCreators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloads, setReloads] = useState(0);   // the admin bar asks for a reload after approving
  const [newTab, setNewTab] = useState(null);   // New run dialog: null | 'generate' | 'manual'
  const viewKey = `canon:${category || 'main'}`;
  const [search, setSearch] = useViewState(`${viewKey}:search`, '');
  const [sortBy, setSortBy] = useViewState(`${viewKey}:sort`, 'title');
  const [page, setPage] = useViewState(`${viewKey}:page`, 0);
  useEffect(() => {
    let active = true;
    const read = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Unable to load Top Shelf. Please try again.');
      return r.json();
    };
    const load = async () => {
      try {
        if (category) {
          const data = await read(
            `/api/canon/runs?category=${encodeURIComponent(category)}`,
          );
          if (active) setRuns(Array.isArray(data) ? data : []);
        } else {
          const [data, people] = await Promise.all([
            read('/api/canon/runs/shelf'),
            read('/api/canon/creators').catch(() => []),
          ]);
          if (active) {
            setShelf(data || {});
            setCreators(Array.isArray(people) ? people : []);
          }
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [category, reloads]);
  useCreatorPhotoRefresh(!category && !loading && creators.some(person => !person.image_url), setCreators);
  if (loading)
    return (
      <div className="ts-page ts-browsing">
        <Loading label="Loading Top Shelf…" />
      </div>
    );
  if (error)
    return (
      <div className="ts-page ts-browsing">
        <ErrorNote title="Couldn't load Top Shelf." onRetry={() => window.location.reload()}>{error}</ErrorNote>
      </div>
    );
  if (category) {
    const meta = META[category];
    if (!meta || category === 'creators')
      return (
        <div className="ts-page ts-browsing">
          <Empty title="Unknown shelf" action={<BackLink to="/canon" label="Top Shelf" />} />
        </div>
      );
    const query = search.trim().toLowerCase();
    const displayed = runs
      .filter(
        (r) =>
          !query ||
          r.title?.toLowerCase().includes(query) ||
          r.parent_series?.toLowerCase().includes(query) ||
          r.creators?.some((c) => c.person_name?.toLowerCase().includes(query)),
      )
      .sort((a, b) =>
        sortBy === 'missing'
          ? (b.issueCounts?.total || 0) -
            (b.issueCounts?.owned || 0) -
            ((a.issueCounts?.total || 0) - (a.issueCounts?.owned || 0))
          : (a.title || '').localeCompare(b.title || ''),
      );
    return (
      <div className="ts-page tc-study" style={theme(meta)}>
        <PageHeader title="The Omnibus Collection" note="Top Shelf" borderSeed={4} />
        <div className="curated-page tc-content">
          <BackLink to="/canon" label="Top Shelf" />
          <CuratedMast
            title={meta.label.split(' ').slice(0, -1).join(' ') || meta.label}
            titleEm={meta.label.split(' ').length > 1 ? `${meta.label.split(' ').slice(-1)}.` : null}
            label={`${meta.icon} Top Shelf`}
            intro={<>{meta.description}{category === 'award_winning' && <><br />Eisner and Harvey winners, together on one shelf.</>}</>}
            stamp={['From the', 'Top Shelf:', meta.label]} />
          <div className="tc-controls find-bar" role="search">
            <span className="tc-category">
              {meta.icon} {meta.label}
            </span>
            <input
              className="find-box"
              aria-label="Search by title, series, or creator"
              placeholder="Title, series, or creator…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label="Sort runs"
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value);
                setPage(0);
              }}
            >
              <option value="title">Title A–Z</option>
              <option value="missing">Missing Issues</option>
            </select>
            {(search || sortBy !== 'title') && (
              <button
                className="tc-reset"
                onClick={() => {
                  setSearch('');
                  setSortBy('title');
                  setPage(0);
                }}
              >
                Clear
              </button>
            )}
            <output aria-live="polite">
              {displayed.length} {displayed.length === 1 ? 'run' : 'runs'}
            </output>
          </div>
          <CategoryRuns
            runs={displayed}
            category={category}
            page={page}
            setPage={setPage}
            collectionCount={runs.length}
          />
        </div>
      </div>
    );
  }
  const recommended = Array.isArray(shelf.recommended) ? shelf.recommended : [];
  return (
    <div className="ts-page ts-browsing">
      <PageHeader title="The Omnibus Collection" note="Top Shelf" borderSeed={4} />
      <div className="ts-content curated-page">
        <CuratedMast title="Stories that earn" titleEm="their place."
          label="Top Shelf" intro={<>Legendary runs, award winners and staff picks.<br />Find your next great read.</>}
          stamp={['Only the', 'best on the', 'Top Shelf.']} />
        {isAdmin() && <TopShelfAdmin onChanged={() => setReloads(n => n + 1)} newTab={newTab} onNewTab={setNewTab} />}
        <div className="find-bar ts-find-bar"><ShelfSearch shelf={shelf} /></div>
        <div
          className={`ts-front${recommended.length ? '' : ' ts-front-empty'}`}
        >
          <Spotlight runs={recommended} />
          <aside className="ts-paths" aria-label="Top Shelf categories">
            <div className="ts-paths-label">Find your next great read</div>
            {ORDER.map((cat, i) => {
              const meta = META[cat];
              return (
                <a
                  className={`ts-path ts-path-${i}`}
                  key={cat}
                  href={`#ts-${cat}`}
                >
                  <span className="ts-path-number">0{i + 1}</span>
                  <div>
                    <h2>{meta.label}</h2>
                    <p>{meta.description}</p>
                    <b>{shelf[cat]?.length || 0} runs</b>
                  </div>
                  <span className="ts-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              );
            })}
          </aside>
        </div>
        {recommended.length > 0 && (
          <RunShelf runs={recommended} category="recommended" />
        )}
        {ORDER.map((cat) => (
          <RunShelf
            key={cat}
            category={cat}
            runs={Array.isArray(shelf[cat]) ? shelf[cat] : []}
          />
        ))}
        <CreatorsShelf creators={creators} />
      </div>
    </div>
  );
}
