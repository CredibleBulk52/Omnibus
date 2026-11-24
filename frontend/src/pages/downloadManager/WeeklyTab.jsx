import Modal from '../../components/Modal';
import CoverPeek from '../../components/CoverPeek';
import { filterWeeklyIssues } from '../../utils/weeklyIssues.mjs';
import React, { useState, useEffect, useRef } from 'react';
import { DirectoryPicker, DirectorySuggestionPanel, SpecialOfRow, useSuggestDirectory } from './AddSeriesModal';
import { CheckIcon, ExtLink, STATUS_TIPS } from './shared';

// ─── Weekly releases tab ──────────────────────────────────────────

/** Returns the Monday of the week containing `date` as YYYY-MM-DD */
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // local day: 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  // Return as YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtWeekLabel(monday) {
  const start = new Date(monday + 'T12:00:00Z');
  const end   = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  const opts  = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

const NO_IMAGE_PANELS = [
  { bg: '#1a0a0a', border: '#5a1a1a', lines: ['POW!'],          textColor: '#e05050', font: 'bold 8px serif' },
  { bg: '#0a0a1a', border: '#1a1a5a', lines: ['ZAP!'],           textColor: '#5080e0', font: 'bold 8px serif' },
  { bg: '#0a1a0a', border: '#1a5a1a', lines: ['WHAM!'],          textColor: '#50c050', font: 'bold 7px serif' },
  { bg: '#111118', border: '#5a5a1a', lines: ['KAPOW!'],         textColor: '#f5c518', font: 'bold 7px serif' },
  { bg: '#1a0a1a', border: '#5a1a5a', lines: ['BIFF!'],          textColor: '#c050c0', font: 'bold 8px serif' },
  { bg: '#0a1a1a', border: '#1a5a5a', lines: ['CRUNCH!'],        textColor: '#50c0c0', font: 'bold 7px serif' },
  { bg: '#1a0f0a', border: '#5a3a1a', lines: ['SLAM!'],          textColor: '#e08050', font: 'bold 8px serif' },
  { bg: '#0f0a1a', border: '#3a1a5a', lines: ['THWACK!'],        textColor: '#8050e0', font: 'bold 6px serif' },
  { bg: '#1a0a0f', border: '#5a1a3a', lines: ['ZONK!'],          textColor: '#e05080', font: 'bold 8px serif' },
  { bg: '#0a1a14', border: '#1a5a3a', lines: ['BLAM!'],          textColor: '#50e090', font: 'bold 8px serif' },
];

function NoImagePlaceholder({ seed }) {
  const idx = seed
    ? [...seed].reduce((acc, c) => acc + c.charCodeAt(0), 0) % NO_IMAGE_PANELS.length
    : 0;
  const panel = NO_IMAGE_PANELS[idx];

  return (
    <svg
      width={32} height={48}
      viewBox="0 0 32 48"
      className="a-noshrink a-block" style={{ borderRadius: 2 }}
    >
      {/* halftone-ish background */}
      <rect width={32} height={48} fill={panel.bg} />
      {/* dot pattern */}
      {Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 4 }, (_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={4 + col * 8}
            cy={4 + row * 8}
            r={1.2}
            fill={panel.border}
            opacity={0.5}
          />
        ))
      )}
      {/* border */}
      <rect x={1} y={1} width={30} height={46} fill="none" stroke={panel.border} strokeWidth={1.5} />
      {/* starburst lines */}
      {[0,45,90,135].map(angle => {
        const rad = angle * Math.PI / 180;
        return (
          <line
            key={angle}
            x1={16} y1={24}
            x2={16 + Math.cos(rad) * 18}
            y2={24 + Math.sin(rad) * 24}
            stroke={panel.border}
            strokeWidth={0.8}
            opacity={0.4}
          />
        );
      })}
      {/* speech-bubble style box */}
      <rect x={3} y={16} width={26} height={16} rx={2} fill={panel.border} opacity={0.3} />
      <rect x={3} y={16} width={26} height={16} rx={2} fill="none" stroke={panel.border} strokeWidth={0.8} />
      {/* text */}
      <text
        x={16} y={26}
        textAnchor="middle"
        dominantBaseline="middle"
        fill={panel.textColor}
        style={{ font: panel.font, letterSpacing: '-0.5px', textShadow: 'none' }}
      >
        {panel.lines[0]}
      </text>
    </svg>
  );
}

