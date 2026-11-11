import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import ComicIssueDetail from './ComicIssueDetail';
import { isAdmin } from '../App';
import { reportProblem } from './ReportProblem';

export default function DownloadIssueInspector({ issue, onClose, onChanged, onRetag, onSearch }) {
 const navigate = useNavigate();
 const [book, setBook] = useState(null), [error, setError] = useState('');
 const [coverFailed, setCoverFailed] = useState(false);
 const [loading, setLoading] = useState(!!issue.book_id), [details, setDetails] = useState(false);
 const [check, setCheck] = useState(null), [checking, setChecking] = useState(false);
 const label = `${issue.series_name || 'Issue'} #${issue.issue_number}`;
 useEffect(() => {
  let active = true;
  if (issue.book_id) fetch(`/api/books/${encodeURIComponent(issue.book_id)}`).then(async r => {
   if (!r.ok) throw Error('The linked library issue could not be loaded. Refresh this series and try again.');
   return r.json();
  }).then(b => { if (active) setBook(b); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
  return () => { active = false; };
 }, [issue.book_id]);
 const checkArchive = async () => {
  setChecking(true); setCheck(null);
  try {
   const r = await fetch(`/api/books/${encodeURIComponent(book.id)}/pages`);
   const d = await r.json();
   if (!r.ok) throw Error(d.error || 'Could not read the archive.');
   setCheck({ text: d.count > 0 ? `Archive opened; ${d.count} image pages found.` : 'Archive opened, but no image pages were found.', at: new Date().toLocaleTimeString() });
  } catch(e) { setCheck({ text: e.message, failed: true, at: new Date().toLocaleTimeString() }); }
  setChecking(false);
 };
 if (details && book) return <ComicIssueDetail book={book} seriesTitle={issue.series_name} onClose={() => setDetails(false)} onRead={() => navigate(`/read/${book.id}`)}
  deletionNote="If this is the last library copy, the monitored issue becomes Wanted again and may be downloaded by a later scan. Skip it afterward if you do not want a replacement."
  onTagged={() => onChanged?.()} onDeleted={() => { onChanged?.(); onClose(); }} />;
 return <Modal title={label} onClose={onClose} width={680} className="dm-inspector" footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}>
  <div className="dm-inspector-body">
   {loading && <p>Loading library details…</p>}
   {error && <p role="alert">{error}</p>}
   <div className="dm-inspector-overview">
    {book && !coverFailed && <img onError={() => setCoverFailed(true)} className="dm-inspector-cover" src={`/api/books/${book.id}/thumbnail`} alt={`Cover of ${label}`} />}
    {book && coverFailed && <div className="dm-inspector-cover dm-cover-unavailable">Cover unavailable</div>}
    <div><h2>{issue.title || label}</h2><dl>
     <dt>Download status</dt><dd>{issue.waiting ? 'Waiting' : issue.status}</dd>
     <dt>Released</dt><dd>{issue.release_date || 'Unknown'}</dd>
     <dt>Embedded metadata</dt><dd>{issue.has_comicinfo === 0 ? 'Missing' : issue.has_comicinfo === 1 ? 'Present' : 'Not checked'}</dd>
     {book && <><dt>File</dt><dd>{book.filename || 'Linked library file'}</dd><dt>Recorded size</dt><dd>{book.file_size > 0 ? `${(book.file_size / 1048576).toFixed(1)} MB` : 'Unknown'}</dd></>}
    </dl></div>
   </div>
   {!loading && !book && !error && <p>No linked library file is available for inspection. If it was recently downloaded, refresh the series after the library scan completes.</p>}
   <div className="dm-inspector-actions">
    {book && <><button className="btn btn-primary" onClick={() => navigate(`/read/${book.id}`)}>Open issue</button><button className="btn btn-secondary" onClick={() => setDetails(true)}>Issue details{isAdmin() ? ' & manage' : ''}</button>
    {book.series_id && <button className="btn btn-secondary" onClick={() => navigate(`/series/${book.series_id}`)}>View in library</button>}</>}
    {isAdmin() && <button className="btn btn-secondary" onClick={onSearch}>{book ? 'Find replacement' : 'Search for issue'}</button>}
    {isAdmin() && !book && issue.status === 'processed' && <button className="btn btn-secondary" onClick={() => { onRetag(); onClose(); }}>Retag</button>}
    <button className="btn btn-secondary" onClick={() => { onClose(); reportProblem(book ? { type:'book', id:book.id, label, kinds:['file','metadata','other'] } : { type:'page', label, kinds:['other'] }); }}>Report a problem</button>
   </div>
   {isAdmin() && book && <section className="dm-archive-check"><h3>Archive check</h3><p>Checks whether the archive opens and contains image pages. It does not validate every page or the issue’s identity.</p><button className="btn btn-secondary" disabled={checking} onClick={checkArchive}>{checking ? 'Checking…' : 'Check archive'}</button>{check && <p role="status">{check.at} — {check.text}</p>}</section>}
  </div>
 </Modal>;
}
