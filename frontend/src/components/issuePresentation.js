// Display-only cleanup; source ComicInfo and archive files are never rewritten.
export function issueText(value) {
  let text = String(value || '');
  for (let i = 0; i < 3; i++) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script,style').forEach(el => el.remove());
    doc.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
    doc.querySelectorAll('p,div,tr,li').forEach(el => el.append('\n'));
    const next = doc.body.textContent || '';
    if (next === text) break;
    text = next;
  }
  return text.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function uniqueCredits(value) {
  const seen = new Set();
  return issueText(value).split(/[,;\n]+/).map(s => s.trim()).filter(s => {
    const key = s.toLocaleLowerCase();
    if (!s || seen.has(key)) return false;
    seen.add(key); return true;
  }).join(', ');
}
export function issueSummary(value) {
  const text = issueText(value);
  const match = /list of covers and their creators\s*:?/i.exec(text);
  return match ? { story:text.slice(0,match.index).trim(), supplement:text.slice(match.index).trim() } : { story:text, supplement:'' };
}
