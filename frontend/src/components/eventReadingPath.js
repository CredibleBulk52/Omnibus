export const PATH_LABELS = { all: 'All issues', essential: 'Essential', recommended: 'Essential + Recommended' };
export const validPath = value => Object.hasOwn(PATH_LABELS, value) ? value : 'all';
export const includesTier = (issue, path) => path === 'all' || issue.tier === 'essential' || (path === 'recommended' && issue.tier === 'recommended');
export function effectivePath(issues, requested) {
  const steps = ['essential', 'recommended', 'all'];
  return steps.slice(steps.indexOf(validPath(requested))).find(p => issues.some(i => includesTier(i, p))) || 'all';
}
export function preferenceKey(scope) {
  let user = null;
  try { user = JSON.parse(localStorage.getItem('omnibus_user')); } catch {}
  return 'omnibus.reading.' + encodeURIComponent(user?.id || user?.username || 'anonymous') + '.' + scope;
}
export function readPreference(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function writePreference(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
export function eventReadUrl(bookId, eventId, path, restart = false) {
  const q = new URLSearchParams({ eventId, minTier: validPath(path) });
  if (restart) q.set('restart', '1');
  return '/read/' + encodeURIComponent(bookId) + '?' + q;
}
// Routes are detours: they never change the stored reading path.
export function eventAlternatives(adjacent, path) {
  const candidates = path === 'all'
    ? [['Next recommended', adjacent.nextRecommended], ['Next essential', adjacent.nextEssential]]
    : path === 'recommended'
    ? [['Next essential', adjacent.nextEssential], ['Next issue of any tier', adjacent.nextAll]]
    : [['Next recommended', adjacent.nextRecommended], ['Next issue of any tier', adjacent.nextAll]];
  const seen = new Set([adjacent.next?.id]);
  return candidates.filter(([, issue]) => { if (!issue || seen.has(issue.id)) return false; seen.add(issue.id); return true; })
    .map(([label, issue]) => ({ label, issue }));
}
export function pathEndMessage(context, completed) {
  if (!context?.path || context.path === 'all') return null;
  const label = PATH_LABELS[validPath(context.path)];
  return completed && context.remainingOther === 0
    ? label + ' reading complete ✓'
    : 'End of the owned issues in your ' + label + ' path. Check the event for unread or missing issues.';
}
