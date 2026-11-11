export function browseIssues(issues, query = '', status = 'all', order = 'oldest') {
 const q = query.trim().toLowerCase().replace(/^#/, '');
 const rows = issues.filter(i => {
  const actual = i.waiting ? 'waiting' : i.in_pack ? 'snatched' : i.status === 'processed' && i.has_comicinfo === 0 ? 'untagged' : i.status;
  const number = String(i.issue_number ?? '');
  const matches = !q || number.toLowerCase().includes(q) || String(i.title || '').toLowerCase().includes(q) || (/^\d+$/.test(q) && Number(q) === Number(number));
  return matches && (status === 'all' || actual === status);
 });
 return order === 'newest' ? [...rows].reverse() : rows;
}
