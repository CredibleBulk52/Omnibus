// Fetch every owned book in this folder, including annuals and specials.
export async function markSeriesRead(seriesId, title, request = fetch, confirm = window.confirm.bind(window), completed = true) {
  const response = await request(`/api/series/${encodeURIComponent(seriesId)}/books?includeAll=true`);
  if (!response.ok) throw new Error('Unable to load owned issues. Please try again.');
  const data = await response.json();
  if (!Array.isArray(data.content)) throw new Error('Unexpected issue list. Please refresh and try again.');
  const bookIds = [...new Set(data.content.map(book => book.id).filter(Boolean))];
  if (!bookIds.length) return 0;
  const n = `${bookIds.length} owned issue${bookIds.length === 1 ? '' : 's'}`;
  const question = completed
    ? `Mark all ${n} of "${title}" as read?\n\nIncludes annuals and specials in this series folder. Linked annual series are unchanged. This updates only your reading progress.`
    : `Mark all ${n} of "${title}" as unread?\n\nThis clears your reading progress for them: pages, completion and their place in Continue Reading. Includes annuals and specials in this series folder.`;
  if (!(await confirm(question))) return null;   // confirm may be the app's dialog (a promise) or window.confirm
  const result = await request('/api/books/batch/mark-read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookIds, completed }),
  });
  if (!result.ok) throw new Error('The update failed. Please try again.');
  return bookIds.length;
}
