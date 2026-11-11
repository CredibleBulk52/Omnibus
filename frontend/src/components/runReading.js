export function runReadingState(issues) {
  const owned = issues.filter(i => i.scanned_book_id);
  const read = owned.filter(i => i.readProgress?.completed).length;
  const unfinished = owned.filter(i => !i.readProgress?.completed);
  const started = unfinished.filter(i => i.readProgress?.page > 0);
  const current = started[started.length - 1] || unfinished[0] || null;
  return { current, first: owned[0] || null, owned: owned.length, total: issues.length, read,
    missing: issues.length - owned.length,
    completed: issues.length > 0 && read === issues.length,
    ownedCompleted: owned.length > 0 && read === owned.length,
    resuming: !!(current?.readProgress?.page > 0) };
}
export const runReadUrl = (runId, issue, restart = false) =>
  `/read/${encodeURIComponent(issue.scanned_book_id)}?canonRunId=${encodeURIComponent(runId)}${restart ? '&restart=1' : ''}`;
