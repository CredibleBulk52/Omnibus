// Series browser views (2026-11-13, user): Series | One-shots | Tie-ins.
//   main      ongoing series and minis, plus shelved series that stay visible (lead-ins,
//             main-story minis, aftermaths); not one-shots and not hidden tie-ins.
//   oneshots  single-issue books (Comic Vine's count, not the owned count) on no shelf.
//   grouped   Tie-ins: everything on a Specials shelf (event tie-ins, series shelved under a home).
export const issuesOf = s => s.displayTotalIssues ?? s.seriesJson?.total_issues ?? s.book_count ?? 0;
export const isOneShot = s => !s.group && issuesOf(s) === 1;
export const viewCounts = list => ({ tieIns: list.filter(s => s.group).length, oneShots: list.filter(isOneShot).length });
export function filterSeriesView(list, view) {
  if (view === 'grouped') return list.filter(s => s.group);
  if (view === 'oneshots' || view === 'homeless') return list.filter(isOneShot);   // 'homeless': the older name
  return list.filter(s => !s.group?.hidden && !isOneShot(s));
}
