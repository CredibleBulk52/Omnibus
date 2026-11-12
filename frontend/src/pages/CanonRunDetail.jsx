import { PublisherLogo } from '../components/Branding';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import RunShelf, { runCoverIds } from '../components/RunShelf';
import '../runShelf.css';
import { useReadingTheme } from '../components/ReadingTheme';
import ReadingOrderActions from '../components/ReadingOrderActions';
import IssueCardMenu from '../components/IssueCardMenu';
import RunReadingPanel from '../components/RunReadingPanel';
import { runReadingState, runReadUrl } from '../components/runReading';
import ReadingOrderHero from '../components/ReadingOrderHero';
import { ProgressBars } from '../components/ReadingListBits';
import React, { useState, useEffect, useCallback } from 'react';
import BackLink from '../components/BackLink';
import { useParams, useNavigate } from 'react-router-dom';

import AddToListModal from '../components/AddToListModal';
import { isAdmin as isAppAdmin, useAppSettings } from '../App';
import MissingCover, { MissingAction, REQUEST_LABEL } from '../components/MissingCover';
import { AcquireDialog } from '../components/AcquireBox';
import { reportProblem } from '../components/ReportProblem';
const ISSUE_W = 164;
const ISSUE_H = 246;

const CATEGORIES = {
  adapted_to_screen:    'Adapted to Screen',
  award_winning:        'Award Winning',
  critically_acclaimed: 'Critically Acclaimed',
};


// ─── Issue Book ───────────────────────────────────────────────────
function IssueBook({ issue, index, runId, hideLabel = false, tracking = false, current = false, acq = null, onIssueChanged = null }) {
  const navigate   = useNavigate();
  const owned      = !!issue.scanned_book_id;

  return (
    <div className={`issue-book${current ? ' issue-book--current' : ''}`} style={{ width: ISSUE_W }}>
      {tracking && <div className="issue-tagrow"><span />{current && <span className="issue-here">▶ Reading</span>}</div>}
      <div
        className={`issue-cover${owned ? ' issue-cover-hoverable' : ''}`}
        style={{ width: ISSUE_W, height: ISSUE_H }}
      >
        {owned
          ? <img src={`/api/books/${issue.scanned_book_id}/thumbnail`} alt=""
              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
          : <MissingCover number={issue.issue_number ?? index + 1} sub={issue.series_name}
              label={REQUEST_LABEL[acq?.requests[issue.id]] || 'Not in library'} tone={acq?.requests[issue.id] === 'open' ? 'requested' : 'missing'}
              actions={acq && acq.requests[issue.id] !== 'open' ? <MissingAction onClick={() => acq.open(issue)}>{acq.label}</MissingAction> : null} />}
        {owned && <div className="shelf-book-placeholder" style={{ display: 'none' }}>◈</div>}

        {tracking && issue.readProgress?.completed && <div className="issue-read-badge" title="Read">✓</div>}
        {tracking && !issue.readProgress?.completed && issue.readProgress?.page > 0 && issue.media?.pagesCount > 0 && <div className="issue-progress-bar" style={{ width: `${Math.min(100, (issue.readProgress.page + 1) / issue.media.pagesCount * 100)}%` }} />}
        {current && <div className="issue-bookmark" title="Continue reading here" />}
        {tracking && owned && !current && !issue.readProgress && <div className="issue-unread-dot" title="Unread" />}
        {tracking && owned && onIssueChanged && <IssueCardMenu bookId={issue.scanned_book_id} label={`${issue.series_name || ''} #${issue.issue_number ?? index + 1}`.trim()} read={!!issue.readProgress?.completed} onChanged={onIssueChanged} />}
        {owned && <div className="issue-hover-overlay">
          {owned
            ? <button className="issue-action-btn"
                title="Read this issue"
                onClick={() => navigate(`/read/${issue.scanned_book_id}?canonRunId=${runId}`)}>
                Read
              </button>
            : null
          }
        </div>}
      </div>

      {!hideLabel && <><div className="issue-number">{issue.issue_number != null ? `#${issue.issue_number}` : `#${index + 1}`}</div>
      {issue.series_name && <div className="issue-title" style={{ fontSize: '0.62rem' }}>{issue.series_name}</div>}</>}

    </div>
  );
}

