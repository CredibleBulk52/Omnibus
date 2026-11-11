import React, { useEffect, useRef, useState } from 'react';
import { readingShelfLayout } from './readingShelfLayout';
const ISSUE_W = 164;
const ISSUE_H = 246;
import MissingCover, { MissingAction, REQUEST_LABEL } from './MissingCover';
import IssueCardMenu from './IssueCardMenu';
// onAcquire(issue): get or request a missing issue (acquireLabel: '⬇ Get' or '✉ Request').
// onIssueChanged(): an issue was marked read or unread from its ⋮ (2026-11-04); the page reloads.
export default function ReadingListShelf({ issues, showSeries, current, onRead, onMatch, onAcquire, acquireLabel = '⬇ Get', expanded, onMore, requests = {}, onIssueChanged = null }) {
  const shelfRef = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = shelfRef.current;
    if (!node) return undefined;
    const measure = () => {
      const style = window.getComputedStyle(node);
      setWidth(Math.max(0, node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [issues.length]);
  const layout = readingShelfLayout(width, issues.length);
  const shown = expanded ? issues : issues.slice(0, layout.count);
  const more = issues.length - shown.length;
  const moreButton = more > 0 && <button className="rl-shelf-more" aria-expanded={false} onClick={onMore}>+{more}<br />More</button>;
  if (!issues.length) return null;
  return (
    <div className="issues-bookshelf rl-shelf">
      <div className="shelf-wall" style={{ padding: '16px 0 0' }}>
        <div className={`issues-books${expanded ? '' : ' rl-shelf-collapsed'}`} ref={shelfRef}>
          {shown.map((i, k) => {
            const isCurrent = current && i.book_id === current.book_id;
            const inProg = i.owned && !i.completed && i.page > 0;
            return (
              <div key={`${i.id ?? 'l'}-${k}`} className={`issue-book${isCurrent ? ' issue-book--current' : ''}`} style={{ width: ISSUE_W }}>
                {isCurrent && <div className="issue-tagrow"><span /><span className="issue-here">▶ Reading</span></div>}
                <div className={`issue-cover${i.owned ? ' issue-cover-hoverable' : ''}`} style={{ width: ISSUE_W, height: ISSUE_H }}>
                  {i.owned
                    ? <img src={`/api/books/${i.book_id}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />
                    : (
                      <MissingCover number={i.issue_number} sub={showSeries ? i.series_name : null}
                        label={(i.id != null && REQUEST_LABEL[requests[i.id]]) || 'Not in library'}
                        tone={i.id != null && requests[i.id] === 'open' ? 'requested' : 'missing'}
                        actions={<>
                          {onAcquire && i.id != null && requests[i.id] !== 'open' && <MissingAction onClick={() => onAcquire(i)}>{acquireLabel}</MissingAction>}
                          {onMatch && i.id != null && (
                            <button className="rl-match-btn missing-cover-action" onClick={e => { e.stopPropagation(); onMatch(i); }}>⚲ Find</button>
                          )}
                        </>} />
                    )}
                  {i.completed && <div className="issue-read-badge">✓</div>}
                  {inProg && <div className="issue-progress-bar" style={{ width: `${(i.page / (i.page + 1)) * 100}%` }} />}
                  {i.owned && !i.completed && !inProg && !isCurrent && <div className="issue-unread-dot" />}
                  {isCurrent && <div className="issue-bookmark" title="Continue reading here" />}
                  {i.owned && onIssueChanged && <IssueCardMenu bookId={i.book_id} label={`${i.series_name || i.title || ''} #${i.issue_number ?? '?'}`.trim()} read={!!i.completed} onChanged={onIssueChanged} />}
                  {i.owned && (
                    <div className="issue-hover-overlay">
                      <button className="issue-action-btn" onClick={() => onRead(i)}>▶ Read</button>
                    </div>
                  )}
                </div>
                <div className="issue-number">#{i.issue_number ?? '?'}</div>
                <div className="issue-title">{showSeries ? (i.series_name || i.title || '') : (i.title || i.series_name || '')}</div>
              </div>
            );
          })}
          {!layout.moreBelow && moreButton}
        </div>
      </div>
      <div className="shelf-plank" />
      {layout.moreBelow && moreButton}
      {expanded && issues.length > layout.count && <button className="rl-more" aria-expanded={true} onClick={onMore}>▲ Show fewer</button>}
    </div>
  );
}

