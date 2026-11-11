import React from 'react';

export default function RunReadingPanel({ state, onRead, kind = 'run', pathLabel }) {
  const { current, first, read, total, owned, missing, completed, ownedCompleted, resuming } = state;
  const issue = current || first;
  const pages = Number(issue?.media?.pagesCount) || 0;
  const page = Math.max(0, Number(issue?.readProgress?.page) || 0);
  const label = issue ? `${issue.series_name || issue.series_name_resolved || 'Issue'} #${issue.issue_number ?? '—'}` : '';
  return <aside className="run-reading-panel" aria-label={`${kind} reading progress`}>
    <span className="run-reading-caption">{completed && pathLabel ? `${pathLabel} reading complete ✓` : completed ? `${kind === 'run' ? 'Run' : kind === 'event' ? 'Event' : 'List'} complete ✓` : ownedCompleted ? 'Owned issues finished ✓' : resuming ? 'Continue the story' : 'Your next issue'}</span>
    {pathLabel && <span className="rl-stat-line">Reading path: {pathLabel}</span>}
    <div className="run-reading-summary"><strong>{read} / {total} read</strong><span>{owned} in library{missing > 0 ? ` · ${missing} missing` : ''}</span></div>
    {total > 0 && <div className="run-reading-track" role="progressbar" aria-label={`${kind} issues read`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={read}><span style={{ width: `${read / total * 100}%` }} /></div>}
    {issue ? <>
      <div className="run-reading-next">
        <img key={issue.scanned_book_id} src={`/api/books/${issue.scanned_book_id}/thumbnail`} alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />
        <div><strong>{label}</strong><p>{resuming ? `Page ${page + 1}${pages ? ` of ${pages}` : ''}` : ownedCompleted ? 'Read again from the beginning' : 'Ready to read'}</p>
          {resuming && pages > 0 && <div className="run-reading-track issue-track" role="progressbar" aria-label="Current issue reading progress" aria-valuemin={0} aria-valuemax={pages} aria-valuenow={Math.min(pages, page + 1)}><span style={{ width: `${Math.min(100, (page + 1) / pages * 100)}%` }} /></div>}
        </div>
      </div>
      <button className="order-read-button" onClick={() => onRead(issue, ownedCompleted)}>{ownedCompleted ? `↻ Reread ${kind}` : resuming ? '▶ Resume reading' : read ? '▶ Continue reading' : '▶ Start reading'}</button>
      {current && first && (resuming || current.id !== first.id) && <button className="run-read-first" onClick={() => onRead(first, true)}>Read from first owned issue</button>}
    </> : <p>{total ? 'No owned issues to read yet.' : 'No issues added yet.'}</p>}
  </aside>;
}
