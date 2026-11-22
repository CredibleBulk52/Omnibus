// Each reader's series view (backend/seriesView.js, 2026-11-22): 'issues' (Issues only, the default)
// or 'reading' (Reading order: annuals, specials and linked books placed after the issue they follow).
// Loaded once per page load and shared by every series page.
let cached = null;
export function loadSeriesView() {
  if (!cached) {
    cached = fetch('/api/users/me/series-view').then(r => (r.ok ? r.json() : null)).then(d => (d?.view === 'reading' ? 'reading' : 'issues'))
      .catch(() => { cached = null; return 'issues'; });
  }
  return cached;
}
export async function saveSeriesView(view) {
  cached = Promise.resolve(view);
  const r = await fetch('/api/users/me/series-view', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view }) });
  if (!r.ok) { cached = null; throw new Error((await r.json().catch(() => ({}))).error || 'Could not save the view'); }
  return view;
}
