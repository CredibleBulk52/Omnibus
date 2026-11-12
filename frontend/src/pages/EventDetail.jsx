import { PublisherLogo } from '../components/Branding';
// ─── EventDetail ──────────────────────────────────────────────────
// A Timeline event: hero (fanned covers, size, description, progress) and
// its reading order, in the reading-list style. Phases are red PART banners;
// each phase is one continuous shelf in reading order (event orders hop
// between series every issue, so no grouping by series), with a tier ribbon
// on every cover. Rows view keeps each issue's note. Essential / + Recommended
// / All bar as before. Styles: ../readingLists.css (rl- and ev- classes).
import { Loading, Empty } from '../components/StateMessage';
import React, { useState, useEffect, useCallback } from 'react';
import BackLink from '../components/BackLink';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { InfoTip, isAdmin, useAppSettings } from '../App';
import MissingCover, { MissingAction, REQUEST_LABEL } from '../components/MissingCover';
import AcquireBox, { AcquireDialog } from '../components/AcquireBox';
import ReadingOrderHero from '../components/ReadingOrderHero';
import { TierBadge } from './EventsPage';
import AddToListModal from '../components/AddToListModal';
import { ProgressBars } from '../components/ReadingListBits';
import '../readingLists.css';
import ReadingOrderActions from '../components/ReadingOrderActions';
import IssueCardMenu from '../components/IssueCardMenu';
import RunReadingPanel from '../components/RunReadingPanel';
import { runReadingState } from '../components/runReading';
import { useReadingTheme } from '../components/ReadingTheme';
import { TIER_COLOUR, TIER_LABEL } from '../components/tiers';

import { PATH_LABELS, validPath, includesTier, effectivePath, preferenceKey, readPreference, writePreference, eventReadUrl } from '../components/eventReadingPath';
import { reportProblem } from '../components/ReportProblem';