const STATUS_STYLE = {
  processed: { bg: '#0e2a1a', color: '#4caa70', border: '#4caa7033', label: 'HAVE' },
  downloaded: { bg: '#0e1a2a', color: '#4a80cc', border: '#4a80cc33', label: 'DL\'D' },
  snatched:  { bg: '#111118', color: 'var(--td-yellow)', border: 'color-mix(in srgb, var(--td-yellow) 20%, transparent)', label: 'SNATCHED' },
  wanted:    { bg: '#1a0e0e', color: '#c07070', border: '#c0707033', label: 'WANTED' },
};


// ─── Digital-line detector ────────────────────────────────────────
// Returns a sentinel key (used as publisher group key) if the issue
// belongs to a digital-only line that deserves its own section.
// Returns null for regular print comics.
const DIGITAL_SECTIONS = {
  '__INFINITY_COMICS__': {
    label: 'Marvel Infinity Comics',
    badge: 'Digital • Vertical Scroll',
    color: 'var(--td-red)',        // Marvel red
    borderColor: '#5a1010',
    badgeColor: '#e05050',
  },
  '__DC_GO__': {
    label: 'DC Go!',
    badge: 'Digital • Kids / All-Ages',
    color: '#1a6fb5',        // DC blue
    borderColor: '#0d2d50',
    badgeColor: '#4090d0',
  },
};

function getDigitalSectionKey(issue) {
  const name = (issue.volume?.name || '').toLowerCase();
  if (name.includes('infinity comic')) return '__INFINITY_COMICS__';
  // DC Go series typically end with "Go!" or contain " go!" or "dc go"
  if (/\bgo!\s*$/.test(name) || name.includes('dc go')) return '__DC_GO__';
  return null;
}