// ─── Main Detail Page ─────────────────────────────────────────────
export default function CanonRunDetail() {
  const { id }   = useParams();
  const navigate = useNavigate();

  const [run,       setRun]       = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [listOpen,  setListOpen]  = useState(false);
  const [error,     setError]     = useState('');

  const readingTheme = useReadingTheme({ name: run?.title }, run?.issues?.find(i => i.scanned_book_id)?.scanned_book_id);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/canon/runs/${id}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setRun(d);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Missing issues: get them, or ask the admin (the shared request service).
  const appSettings = useAppSettings();
  const canDownload = isAppAdmin() || appSettings.download_manager_admin_only !== 'true';
  const [requests, setRequests] = useState({});
  const [acquireIssue, setAcquireIssue] = useState(null);
  const loadRequests = useCallback(() => {
    if (canDownload) return;
    fetch(`/api/requests/run/${id}/mine`).then(r => r.json()).then(d => setRequests(d && !d.error ? d : {})).catch(() => {});
  }, [id, canDownload]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  const acq = { requests, label: canDownload ? '⬇ Get' : '✉ Request', open: i => setAcquireIssue(i) };

  if (loading) return <Loading label="Loading run…" />;
  if (error && !run) return <ErrorNote title="Couldn't load this run." onRetry={load}>{error}</ErrorNote>;
  if (!run)  return <Empty title="Run not found" action={<BackLink to="/canon" label="Top Shelf" />} />;

  const issues  = run.issues || [];
  const owned   = issues.filter(i => i.scanned_book_id).length;
  const total   = issues.length;
  const reading = runReadingState(issues);
  const readIssue = (issue, restart = false) => navigate(runReadUrl(id, issue, restart));
  const writers = run.creators?.filter(c => c.role === 'writer').map(c => c.person_name).join(', ');
  const artists = run.creators?.filter(c => ['artist', 'penciler', 'penciller'].includes(c.role)).map(c => c.person_name).join(', ');


  return (
    <div className="run-study" style={s.page}>
      <ReadingOrderHero title={run.title} themeStyle={readingTheme.style}
        covers={runCoverIds(issues)} emptyText={total ? 'Nothing owned yet' : 'No issues yet'}
        back={<BackLink to="/canon" label="Top Shelf" match={/^\/canon(\/(?!run\/)[^/]+)?$/} />}
        chips={<>
          {run.publisher && <span className="ro-publisher"><PublisherLogo name={run.publisher} size="hero" /></span>}
          {writers && <span className="rl-chip ro-creator"><small>by</small>{writers}</span>}
          {artists && <span className="rl-chip ro-creator"><small>art</small>{artists}</span>}
          <span className="rl-stat-line">{[run.parent_series, run.issue_range_hint].filter(Boolean).join(' · ')}</span>
        </>}
        actions={<>
          <RunReadingPanel state={reading} onRead={readIssue} />
          <div className="order-secondary-actions">
            <ReadingOrderActions exportItem={isAppAdmin() ? { kind: 'run', id } : null} deletion={isAppAdmin() ? {endpoint:`/api/canon/runs/${id}`,label:"run",name:run.title,onDeleted:()=>navigate("/canon")} : null} name={run.title} bookId={reading.first?.scanned_book_id} onAdd={() => setListOpen(true)} onEdit={isAppAdmin() ? () => navigate(`/canon/run/${id}/edit`) : null} onReport={isAppAdmin() ? null : () => reportProblem({ type: 'run', id: run.id, label: run.title, kinds: ['order', 'metadata', 'other'] })} />
            {run.event && (
              <button className="btn btn-ghost" onClick={() => navigate(`/events/${run.event.id}`)}
                title="Top Shelf opens this Timeline event when the run is clicked. Change or unlink it in Edit Run.">
                ⚡ Timeline: {run.event.name}
              </button>
            )}
          </div>
        </>}>
        {run.description && <p className="rl-hero-desc">{run.description}</p>}
        {(run.categories?.length > 0 || run.awards?.length > 0) && (
          <div className="ro-tags">
            {run.categories?.map(c => (
              <span key={c.category} className="tag tag-genre">
                {CATEGORIES[c.category] || c.category}
                {(c.category === 'adapted_to_screen' || c.category === 'award_winning') && c.adaptation_notes ? `: ${c.adaptation_notes}` : ''}
              </span>
            ))}
            {run.awards?.map((a, i) => (
              <span key={`award-${i}`} className="tag ro-award">
                {a.award === 'eisner' ? '🏆' : '🥇'} {a.year} {({ eisner: 'Eisner', harvey: 'Harvey', kirby: 'Kirby', hugo: 'Hugo', stoker: 'Bram Stoker' })[a.award] || a.award} — {a.category}
              </span>
            ))}
          </div>
        )}
        {total > 0 && <ProgressBars progress={{ total, owned, read: reading.read }} />}
      </ReadingOrderHero>

      <div style={s.section}>
        <div style={s.sectionHeader}>
          <div style={s.sectionLeft}>
            <span style={s.sectionTitle}>Issues</span>
            {total > 0 && <span style={{ fontSize: 12, color: 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))' }}>{owned}/{total} in your library</span>}
          </div>
        </div>

        {total === 0 ? (
          <Empty title="No issues yet">No issues have been found for this run yet.</Empty>
        ) : (
          <RunShelf issues={issues} renderIssue={(issue, index, hideLabel) => <IssueBook key={issue.id} issue={issue} index={index} runId={id} hideLabel={hideLabel} tracking current={issue.id === reading.current?.id} acq={acq} onIssueChanged={load} />} />
        )}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {acquireIssue && (
        <AcquireDialog base={`/api/requests/run/${id}/issues/${acquireIssue.id}`} issue={acquireIssue}
          onClose={() => { setAcquireIssue(null); loadRequests(); load(); }} />
      )}
      {listOpen  && <AddToListModal target={{ kind: 'canon_run', refId: id, label: run.title }} onClose={() => setListOpen(false)} />}
    </div>
  );
}

const s = {
  page:  { padding: '0 0 60px' },
  section:       { padding: '24px 28px 0' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  sectionLeft:   { display: 'flex', alignItems: 'baseline', gap: 12 },
  sectionTitle:  {
    fontSize: '1.3rem',
    fontFamily: "'Bangers', cursive",
    letterSpacing: '0.1em',
    color: 'var(--td-yellow)',
    textTransform: 'uppercase',
  },
};