const TIER_STEPS = [['essential', 'Essential'], ['recommended', 'Essential + Recommended'], ['all', 'All']];
const COLLAPSE_AT = 18;
const ISSUE_W = 164, ISSUE_H = 246;
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const pathKey = preferenceKey('event.' + id);
  const [savedPath, setSavedPath] = useState(() => ({ key: pathKey, value: validPath(readPreference(pathKey, 'all')) }));
  const tierView = searchParams.has('minTier') ? validPath(searchParams.get('minTier'))
    : savedPath.key === pathKey ? savedPath.value : validPath(readPreference(pathKey, 'all'));
  const setTierView = value => {
    setSavedPath({ key: pathKey, value });
    writePreference(pathKey, value);
    const q = new URLSearchParams(searchParams); q.set('minTier', value);
    setSearchParams(q, { replace: true });
  };
  const [view, setViewState] = useState(() => (pref.get('omnibus.event.view', 'shelf') === 'rows' ? 'rows' : 'shelf'));
  const setView = v => { setViewState(v); pref.set('omnibus.event.view', v); };
  const [addOpen, setAddOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/events/${id}`);
      setEvent(await r.json());
    } catch {}
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  // Missing issues: get them, or ask the admin (the shared request service).
  const appSettings = useAppSettings();
  const canDownload = isAdmin() || appSettings.download_manager_admin_only !== 'true';
  const [requests, setRequests] = useState({});
  const [acquireIssue, setAcquireIssue] = useState(null);
  const loadRequests = useCallback(() => {
    if (canDownload) return;
    fetch(`/api/requests/event/${id}/mine`).then(r => r.json()).then(d => setRequests(d && !d.error ? d : {})).catch(() => {});
  }, [id, canDownload]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  const acq = { eventId: id, requests, label: canDownload ? '⬇ Get' : '✉ Request', open: i => setAcquireIssue(i), refresh: loadRequests };

  const selectedPath = effectivePath(event?.issues || [], tierView);
  const reading = runReadingState((event?.issues || []).filter(i => includesTier(i, selectedPath)));
  const readingTheme = useReadingTheme({ name: event?.name }, reading.first?.scanned_book_id);

  if (loading) return <Loading label="Loading event…" />;
  if (!event || event.error) return <Empty title="Event not found" action={<BackLink to="/events" label="Timeline" />} />;

  const issues = (event.issues || []).map((i, k) => ({ ...i, _n: k + 1 }));
  // Counts per step are cumulative. A step with nothing in it widens to the next one.
  const stepCounts = {
    essential:   issues.filter(i => i.tier === 'essential').length,
    recommended: issues.filter(i => i.tier === 'essential' || i.tier === 'recommended').length,
    all:         issues.length,
  };
  const stepIdx = Math.max(0, TIER_STEPS.findIndex(([k]) => k === tierView));
  const effective = (TIER_STEPS.slice(stepIdx).find(([k]) => stepCounts[k] > 0) || ['all'])[0];
  const displayed = effective === 'all' ? issues
    : issues.filter(i => i.tier === 'essential' || (effective === 'recommended' && i.tier === 'recommended'));
  const showTierBar = stepCounts.essential < issues.length;

  const progress = {
    total: issues.length,
    owned: issues.filter(i => i.scanned_book_id).length,
    read:  issues.filter(i => i.readProgress?.completed).length,
  };
  const tierCounts = Object.fromEntries(Object.keys(TIER_LABEL).map(t => [t, issues.filter(i => i.tier === t).length]));
  // Hero covers: owned essential issues first, in reading order.
  const covers = [...issues.filter(i => i.scanned_book_id && i.tier === 'essential'), ...issues.filter(i => i.scanned_book_id && i.tier !== 'essential')]
    .map(i => i.scanned_book_id).filter((b, k, a) => a.indexOf(b) === k).slice(0, 4);
  const readUrl = bookId => eventReadUrl(bookId, id, effective);
  const current = reading.current;

  // Phases: consecutive issues with the same phase (displayed set).
  const phases = [];
  for (const i of displayed) {
    const name = i.phase || '';
    const last = phases[phases.length - 1];
    if (last && last.name === name) last.issues.push(i);
    else phases.push({ name, issues: [i] });
  }
  const hasPhases = phases.some(p => p.name);
  const longDesc = (event.description || '').length > 420;
  const toggle = k => setExpanded(s0 => { const s1 = new Set(s0); s1.has(k) ? s1.delete(k) : s1.add(k); return s1; });

  return (
    <div className="rl-page">
      <ReadingOrderHero title={event.name} themeStyle={readingTheme.style}
        covers={covers} emptyText={issues.length ? 'Nothing owned yet' : 'No issues yet'}
        back={<BackLink to="/events" label="Timeline" />}
        chips={<>
          <TierBadge tier={event.event_tier} />
          {event.source === 'manual' && <span className="rl-chip rl-chip--copy">✎ Manual</span>}
          {event.draft ? <span className="rl-chip rl-chip--copy" title="Imported and not yet published: only admins see it">Draft</span> : null}
          <span className="rl-stat-line">{event.publisher && <PublisherLogo name={event.publisher} />}{event.publisher && event.year ? ' · ' : ''}{event.year}</span>
        </>}
        actions={<>
          <RunReadingPanel kind="event" pathLabel={PATH_LABELS[effective]} state={reading} onRead={(issue, restart) => navigate(readUrl(issue.scanned_book_id) + (restart ? '&restart=1' : ''))} />
          <div className="order-secondary-actions">
            <ReadingOrderActions exportItem={isAdmin() ? { kind: 'event', id } : null} deletion={isAdmin() ? {endpoint:`/api/events/${id}`,label:"event",name:event.name,onDeleted:()=>navigate("/events")} : null} name={event.name} bookId={issues.find(i => i.scanned_book_id)?.scanned_book_id} onAdd={() => setAddOpen(true)} onEdit={isAdmin() ? () => navigate(`/events/${id}/edit`) : null} onReport={isAdmin() ? null : () => reportProblem({ type: 'event', id: event.id, label: event.name, kinds: ['order', 'metadata', 'other'] })} />
          </div>
        </>}>
        {event.description && (
          <>
            <p className={`rl-hero-desc ev-desc${longDesc && !descOpen ? ' ev-desc--clamp' : ''}`}>{event.description}</p>
            {longDesc && <button className="ev-more" onClick={() => setDescOpen(x => !x)}>{descOpen ? 'Show less ▲' : 'Show more ▼'}</button>}
          </>
        )}
        <div className="ev-legend">
          {Object.keys(TIER_LABEL).filter(t => tierCounts[t] > 0 || t === 'essential' || t === 'recommended').map(t => (
            <span key={t} className="ev-legend-item"><span className="ev-legend-dot" style={{ background: TIER_COLOUR[t] }} />{TIER_LABEL[t]} ({tierCounts[t]})</span>
          ))}
          <InfoTip text="Essential: the main story. Recommended: adds depth but not required. Tie-in: set during the event, tangential. Aftermath: what follows after it ends." position="right" width={300} />
        </div>
        {progress.total > 0 && <><span className="rl-stat-line">Overall event</span><ProgressBars progress={progress} /></>}
      </ReadingOrderHero>

      {/* ── Reading order ── */}
      <div className="rl-section">
        <div className="rl-section-head">
          <span className="rl-section-title">Reading Order</span>
          {progress.total > 0 && <span className="rl-stat-line">{progress.owned}/{progress.total} in your library</span>}
          <div className="rl-toggle" role="group" aria-label="View">
            <button className={view === 'shelf' ? 'on' : ''} onClick={() => setView('shelf')}>▤ Shelf</button>
            <button className={view === 'rows' ? 'on' : ''} onClick={() => setView('rows')}>☰ Rows</button>
          </div>
        </div>

        {showTierBar && (
          <div className="ev-showbar" role="group" aria-label="Reading path">
            <span className="ev-showbar-label">Reading path</span>
            <div className="rl-seg">
              {TIER_STEPS.map(([k, label]) => (
                <button key={k} type="button" className={effective === k ? 'on' : ''} aria-pressed={effective === k}
                  disabled={!stepCounts[k]} onClick={() => setTierView(k)}>
                  {label} <span className="rl-seg-n">{stepCounts[k]}</span>
                </button>
              ))}
            </div>
            {effective !== tierView && <span className="rl-stat-line">Nothing is marked {tierView} here, so more is shown.</span>}
          </div>
        )}

        {!issues.length && <Empty title="No reading order yet" />}

        {phases.map((p, pi) => {
          const key = `${pi}|${p.name}`;
          const prog = { total: p.issues.length, read: p.issues.filter(i => i.readProgress?.completed).length };
          const hasCurrent = current && p.issues.some(i => i.id === current.id);
          const curIdx = hasCurrent ? p.issues.findIndex(i => i.id === current.id) : -1;
          const isOpen = expanded.has(key) || curIdx >= COLLAPSE_AT || p.issues.length <= COLLAPSE_AT + 3;
          const shown = isOpen ? p.issues : p.issues.slice(0, COLLAPSE_AT);
          return (
            <div key={key} className="ev-phase">
              {hasPhases && (
                <div className="rl-sec">
                  <div className="rl-sec-banner">
                    <span className="rl-sec-part">Part {pi + 1}</span>
                    <span className="rl-sec-title">{p.name || 'Also'}</span>
                    {prog.total > 0 && <span className="rl-sec-prog">{prog.read}/{prog.total} read</span>}
                  </div>
                </div>
              )}
              {view === 'shelf'
                ? <EventShelf issues={shown} current={current} acq={acq} onIssueChanged={load} onRead={i => navigate(readUrl(i.scanned_book_id))}
                    more={isOpen ? 0 : p.issues.length - shown.length} onMore={() => toggle(key)} />
                : (
                  <div className="rl-rows">
                    {shown.map(i => <EventRow key={i.id} issue={i} acq={acq} isCurrent={current && i.id === current.id} onRead={() => navigate(readUrl(i.scanned_book_id))} />)}
                  </div>
                )}
              {view === 'rows' && p.issues.length > COLLAPSE_AT + 3 && curIdx < COLLAPSE_AT && (
                <button className="rl-more" onClick={() => toggle(key)}>{isOpen ? '▲ Show fewer' : `▼ Show all ${p.issues.length} issues`}</button>
              )}
            </div>
          );
        })}
      </div>

      {acquireIssue && (
        <AcquireDialog base={`/api/requests/event/${id}/issues/${acquireIssue.id}`} issue={acquireIssue}
          onClose={() => { setAcquireIssue(null); loadRequests(); load(); }} />
      )}
      {addOpen && <AddToListModal target={{ kind: 'event', refId: id, label: event.name }} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

// ─── Shelf: one continuous shelf per phase, tier ribbon on each cover ──
function EventShelf({ issues, current, onRead, more, onMore, acq, onIssueChanged }) {
  const [card, setCard] = useState(null);   // the issue whose note card is open (tap the caption; works on touch)
  const [solicitOpen, setSolicitOpen] = useState(false);
  useEffect(() => { setSolicitOpen(false); }, [card]);
  useEffect(() => {
    if (!card) return;
    const key = e => { if (e.key === 'Escape') setCard(null); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [card]);
  if (!issues.length) return null;
  return (<>
    <div className="issues-bookshelf rl-shelf ev-shelf">
      <div className="shelf-wall" style={{ padding: '16px 0 0' }}>
        <div className="issues-books">
          {issues.map(i => {
            const owned = !!i.scanned_book_id;
            const rp = i.readProgress || null;
            const done = !!rp?.completed, inProg = owned && !done && rp?.page > 0;
            const isCurrent = current && i.id === current.id;
            return (
              <div key={i.id} className={`issue-book ev-book ev-book--${i.tier || 'none'}${isCurrent ? ' issue-book--current' : ''}`} style={{ width: ISSUE_W }}
                title={[`${i._n}. ${i.series_name} #${i.issue_number}`, i.tier_note].filter(Boolean).join('\n')}>
                {(i.tier || isCurrent) && (
                  <div className="issue-tagrow">
                    {i.tier ? <span className="ev-ribbon" style={{ background: TIER_COLOUR[i.tier] || 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }}>{TIER_LABEL[i.tier] || i.tier}</span> : <span />}
                    {isCurrent && <span className="issue-here">▶ Reading</span>}
                  </div>
                )}
                <div className={`issue-cover${owned ? ' issue-cover-hoverable' : ''}`} style={{ width: ISSUE_W, height: ISSUE_H }}>
                  {owned
                    ? <img src={`/api/books/${i.scanned_book_id}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                    : <MissingCover number={i.issue_number} sub={i.series_name}
                        label={REQUEST_LABEL[acq?.requests[i.id]] || 'Not in library'} tone={acq?.requests[i.id] === 'open' ? 'requested' : 'missing'}
                        actions={acq && acq.requests[i.id] !== 'open' ? <MissingAction onClick={() => acq.open(i)}>{acq.label}</MissingAction> : null} />}
                  <span className="ev-ord">{i._n}</span>
                  {done && <div className="issue-read-badge">✓</div>}
                  {inProg && <div className="issue-progress-bar" style={{ width: `${(rp.page / (rp.page + 1)) * 100}%` }} />}
                  {owned && !done && !inProg && !isCurrent && <div className="issue-unread-dot" />}
                  {isCurrent && <div className="issue-bookmark" title="Continue reading here" />}
                  {owned && onIssueChanged && <IssueCardMenu bookId={i.scanned_book_id} label={`${i.series_name || ''} #${i.issue_number ?? '?'}`.trim()} read={done} onChanged={onIssueChanged} />}
                  {owned && (
                    <div className="issue-hover-overlay">
                      <button className="issue-action-btn" onClick={() => onRead(i)}>▶ Read</button>
                    </div>
                  )}
                </div>
                <button type="button" className="ev-capbtn" onClick={() => setCard(i)} title={i.tier_note ? 'Show the note' : 'Show details'}>
                  <div className="issue-number ev-cap">{i.series_name} <span>#{i.issue_number}</span>{i.tier_note && <span className="ev-cap-dot" aria-label="has a note"> ●</span>}</div>
                  <div className="issue-title">{i.issue_title || i.tier_note || ''}</div>
                </button>
              </div>
            );
          })}
          {more > 0 && <button className="rl-shelf-more" onClick={onMore}>+{more}<br />more</button>}
        </div>
      </div>
      <div className="shelf-plank" />
    </div>
    {card && (
      <div className="ev-card-overlay" onClick={e => { if (e.target === e.currentTarget) setCard(null); }}>
        <div className="ev-card" role="dialog" aria-label={`${card.series_name} #${card.issue_number}`}>
          <div className="ev-card-head">
            <span className="ev-card-num">{card._n}.</span>
            <span className="ev-card-issue">{card.series_name} <span>#{card.issue_number}</span>{card.volume_year ? <span className="ev-card-year"> ({card.volume_year})</span> : null}</span>
            {card.tier && <span className="ev-ribbon" style={{ background: TIER_COLOUR[card.tier] || 'color-mix(in srgb, var(--om-text) 55%, var(--om-base))' }}>{TIER_LABEL[card.tier] || card.tier}</span>}
          </div>
          {(card.issue_title || card.solicit) && <div className="ev-card-title">{card.issue_title ? `“${card.issue_title}”` : null}
            {card.solicit && <button type="button" className="ev-card-toggle" aria-expanded={solicitOpen} onClick={() => setSolicitOpen(v => !v)}
              title={solicitOpen ? 'Hide the solicit' : 'Show the publisher’s solicit'}>{solicitOpen ? '▴' : '▾'} Solicit</button>}</div>}
          <div className={`ev-card-note${card.tier_note ? '' : ' none'}`}>{card.tier_note || 'No note for this issue yet.'}</div>
          {solicitOpen && card.solicit && <div className="ev-card-solicit"><span>Solicit</span>{card.solicit}</div>}
          <div className="ev-card-foot">
            {card.scanned_book_id
              ? <button className="btn btn-primary" onClick={() => { const c = card; setCard(null); onRead(c); }}>▶ Read</button>
              : acq ? <div className="ev-card-acquire"><AcquireBox base={`/api/requests/event/${acq.eventId}/issues/${card.id}`} issue={card} onChange={acq.refresh} /></div>
              : <span className="ev-card-missing">Not in your library</span>}
            <button className="btn" onClick={() => setCard(null)}>Close</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

// ─── Rows: the reading-list row, with the issue's note ────────────
function EventRow({ issue: i, isCurrent, onRead, acq }) {
  const owned = !!i.scanned_book_id;
  const rp = i.readProgress || null;
  const done = !!rp?.completed, inProg = owned && !done && rp?.page > 0;
  const colour = TIER_COLOUR[i.tier] || '#8a8a98';
  return (
    <div className={`rl-row ${owned ? '' : 'rl-row--missing'} ${isCurrent ? 'rl-row--current' : ''} ${i.tier === 'tie-in' ? 'ev-row--tiein' : ''}`}
      style={{ borderLeft: `3px solid ${owned ? colour : 'transparent'}` }}
      onClick={owned ? onRead : undefined} title={owned ? 'Read' : 'Not in your library'}>
      <div className="rl-row-num">{i._n}</div>
      <div className="rl-thumb">
        {owned
          ? <img src={`/api/books/${i.scanned_book_id}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
          : <div className="rl-thumb-missing">#{i.issue_number ?? '?'}</div>}
        {done && <div className="rl-thumb-tick">✓</div>}
        {inProg && <div className="rl-thumb-bar" style={{ width: `${(rp.page / (rp.page + 1)) * 100}%` }} />}
        {owned && !done && !inProg && !isCurrent && <div className="rl-thumb-unread" />}
        {isCurrent && <div className="rl-thumb-bookmark" title="Continue reading here" />}
      </div>
      <div className="rl-row-body">
        <div className="rl-row-title">
          <span>{i.series_name}</span>
          <span className="rl-row-num-inline">#{i.issue_number}</span>
          {i.volume_year && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({i.volume_year})</span>}
          {i.issue_title && <span className="ev-row-title">“{i.issue_title}”</span>}
        </div>
        {i.tier_note && <div className="rl-row-sub ev-row-note">{i.tier_note}</div>}
      </div>
      {i.tier && <span className="rl-pill" style={{ color: colour, borderColor: colour }}>{TIER_LABEL[i.tier] || i.tier}</span>}
      {!owned && <span className="rl-pill rl-pill--missing">{REQUEST_LABEL[acq?.requests[i.id]] || 'Not in library'}</span>}
      {!owned && acq && acq.requests[i.id] !== 'open' && (
        <button className="rl-match-btn" onClick={ev => { ev.stopPropagation(); acq.open(i); }}>{acq.label}</button>
      )}
      {inProg && <span className="rl-pill rl-pill--reading">Reading</span>}
      {done && <span className="rl-pill rl-pill--done">Read</span>}
    </div>
  );
}
