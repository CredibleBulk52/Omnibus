import React, { useEffect, useState } from 'react';
import { PATH_LABELS } from './eventReadingPath';
import { useReadingTheme } from './ReadingTheme';
import '../comicReaderEndCard.css';

export const endIssueLabel = issue => issue
  ? (issue.series_name ? `${issue.series_name}${issue.issue_number != null && issue.issue_number !== '' ? ` #${issue.issue_number}` : ''}` : issue.title || '')
  : '';

// Use a stable event cover, rather than changing the event's palette at every stop.
function useEventCover(context) {
  const [cover, setCover] = useState(null);
  const id = context?.kind === 'event' ? context.id : null;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    fetch(`/api/events/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!controller.signal.aborted) setCover({ id, book: data?.issues?.find(i => i.scanned_book_id)?.scanned_book_id }); })
      .catch(() => {});
    return () => controller.abort();
  }, [id]);
  return cover?.id === id ? cover?.book : null;
}

export default function ComicReaderEndCard({ completed, headline, issueTitle, bookId, seriesName, solicit,
  context, next, nextRecommended, nextEssential, showRec, showEss, loading, alternatives, endMessage,
  onRead, onLastPage, onBackContext, onBackSeries, assistant, onDiscuss }) {
  const kind = context?.kind || 'series';
  const word = { series: 'series', event: 'event', list: 'list', run: 'run' }[kind] || 'series';
  const eventCover = useEventCover(context);
  const theme = useReadingTheme({ id: context?.id, name: context?.name || seriesName }, kind === 'event' ? eventCover : kind === 'series' ? bookId : null);
  const [failedCover, setFailedCover] = useState(null);
  const position = context?.position;
  const total = context?.total;
  const hasPosition = position > 0 && total > 0;
  // "About the next issue": its solicit, and in event reading the event's note on it (user, 2026-10-22).
  const nextNote = kind === 'event' ? next?.note : null;
  const nextSolicit = next?.solicit || null;
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => { setAboutOpen(false); }, [bookId]);
  const hasAbout = !!(nextSolicit || nextNote);
  // Event reading: Back to series sits by the event's name and Back to event in the footer (user, 2026-10-22).
  const eventSwap = kind === 'event';
  const routes = alternatives || [showRec && { label: 'Next recommended', issue: nextRecommended }, showEss && { label: 'Next essential', issue: nextEssential }].filter(Boolean);
  return (
    <section className="comic-reader-finale finish-card" style={theme.style} aria-label="Finished issue">
      <header><span className="finished">FINISHED!{completed ? ' ✓' : ''}</span><span className="context-label">{word.toUpperCase()} READING</span></header>
      <h2>{headline}</h2>
      {issueTitle && <p className="story">{issueTitle}</p>}
      {kind === 'series' && hasPosition && <div className="position-line">Library position <strong>{position} of {total}</strong></div>}
      {context && kind !== 'series' && <div className="event-context">
        <div>{eventSwap && context.path && <span>Reading path: {PATH_LABELS[context.path] || PATH_LABELS.all}</span>}<strong>{context.name}</strong>{hasPosition && <span>Stop <b>{position}</b> of {total}</span>}
          {eventSwap
            ? (onBackSeries && <button className="quiet" onClick={onBackSeries}>Back to series ↗</button>)
            : <button className="quiet" onClick={onBackContext}>Back to {word} ↗</button>}</div>
        {hasPosition && <div className="route-track" role="progressbar" aria-label={`Position in ${word}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={position}><span style={{ width: `${Math.min(100, position / total * 100)}%` }} /></div>}
      </div>}
      {loading ? <p role="status">Loading the next issue…</p> : next ? (<>
        <button className="next-panel" onClick={() => onRead(next)} aria-label={`Read next: ${endIssueLabel(next)}`}>
          <span className="caption">{kind === 'series' ? 'CONTINUED NEXT ISSUE…' : `NEXT IN THE ${word.toUpperCase()}…`}</span>
          {next.id && failedCover !== next.id
            ? <img className="next-cover" src={`/api/books/${encodeURIComponent(next.id)}/thumbnail`} alt="" onError={() => setFailedCover(next.id)} />
            : <span className="issue-stamp"><small>ISSUE</small><b>{next.issue_number ?? '→'}</b></span>}
          <span className="next-copy"><span className="next-heading"><strong>{endIssueLabel(next)}</strong>{kind === 'event' && next.tier && <em>{next.tier}</em>}</span>
            {next.issue_title && <span>{next.issue_title}</span>}
            <span className="read-action">{kind === 'series' && next.issue_number != null ? `READ #${next.issue_number}` : 'READ NEXT'} <span>→</span></span>
          </span>
        </button>
        {hasAbout && <button type="button" className="about-toggle about-next" aria-expanded={aboutOpen} onClick={() => setAboutOpen(v => !v)}>
          {aboutOpen ? '▴' : '▾'} About the next issue</button>}
        {aboutOpen && hasAbout && <div className="about-issue">
          {nextNote && <p className="about-note"><span>Why read it</span>{nextNote}</p>}
          {nextSolicit && <p className="about-solicit"><span>Solicit</span>{nextSolicit}</p>}
        </div>}
      </>) : <p className="end-none">{endMessage || (kind === 'series' ? 'That was the last issue of this series in your library.' : `That was the last issue you own in this ${word}.`)}</p>}
      {!loading && routes.length > 0 && <div className="alternatives"><span className="skip-label">ONE-TIME DETOURS · PATH UNCHANGED</span>
        {routes.map(({ label, issue }) => <button key={issue.id} className="route" onClick={() => onRead(issue)}><span>{label}</span><strong>{endIssueLabel(issue)}</strong><b>↗</b></button>)}
      </div>}
      <footer><button className="quiet" onClick={onLastPage}>‹ Last page</button>
        {eventSwap
          ? <button className="secondary" onClick={onBackContext}>Back to event ↗</button>
          : onBackSeries && <button className="secondary" onClick={onBackSeries}>Back to series ↗</button>}
        {assistant?.enabled && <button className="discuss" onClick={onDiscuss}><span className="speech" aria-hidden="true">?!</span><span>Discuss this issue<small>with {assistant.name || 'Comic Book Guy'}</small></span></button>}
      </footer>
    </section>
  );
}
