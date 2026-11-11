// Add a visible range while preserving selections outside it. Plain clicks toggle.
export function selectIssueRange(selected, orderedIds, id, anchor, shiftKey) {
  const next = new Set(selected);
  const end = orderedIds.indexOf(id);
  if (end < 0) return next;
  const start = orderedIds.indexOf(anchor);
  if (shiftKey && start >= 0) {
    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) next.add(orderedIds[i]);
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
