export function filterWeeklyIssues(issues, query = '', publisher = 'all', status = 'all') {
 const q=query.trim().toLowerCase();
 return issues.filter(i=> {
  const number=String(i.issue_number || '');
  const search=`${i.volume?.name || ''} #${number} ${i.volume?.publisher || ''}`.toLowerCase();
  if(q && !search.includes(q)) return false;
  if(publisher!=='all' && (i.volume?.publisher || 'Unknown')!==publisher) return false;
  if(status==='monitored') return !!i.monitored;
  if(status==='unmonitored') return !i.monitored;
  if(status==='wanted') return i.issue_status==='wanted';
  if(status==='first') return /^0*1$/.test(number);
  return true;
 });
}