function WeeklyIssueCard({ issue, onAddSeries }) {
  const status = issue.issue_status;
  const st = status ? STATUS_STYLE[status] : null;
  return (
    <div className={`dm-weekly-issue${issue.monitored ? ' is-monitored' : ''}`}>
      <div className="dm-weekly-identity">
        <span className="dm-weekly-title">{issue.volume.name}</span>
        <span className="dm-weekly-number">#{issue.issue_number || '—'}</span>
        {String(issue.issue_number).match(/^0*1$/) && <span className="dm-weekly-debut">#1 issue</span>}
      </div>
      <div className="dm-weekly-links">
        <ExtLink href={issue.locg_url} title="View issue on League of Comic Geeks">LOCG ↗</ExtLink>
        <ExtLink href={issue.cv_url} title="View series on Comic Vine">CV ↗</ExtLink>
      </div>
      <div className="dm-weekly-state">
        {issue.monitored && <span className="dm-weekly-monitored">✓ Monitored</span>}
        {status && <span className="dm-weekly-status" style={st ? { color: st.color, background: st.bg, borderColor: st.border } : undefined} title={STATUS_TIPS[status] || status}>{st?.label || status}</span>}
        {!issue.monitored && <button className="adm-btn dm-weekly-monitor" onClick={() => onAddSeries(issue.volume)} title={`Choose and confirm ${issue.volume.name} for site monitoring`}>+ Monitor series</button>}
      </div>
    </div>
  );
}

const ITEMS_PER_PAGE = 100; // items per page across all publishers

export function WeeklyTab({ onSeriesAdded }) {
  const todayMonday = getMondayOf(new Date());
  const [week, setWeek]       = useState(todayMonday);
  const [data, setData]       = useState(null);   // { issues, total_singles, start, end }
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [page, setPage]       = useState(0);
  const [addTarget, setAddTarget] = useState(null); // volume obj to pre-fill AddSeriesModal

  const [query, setQuery] = useState('');
  const [publisher, setPublisher] = useState('all');
  const [monitorFilter, setMonitorFilter] = useState('all');
  const requestId = useRef(0);
  useEffect(() => { setPage(0); }, [query, publisher, monitorFilter]);
  const weekRefreshFired = useRef(new Set()); // track weeks already refreshed this session

  const load = async (monday) => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    setData(null);
    setPage(0);
    try {
      const r = await fetch(`/api/weekly?start=${monday}`);
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Release request failed (${r.status})`);
      if (request !== requestId.current) return;
      setData(d);
    } catch (e) {
      if (request !== requestId.current) return;
      setError(e.message);
    }
    setLoading(false);

    // Trigger CV refresh for monitored series only when viewing the current week,
    // and only once per week per session to avoid hammering CV on tab flips.
    if (monday === todayMonday && !weekRefreshFired.current.has(monday)) {
      weekRefreshFired.current.add(monday);
      fetch('/api/monitor/refresh-current-week', { method: 'POST' }).catch(() => {});
    }
  };

  // Load on mount and week change
  useEffect(() => { load(week); }, [week]);

  const shiftWeek = (delta) => {
    const d = new Date(week + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta * 7);
    setWeek(d.toISOString().slice(0, 10));
  };

  const releases = data?.issues || [];
  const publisherOptions = [...new Set([...releases.map(i => i.volume?.publisher || 'Unknown'), ...(publisher !== 'all' ? [publisher] : [])])].sort((a,b) => a.localeCompare(b));
  const filteredReleases = filterWeeklyIssues(releases, query, publisher, monitorFilter);
  const monitoredCount = releases.filter(i => i.monitored).length;

  // Group issues by publisher (or digital-section sentinel) for display.
  // Digital-only lines (Infinity Comics, DC Go) get their own sentinel keys
  // so they render in separate named sections at the bottom of the list.
  const grouped = data ? filteredReleases.reduce((acc, issue) => {
    const key = getDigitalSectionKey(issue) || issue.volume.publisher || 'Unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(issue);
    return acc;
  }, {}) : {};

  // Sort: regular publishers alphabetically first, digital sentinels last
  const sortGroupKeys = (a, b) => {
    const aDigital = a in DIGITAL_SECTIONS;
    const bDigital = b in DIGITAL_SECTIONS;
    if (aDigital !== bDigital) return aDigital ? 1 : -1; // digital goes to end
    return a.localeCompare(b);
  };

  // Flatten for pagination (preserve publisher grouping order)
  const publishers = Object.keys(grouped).sort(sortGroupKeys);
  const allIssues  = publishers.flatMap(p => grouped[p]);
  const totalPages = Math.ceil(allIssues.length / ITEMS_PER_PAGE);
  const displayPage = Math.min(page, Math.max(0, totalPages - 1));
  const pageIssues = allIssues.slice(displayPage * ITEMS_PER_PAGE, (displayPage + 1) * ITEMS_PER_PAGE);

  // Re-group the current page's issues by the same key scheme
  const pageGrouped = pageIssues.reduce((acc, issue) => {
    const key = getDigitalSectionKey(issue) || issue.volume.publisher || 'Unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(issue);
    return acc;
  }, {});
  const pagePublishers = Object.keys(pageGrouped).sort(sortGroupKeys);

  const isCurrentWeek = week === todayMonday;

  return (
    <div className="dm-weekly">
      {/* Week navigator */}
      <div className="dm-week-navigation a-flex a-ai-c a-gap-10 a-mb-16">
        <button
          className="adm-btn a-fs-13" style={{ padding: '5px 12px' }}
          onClick={() => shiftWeek(-1)}
          disabled={loading}
         aria-label="Previous release week">← Previous week</button>

        <div className="a-grow a-ta-c">
          <span className="a-text a-fw6 a-fs-13">{fmtWeekLabel(week)}</span>
          {isCurrentWeek && <span className="a-ml-8 a-fs-11 a-accent">This week</span>}
        </div>

        <button
          className="adm-btn a-fs-13" style={{ padding: '5px 12px' }}
          onClick={() => shiftWeek(1)}
          disabled={loading}
         aria-label="Next release week">Next week →</button>

        {!isCurrentWeek && (
          <button
            className="adm-btn a-fs-11" style={{ padding: '5px 10px' }}
            onClick={() => setWeek(todayMonday)}
            disabled={loading}
          >This week</button>
        )}
      </div>

      <div className="dm-weekly-controls">
        <label>Find releases<input className="adm-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Series or issue number…" /></label>
        <label>Publisher<select aria-label="Publisher" className="adm-input" value={publisher} onChange={e => setPublisher(e.target.value)}><option value="all">All publishers</option>{publisherOptions.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>Show<select aria-label="Show" className="adm-input" value={monitorFilter} onChange={e => setMonitorFilter(e.target.value)}><option value="all">All releases</option><option value="unmonitored">Not monitored</option><option value="monitored">Monitored</option><option value="wanted">Wanted issues</option><option value="first">#1 issues</option></select></label>
        <label>Jump to week<input className="adm-input" type="date" value={week} onChange={e => { if (e.target.value) setWeek(getMondayOf(new Date(e.target.value + 'T12:00:00'))); }} /></label>
        {(query || publisher !== 'all' || monitorFilter !== 'all') && <button className="adm-btn" onClick={() => { setQuery(''); setPublisher('all'); setMonitorFilter('all'); }}>Clear filters</button>}
      </div>
      {/* Loading / error */}
      {loading && <div className="adm-empty">Loading releases…</div>}
      {error && <div className="a-err a-fs-13 a-ta-c" style={{ padding: '20px 0' }}>Error: {error} <button className="adm-btn" onClick={() => load(week)}>Retry</button></div>}

      {/* Results summary + pagination */}
      {data && !loading && (
        <>
          <div className="dm-weekly-summary" role="status"><strong>{filteredReleases.length} releases shown</strong><span>{monitoredCount} monitored · {releases.length - monitoredCount} not monitored this week</span></div>
          {releases.length > 0 && filteredReleases.length === 0 && <div className="adm-empty">No releases match these filters.</div>}
          <div className="dm-weekly-source a-flex a-ai-c a-gap-12 a-mb-12 a-wrap">
            <span className="a-faint a-fs-12">
              {data.total_singles} single issues
              {data.total_tpbs_filtered > 0 && (
                <span className="a-dim"> ({data.total_tpbs_filtered} TPBs/GNs excluded)</span>
              )}
              {data.source && (
                <span className="a-ml-8 a-fs-10" style={{ padding: '1px 6px', borderRadius: 8, background: data.source === 'previewsworld' ? 'var(--om-base)' : 'var(--om-base)', color: data.source === 'previewsworld' ? '#4caa70' : 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))', border: `1px solid ${data.source === 'previewsworld' ? '#4caa7033' : 'color-mix(in srgb, var(--om-base) 90%, white)'}` }}>
                  {data.source === 'previewsworld' ? '📋 PreviewsWorld' : '🔍 ComicVine'}
                </span>
              )}
              {data.source === 'comicvine' && data.total_from_store_date != null && (
                <span className="a-ml-6 a-fs-11" style={{ color: 'var(--adm-g4)' }}
                  title={`${data.total_from_store_date} from store date, ${data.total_from_cover_date} from cover date`}>
                  [{data.total_from_store_date}+{data.total_from_cover_date}]
                </span>
              )}
            </span>
            {data._debug?.release_source === 'locg' && (
              <span title="Release data sourced from League of Comic Geeks"
                className="a-fs-11 a-ok" style={{ padding: '2px 8px', borderRadius: 8, background: 'var(--adm-g0)', border: '1px solid #003a18', cursor: 'default' }}>
                ✓ LOCG
              </span>
            )}
            {data._debug?.release_source === 'freshcomics' && (
              <span title="Release data sourced from FreshComics.us. Add LOCG credentials in Settings for richer data."
                className="a-fs-11 a-accent" style={{ padding: '2px 8px', borderRadius: 8, background: 'color-mix(in srgb, var(--td-yellow) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--td-yellow) 30%, transparent)', cursor: 'default' }}>
                ⚠ FreshComics
              </span>
            )}
            {totalPages > 1 && (
              <div className="a-ml-auto a-flex a-ai-c a-gap-6">
                <button className="adm-btn a-fs-12" style={{ padding: '3px 10px' }} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={displayPage === 0}>‹</button>
                <span className="a-muted a-fs-12">Page {displayPage + 1} / {totalPages}</span>
                <button className="adm-btn a-fs-12" style={{ padding: '3px 10px' }} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={displayPage === totalPages - 1}>›</button>
              </div>
            )}
          </div>

          {data.total_singles === 0 && (
            <div className="adm-empty">
              <div className="a-fs-22 a-mb-8" style={{ opacity: 0.2 }}>◈</div>
              <div className="a-faint">No single issues found for this week.</div>
              {data._debug && (
                <div className="a-mt-10 a-fs-11 a-dim a-flex a-col a-gap-2 a-ta-l" style={{ maxWidth: 480, margin: '10px auto 0' }}>
                  {data._debug.raw_count === 0 ? (
                    <span style={{ color: '#884444' }}>
                      All sources returned 0 items — LOCG, FreshComics, and Walksoftly may be unreachable, or this week's list isn't published yet.
                    </span>
                  ) : (
                    <span className="a-faint">
                      {data._debug.raw_count} items were fetched but all {data._debug.tpbs_filtered} were filtered as TPBs/GNs.
                    </span>
                  )}
                  {data._debug.release_source && data._debug.release_source !== 'none' && (
                    <span className="a-dim a-breakall">
                      Source used: <strong className="a-faint">{data._debug.release_source}</strong>
                    </span>
                  )}
                  <span className="a-dim">Check Docker logs for details.</span>
                </div>
              )}
            </div>
          )}

          {/* Publisher sections (regular + digital-only sentinels) */}
          {pagePublishers.map(groupKey => {
            const digital = DIGITAL_SECTIONS[groupKey] || null;
            return (
              <div key={groupKey} className="dm-weekly-publisher">
                {digital ? (
                  // Digital-line header — distinct color + badge
                  <div className="a-mb-8 a-flex a-ai-c a-gap-8" style={{ padding: '5px 8px', borderBottom: `1px solid ${digital.borderColor}`, background: `${digital.borderColor}55`, borderRadius: '4px 4px 0 0' }}>
                    <span className="a-fs-11 a-fw7 a-upper" style={{ color: digital.color, letterSpacing: '0.08em' }}>
                      {digital.label}
                    </span>
                    <span className="a-fs-10 a-fw6" style={{ padding: '1px 6px', borderRadius: 8, background: `${digital.borderColor}`, color: digital.badgeColor, border: `1px solid ${digital.color}44`, letterSpacing: '0.04em' }}>
                      {digital.badge}
                    </span>
                    <span className="a-ml-auto a-dim a-fs-11">({pageGrouped[groupKey].length})</span>
                  </div>
                ) : (
                  // Regular publisher header
                  <div className="dm-weekly-publisher-title a-muted a-fs-11 a-fw7 a-upper a-mb-8" style={{ letterSpacing: '0.08em', padding: '4px 0', borderBottom: '1px solid var(--adm-g3)' }}>
                    {groupKey}
                    <span className="a-ml-8 a-dim a-fw4">({pageGrouped[groupKey].length})</span>
                  </div>
                )}
                <div className="a-flex a-col a-gap-2">
                  {pageGrouped[groupKey].map(issue => (
                    <WeeklyIssueCard
                      key={`${groupKey}-${issue.volume?.id || issue.volume?.name}-${issue.issue_number}-${issue.locg_url || issue.id || ''}`}
                      issue={issue}
                      onAddSeries={vol => setAddTarget(vol)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Bottom pagination */}
          {totalPages > 1 && (
            <div className="a-flex a-jc-c a-gap-6 a-mt-8">
              <button className="adm-btn a-fs-12" style={{ padding: '4px 14px' }} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={displayPage === 0}>‹ Prev</button>
              <span className="a-muted a-fs-12" style={{ alignSelf: 'center' }}>Page {displayPage + 1} / {totalPages}</span>
              <button className="adm-btn a-fs-12" style={{ padding: '4px 14px' }} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={displayPage === totalPages - 1}>Next ›</button>
            </div>
          )}
        </>
      )}

      {/* Add Series modal pre-filled from weekly release */}
      {addTarget && (
        <AddSeriesFromWeekly
          volume={addTarget}
          onClose={() => setAddTarget(null)}
          onAdded={() => { setAddTarget(null); onSeriesAdded(); load(week); }}
        />
      )}
    </div>
  );
}

/** Weekly monitor modal — auto-searches CV by series name on open,
 *  pre-selects the best match (by comicid or name+publisher), but shows
 *  all results so the user can correct a wrong match before confirming. */
function AddSeriesFromWeekly({ volume, onClose, onAdded }) {
  const [parentScannedSeries, setParentScannedSeries] = useState(null); // special of an existing series
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const [selected, setSelected]     = useState(null);
  const [parentDir, setParentDir]   = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [adding, setAdding]         = useState(false);
  const [error, setError]           = useState('');

  const { suggestion, loadingSuggestion } = useSuggestDirectory(selected, setParentDir);

  // Auto-search CV on mount using the series name from the weekly entry.
  // Pass publisher so the backend can sort publisher-matching volumes first.
  useEffect(() => {
    const doSearch = async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: volume.name });
        if (volume.publisher) params.set('publisher', volume.publisher);
        const r = await fetch(`/api/comicvine/search?${params}`);
        const d = await r.json();
        if (!r.ok) { setError(d.error || 'CV search failed'); setSearching(false); return; }
        const res = d.results || [];
        setResults(res);

        const locgId   = volume.id ? String(volume.id) : null;
        const normName = volume.name.toLowerCase().trim();
        const normPub  = (volume.publisher || '').toLowerCase().trim();
        const currentYear = new Date().getFullYear();

        // Known English-language publishers — prefer these over foreign republishers
        const ENGLISH_PUBLISHERS = new Set([
          'dc comics', 'marvel', 'image comics', 'dark horse comics', 'idw publishing',
          'boom! studios', 'dynamite entertainment', 'valiant entertainment', 'archie comics',
          'oni press', 'fantagraphics', 'drawn and quarterly', 'aftershock comics',
          'vault comics', 'scout comics', 'titan comics', 'avatar press',
        ]);
        const isForeignPub = (r) => {
          const p = (r.publisher?.name || '').toLowerCase().trim();
          if (!p) return false;
          if (ENGLISH_PUBLISHERS.has(p)) return false;
          return /panini|urban comics|planeta|glenat|ehapa|tokyopop|kazé|kana|delcourt|dargaud|lombard|dupuis|standaard|carlsen|bonnier|norma|ivrea|ovni|yoyo|soleil|semic|comics-x|toth|geppi|hachette|bajirao/i.test(p);
        };

        const englishResults = res.filter(r => !isForeignPub(r));
        const pool = englishResults.length > 0 ? englishResults : res;

        // Pre-select best match. Priority:
        // 1. Exact CV ID match (LOCG/Walksoftly data — always correct)
        // 2. Exact name + publisher match, most recent start year
        //    (avoids picking the 1963 run when the 2022 run is what's shipping)
        // 3. Exact name match, most recent start year (publisher didn't match cleanly)
        // 4. First result from the (backend-sorted) pool
        const nameMatches = pool.filter(r => r.name?.toLowerCase().trim() === normName);
        const byRecency = arr =>
          [...arr].sort((a, b) => Math.min(parseInt(b.start_year)||0, currentYear)
                                - Math.min(parseInt(a.start_year)||0, currentYear));

        const pubMatches    = nameMatches.filter(r => r.publisher?.name?.toLowerCase().trim() === normPub);
        const recentPubMatch = byRecency(pubMatches)[0] || null;
        const recentNameMatch = byRecency(nameMatches)[0] || null;

        let best = (locgId && pool.find(r => String(r.id) === locgId))
          || recentPubMatch
          || recentNameMatch
          || pool[0]
          || null;

        setSelected(best);
      } catch (e) {
        setError('CV search failed');
      }
      setSearching(false);
    };
    doSearch();
  }, []);

  const add = async () => {
    if (!selected || (!parentDir && !parentScannedSeries)) return;
    setAdding(true);
    setError('');
    try {
      const r = await fetch('/api/monitor/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:           String(selected.id),
          name:         selected.name,
          publisher:    selected.publisher?.name,
          year:         selected.start_year,
          total_issues: selected.count_of_issues || 0,
          image_url:    selected.image?.medium_url || null,
          cv_url:       selected.site_detail_url || null,
          parentDir: parentDir || '/comics', // unused when parentScannedSeriesId is set
          parentScannedSeriesId: parentScannedSeries?.id || null,
          // Store the original FreshComics series name so future weekly loads
          // match this series by exact source name instead of fuzzy CV-name matching.
          // This is how we recreate Walksoftly's unambiguous CV-ID-based matching.
          source_name:  volume.name || null,
        }),
      });
      const d = await r.json();
      if (d.success) onAdded(d);
      else setError(d.error || 'Failed to add');
    } catch (e) { setError(e.message); }
    setAdding(false);
  };

  return (
    <Modal title="Monitor Series" onClose={onClose} width={580}>
      <div className="adm-modal-content">
        {/* Searching indicator */}
        {searching && (
          <div className="a-faint a-ta-c a-fs-13" style={{ padding: '20px' }}>
            Searching Comic Vine for "{volume.name}"…
          </div>
        )}

        {/* Results list — scrollable */}
        {!searching && results.length > 0 && (
          <div className="a-grow" style={{ overflowY: 'auto', padding: '4px 0', borderBottom: '1px solid var(--adm-g3)' }}>
            {results.map(r => (
              <div
                key={r.id}
                className="dm-result-row a-ptr" style={{ background: selected?.id === r.id ? 'var(--om-base)' : 'transparent', borderLeft: selected?.id === r.id ? '2px solid var(--td-yellow)' : '2px solid transparent' }}
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
          </div>
        )}

        {!searching && results.length === 0 && (
          <div className="a-faint a-ta-c a-fs-13" style={{ padding: 20 }}>No results found</div>
        )}

        {/* Directory + confirm — only once something is selected */}
        {!searching && selected && (
          <>
            <SpecialOfRow value={parentScannedSeries} onChange={setParentScannedSeries} />
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

        {pickerOpen && (
          <DirectoryPicker
            onSelect={dir => { setParentDir(dir); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </Modal>
  );
}
