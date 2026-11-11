import { useConfirm } from '../components/Confirm';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import './MetadataPanel.css';
import {requestMetadata as request} from './metadataRequest';
import {when, explainProblem, checkResult, updateReceipt, describeResult} from './metadataFeedback';
import {healthChanged} from '../components/LibraryHealth';

const labels={review:'Manual intervention',waiting:'Manual intervention',source:'Waiting for Comic Vine data',retry:'Waiting to retry',budget:'Waiting for Comic Vine',due:'Queued',scheduled:'Scheduled for later',complete:'No more checks planned',unqueued:'Waiting for first review'};
const centralTime=value=>value?new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)):'';
const purpose=book=>({normalization:'Convert to CBZ',initial:'Add book details',identification:'Find a Comic Vine match',recent:'Update recent book details',date_discovery:'Find the release date',date_check:'Check the release date',upcoming:'Wait for release',idle:'No automatic updates planned'}[book.kind]||'Metadata check');
const statusHelp=(book,providerRetryAt)=>{
  const task=purpose(book).toLowerCase(),time=when(Math.max(book.due_at||0,providerRetryAt||0));
  const timing=time ? 'Can try after '+time+'. Routine work waits for 1–6 AM Central. New arrivals and requested checks can run during the day. Other books or Comic Vine limits may add a wait.' : 'No automatic retry is scheduled.';
  const descriptions={
    review:'Omnibus needs your help before continuing. If no match was found, choose the correct Comic Vine issue. If two files or IDs conflict, resolve that conflict first; this page cannot replace an existing conflicting ID.',
    waiting:'Omnibus stopped trying automatically. Read the explanation below, choose the correct Comic Vine issue if needed, and try again once the problem is fixed.',
    source:'Comic Vine did not supply the needed issue data. Retrying '+task+'. '+timing,
    retry:'This check could not finish. Next task: '+task+'. '+timing,
    budget:'Comic Vine requests are temporarily paused. Waiting to '+task+' when requests are available again. '+timing,
    due:'Ready to '+task+'. Routine work runs from 1–6 AM Central, one book at a time, as Comic Vine allows. Being ready does not mean this book is being checked right now.',
    scheduled:'Waiting to '+task+'. '+timing,
    complete:'No further automatic checks are planned. Older books with a Comic Vine ID are left alone. Recent books stop after their final check. You can still use Check now.',
    unqueued:'Omnibus has not yet decided whether this book needs a check. It will review the information already saved in your library first.'
  };
  return descriptions[book.state]||'Open Details & actions for this book’s current work.';
};
function BatchStatus({data}){
  const b=data.batch,r=b?.result||{},unit=b?.scope==='single'?'Book check':b?.scope==='overnight'?'Overnight updates':b?.scope==='arrivals'?'New book checks':'Library batch';
  const title=b?.state==='running'?'Batch running':({finished:'Batch finished',waiting:'Batch stopped — waiting for overnight hours',deferred:'Batch stopped — waiting for Comic Vine',recovery:'Batch stopped — an unfinished update needs attention',paused:'Batch paused for an app update',interrupted:'Previous batch ended without a result',failed:'Batch stopped unexpectedly'}[b?.state]||'No batch running');
  return <div className="metadata-banner" role="status" aria-live="polite"><strong>{title.replace(/^Batch/,unit)}</strong>
    {b&&<><span> · {b.state==='running'?b.examined+' of '+b.selected+' books reviewed':when(b.finishedAt)||'Completion time unavailable'}</span><div>{r.checked||0} checked · {r.completed||0} successful · {(r.review||0)+(r.failed||0)} need attention · {r.deferred||0} waiting to retry</div><small>Started {when(b.startedAt)} · {b.scope==='single'?'Single-book check':b.scope==='arrivals'?'New arrivals and requested checks':'All libraries'} · Successful means the check finished; the file may not need changes.</small></>}
    {!b&&<span> · No completed batch has been recorded since this feature was installed.</span>}
    {b?.state!=='running'&&data.running&&<div>Omnibus is still updating another book.</div>}
    <div className="metadata-muted">Check now selects only one book. Automatic backlog checks run from 1–6 AM Central. Other books may still be waiting after a batch finishes. Status refreshes automatically.</div>
  </div>;
}
function Help({text,children,className=''}){
  const id=useId();return <span className={'metadata-tip '+className} tabIndex={0} aria-describedby={id}>{children}<span role="tooltip" id={id}>{text}</span></span>;
}
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});

function BookRow({book,onChange,onNotice,onCheck,pending,limitReached,blocked,providerRetryAt,runningBookId,running}){
  const confirm = useConfirm();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [query,setQuery]=useState(''),[results,setResults]=useState(null),[choose,setChoose]=useState(false);
  const act=async action=>{setBusy(true);setError('');try{await action();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const retry=()=>act(()=>onCheck(book));
  const search=()=>act(async()=>{setResults(null);const data=await request(`/api/cv/issues/search?q=${encodeURIComponent(query.trim())}`);setResults(data.results||[]);});
  // Damaged CBR: keep the readable pages, leave the damaged ones out.
  // Convert anyway keeps the readable pages of a damaged RAR; damaged CBZ files need a new copy.
  const damaged=/ARCHIVE_DAMAGED|Damaged archive/.test(book.last_error||'')&&/\.(cbr|rar)$/i.test(book.filename||'');
  const salvage=()=>act(async()=>{
    if (!(await confirm({ message: `Convert "${book.filename}" without its damaged pages?\n\n${(book.last_error||'').replace(/^[A-Z_]+:\s*/,'')}\n\nThe readable pages are kept; the damaged ones are left out of the new file.`, title: 'Convert without damaged pages?', confirmLabel: 'Convert' }))) return;
    await request(`/api/books/${encodeURIComponent(book.id)}/tag`,post({salvage:true}));
    onNotice(book.filename+': converted without its damaged pages.');await onChange();});
  // Flagged by Library health as a possible mistag: keep the current match, or choose another.
  const mistag=/^Possible mistag:/.test(book.last_error||'')&&!!book.cv_issue_id;
  const keepMatch=()=>act(async()=>{await request(`/api/admin/library-health/books/${encodeURIComponent(book.id)}/keep-match`,post());onNotice(book.filename+': current match kept.');await onChange();healthChanged();});
  const apply=issue=>act(async()=>{await request(`/api/books/${encodeURIComponent(book.id)}/tag`,post({cvIssueId:String(issue.id)}));setChoose(false);setResults(null);onNotice(book.filename+': Book details updated.');await onChange();});
  return <article className="metadata-book">
    <div className="metadata-book-main"><div className="metadata-book-title"><a href={`/series/${encodeURIComponent(book.series_id)}`}>{book.series_name}</a><div>{book.filename}</div><p className="metadata-reason">{runningBookId===book.id?'Checking this book…':pending?'Your check is waiting. Follow its progress above.':book.last_error?explainProblem(book.last_error):book.state==='scheduled'?'Next eligible check: '+when(Math.max(book.due_at||0,providerRetryAt||0)):purpose(book)}</p></div>
      <div className="metadata-book-status"><Help text={statusHelp(book,providerRetryAt)+(book.last_error?' Last check: '+explainProblem(book.last_error):'')} className={`metadata-badge ${['review','waiting'].includes(book.state)?'attention':''}`}>{runningBookId===book.id?'Checking now…':labels[book.state]||book.state}</Help>{book.match_note&&<small>Matched by Claude · please check</small>}</div>
      <button className="adm-btn adm-btn-ghost" title={blocked?'Resolve the unfinished update before checking another book.':'Check this book now if Omnibus and Comic Vine are available. Otherwise, add it near the front of the waiting list.'} disabled={busy||blocked||pending||limitReached||runningBookId===book.id} onClick={retry}>{runningBookId===book.id?'Checking…':busy?'Requesting…':pending?'Waiting…':blocked?'Paused':limitReached?'Tracking 20 checks':running||providerRetryAt>Date.now()?'Queue check':['review','waiting'].includes(book.state)?'Try again':'Check now'}</button>
    </div>
    <div className="metadata-row-actions">{damaged&&<button className="adm-btn" disabled={busy||blocked||pending} title="Keep every readable page and leave the damaged ones out" onClick={salvage}>Convert anyway</button>}{mistag&&<button className="adm-btn" disabled={busy||blocked||pending} title={`The file is tagged correctly as Comic Vine ${book.cv_issue_id}; stop flagging it`} onClick={keepMatch}>Keep current match</button>}{(!book.cv_issue_id||mistag)&&<button className="adm-btn adm-btn-ghost" disabled={busy||blocked||pending} aria-expanded={choose} onClick={()=>setChoose(!choose)}>{choose?'Close match selection':'Choose match'}</button>}{/OCCUPIED|Duplicate copy|destination filename/i.test(book.last_error||'')&&<a href={`/series/${encodeURIComponent(book.series_id)}`}>Review files on series page ↗</a>}</div>
    {error&&<p role="alert" className="metadata-error">{error}</p>}
    <details className="metadata-details"><summary>Details</summary>
      <p>{statusHelp(book,providerRetryAt)}</p><dl><div><dt>Last check</dt><dd>{when(book.checked_at)||'Not checked yet'}</dd></div><div><dt>Next check</dt><dd>{when(Math.max(book.due_at||0,providerRetryAt||0))||(book.state==='review'||book.state==='waiting'?'After correcting the problem and choosing Check now':'Not scheduled')}</dd></div><div><dt>Release date used for checks</dt><dd>{book.publication_date?book.publication_date+' · '+({store_date:'Comic Vine store date',cover_date:'Cover date (store date unavailable)',comicinfo:'Month saved in the book (store date unavailable)'}[book.date_basis]||'Stored date'):book.cv_issue_id?'Unknown — check monthly until a date is found':'Unknown — find a Comic Vine match first'}</dd></div><div><dt>Next planned update</dt><dd>{book.milestone?book.milestone+' days after release':'None'}</dd></div><div><dt>Comic Vine issue</dt><dd>{book.cv_issue_id?<a href={`https://comicvine.gamespot.com/issue/4000-${book.cv_issue_id}/`} target="_blank" rel="noreferrer">{book.cv_issue_id} ↗</a>:'No Comic Vine ID saved for this book'}</dd></div>{book.last_result&&<div><dt>Last check result</dt><dd>{describeResult(book.last_result)}</dd></div>}</dl>
      {book.match_note&&<div className="metadata-note"><strong>Matched by Claude — please check</strong><p>{book.match_note.replace(/^AI match: /,'')}</p><p>Omnibus could not match this annual by its rules, so Claude picked it from Comic Vine's annuals. If it's wrong, open the book's Details on its series page and use Tag with Comic Vine URL.</p></div>}
      {book.last_error&&<div className="metadata-note"><strong>Reported problem</strong><p>{book.last_error}</p></div>}

    </details>
        {(!book.cv_issue_id||mistag)&&choose&&<div className="metadata-identify"><p>Paste a Comic Vine issue link or ID. Applying the match adds book details and renames the file using your usual naming format.</p><form onSubmit={e=>{e.preventDefault();search();}}><input aria-label={`Comic Vine issue for ${book.filename}`} value={query} onChange={e=>{setQuery(e.target.value);setResults(null);}} placeholder="Issue URL or 4000-12345"/><button className="adm-btn" disabled={busy||!query.trim()||blocked}>Look up issue</button></form>
          {results?.length===0&&<p>No matching issue found. Check the URL or ID.</p>}{results?.map(issue=><div className="metadata-match" key={issue.id}><div><strong>{issue.volume_name} #{issue.issue_number}</strong><small>{[issue.name,issue.cover_date].filter(Boolean).join(' · ')}</small></div><button className="adm-btn" disabled={busy||blocked} onClick={()=>apply(issue)}>Apply match</button></div>)}
        </div>}
  </article>;
}

export default function MetadataPanel({initialView='intervention',libraryId=null,libraryName=null}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [view,setView]=useState(initialView),[search,setSearch]=useState(''),[term,setTerm]=useState(''),[offset,setOffset]=useState(0);
  const [report,setReport]=useState(null),[receipts,setReceipts]=useState([]),[updatedAt,setUpdatedAt]=useState(null),[refreshing,setRefreshing]=useState(false);
  const receiptRef=useRef([]),flight=useRef(null),sequence=useRef(0),pollFast=useRef(false),loadRef=useRef(null);
  const saveReceipts=useCallback(next=>{receiptRef.current=next;setReceipts(next);},[]);
  useEffect(()=>{const timer=setTimeout(()=>{setTerm(search);setOffset(0);},250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{setOffset(0);setData(null);setView(initialView);},[libraryId,initialView]);
  const load=useCallback(()=>{
    // A slow response must not be discarded by a newer polling timer.
    const key=JSON.stringify([view,term,offset,libraryId]);
    if(flight.current?.key===key)return flight.current.promise;
    flight.current?.controller.abort();
    const controller=new AbortController(),n=++sequence.current;
    const ids=receiptRef.current.filter(r=>r.watching).map(r=>r.id);
    const params=new URLSearchParams({view,search:term,offset:String(offset),limit:'25'});
    if(libraryId)params.set('libraryId',libraryId);
    if(ids.length)params.set('track',ids.join(','));
    setRefreshing(true);
    const timeout=setTimeout(()=>controller.abort(),30000);
    const promise=(async()=>{
      try{
        const next=await request('/api/admin/metadata-status?'+params,{signal:controller.signal});
        if(n!==sequence.current)return;
        setData(next);setError('');setUpdatedAt(Date.now());
        saveReceipts(receiptRef.current.map(r=>updateReceipt(r,next,ids)));
        pollFast.current=next.running||receiptRef.current.some(r=>r.watching);
        if(offset>0&&offset>=next.matched)setOffset(Math.max(0,Math.floor((next.matched-1)/25)*25));
      }catch(e){if(n===sequence.current)setError(e.message);}
      finally{clearTimeout(timeout);if(n===sequence.current){flight.current=null;setRefreshing(false);}}
    })();
    flight.current={key,promise,controller};return promise;
  },[view,term,offset,libraryId,saveReceipts]);
  loadRef.current=load;
  useEffect(()=>{
    let stopped=false,timer;
    const tick=async()=>{await load();if(!stopped)timer=setTimeout(tick,pollFast.current?3000:15000);};
    tick();
    return()=>{stopped=true;clearTimeout(timer);sequence.current++;flight.current?.controller.abort();flight.current=null;};
  },[load]);
  const checkBook=async book=>{
    const initial={id:book.id,filename:book.filename,series_id:book.series_id,previousCheckedAt:book.checked_at??null,requestedAt:null,watching:true,phase:'waiting',message:'Requesting a check…'};
    const nextReceipts=[...receiptRef.current.filter(r=>r.id!==book.id),initial];
    if(nextReceipts.length>20){const oldestFinished=nextReceipts.findIndex(r=>!r.watching);if(oldestFinished!==-1)nextReceipts.splice(oldestFinished,1);}
    saveReceipts(nextReceipts);
    pollFast.current=true;
    try{
      const result=await request(`/api/admin/metadata-books/${encodeURIComponent(book.id)}/retry`,post());
      const settled=!!(result.completed||result.review||result.failed||result.deferred||result.held);
      saveReceipts(receiptRef.current.map(r=>r.id===book.id?{...initial,requestedAt:result.requestedAt??null,previousCheckedAt:result.previousCheckedAt??initial.previousCheckedAt,watching:!settled,phase:result.completed?'done':result.review||result.failed||result.held?'attention':'waiting',message:checkResult(result)}:r));
    }catch(e){
      // Never repeat a POST after a lost response; continue read-only status checks.
      saveReceipts(receiptRef.current.map(r=>r.id===book.id?{...r,phase:'attention',message:e.message}:r));
    }
    await loadRef.current();
  };
  const action=async fn=>{setBusy(true);setError('');setNotice('');try{await fn();await loadRef.current();}catch(e){setError(e.message);}finally{setBusy(false);}};
  const run=()=>action(async()=>{const result=await request('/api/admin/metadata-run',post());setNotice(result.started?'':checkResult(result));});
  const pause=()=>action(async()=>{const next=await request('/api/admin/metadata-pause',post({paused:!data.maintenanceWindow.paused}));setNotice(next.paused?'Overnight checks paused. The current book can finish.':'Overnight checks resumed. Routine work runs 1–6 AM Central.');});
  const inspect=()=>action(async()=>setReport(await request('/api/admin/metadata-reconciliation')));
  const clear=()=>action(async()=>{await request('/api/admin/metadata-reconciliation/clear-dangling',post());setReport(await request('/api/admin/metadata-reconciliation'));});
  const counts=data?.counts||{},blocked=!!data?.unfinished?.length,cooling=data?.providerRetryAt>Date.now();
  const categories=data?.categories||{},deferred=(counts.source||0)+(counts.retry||0)+(counts.budget||0);
  const filters=[['Book categories',[['intervention','Manual intervention'],['recent','Recently released'],['unidentified','No Comic Vine ID'],['damaged','Damaged files'],['unsafe','Unsafe archive paths'],['unknown','Release date unknown (has CV ID)'],['ai','Annuals matched by Claude'],['conversion','Needs CBZ conversion'],['all','All books']]],['Check timing',[['due','Queued'],['scheduled','Scheduled for later'],['deferred','Waiting to retry'],['complete','No more checks planned'],['unqueued','Waiting for first review']]]];
  const filterTitle=filters.flatMap(([,items])=>items).find(([value])=>value===view)?.[1]||'Books';
  const pendingCount=receipts.filter(r=>r.watching).length;
  const window=data?.maintenanceWindow,batch=data?.batch;
  const worker=blocked?'Updates need recovery':data?.running?(batch?.state==='running'&&batch.scope!=='single'?`Checking books · ${batch.examined} of ${batch.selected} reviewed`:'Checking a book…'):cooling?'Waiting for Comic Vine':batch?.state==='finished'?'Last check finished · nothing running':['failed','interrupted'].includes(batch?.state)?'Last check stopped — see Recent activity':'Nothing running';
  const scheduleText=window?.paused?'Overnight checks are paused':window?.open?'Automatic checking hours · 1–6 AM Central':window?.nextStart?'Next automatic window: '+centralTime(window.nextStart)+'–6 AM':'Automatic checks run 1–6 AM Central';
  return <section className="metadata-panel" aria-label="Metadata sweeper">
    <header className="metadata-header"><div><p className="metadata-eyebrow">{libraryId?(libraryName||'Selected library'):'All libraries'} · Comic Vine</p><h2>Metadata sweeper</h2><p className="metadata-muted">Keep new books up to date and help books that could not be matched.</p></div><button className="adm-btn adm-btn-ghost" onClick={load} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh status'}</button></header>
    {error&&<div role="alert" className="metadata-error">Status may be out of date. {error} <button className="adm-btn adm-btn-ghost" onClick={load}>Retry loading</button></div>}
    {!data?<p className="metadata-muted">{error?'Status could not be loaded.':'Loading book updates…'}</p>:<>
      <div className="metadata-status-strip"><div role="status" aria-live="polite"><strong><span className={`metadata-dot ${data.running?'working':''}`} aria-hidden="true"/>{worker}</strong><p>{cooling?'Requests can resume after '+when(data.providerRetryAt):scheduleText}</p></div><details className="metadata-controls"><summary>Run controls</summary><div><p>Manual checks can run during the day. Comic Vine limits still apply.</p><button className="adm-btn" disabled={busy||data.running||blocked||cooling} onClick={run}>Check up to 25 · all libraries</button>{window&&<button className="adm-btn adm-btn-ghost" disabled={busy} onClick={pause}>{window.paused?'Resume overnight checks':'Pause overnight checks'}</button>}</div></details></div>
      {blocked&&<p className="metadata-banner" role="alert">{data.unfinished.length} unfinished update(s) need recovery before more books can be changed. Affected books may be temporarily unavailable.</p>}
      <div className="metadata-stats metadata-cohorts">{[
        ['Recently released',categories.recent||0,'recent','Books released in the last 90 days. Includes books waiting for their next planned update at day 7, 30 or 90.'],
        ['No Comic Vine ID',categories.unidentified??data.needsIdentification??0,'unidentified','Books without a Comic Vine issue ID saved in Omnibus. They may already have other book details.'],
        ['Manual intervention',categories.intervention||0,'intervention','Checks that need a decision or correction from you. Waiting for Comic Vine alone does not put a book here.']
      ].map(([label,count,filter,help])=><Help key={label} text={help}><button aria-pressed={view===filter} onClick={()=>{setView(filter);setOffset(0);}}><span>{label}</span><strong>{count.toLocaleString()}</strong></button></Help>)}</div>
      <div className="metadata-toolbar"><div className="metadata-list-heading"><h3>{filterTitle}</h3><small>{data.matched.toLocaleString()} books</small></div><input aria-label="Search books" placeholder="Search series or filename…" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Show books" value={view} onChange={e=>{setView(e.target.value);setOffset(0);}}>{filters.map(([group,items])=><optgroup key={group} label={group}>{items.map(([value,label])=><option key={value} value={value}>{label}</option>)}</optgroup>)}</select></div>
      {(notice||receipts.length>0)&&<div className="metadata-receipts" aria-label="Your requested checks"><div role="status" aria-live="polite" aria-atomic="false">{notice&&<div className="metadata-receipt"><p>{notice}</p><button className="adm-btn adm-btn-ghost" onClick={()=>setNotice('')}>Dismiss</button></div>}{receipts.map(r=><div key={r.id} className={'metadata-receipt '+r.phase}><div><a href={`/series/${encodeURIComponent(r.series_id)}`}>{r.filename}</a><p>{r.message}</p></div><button className="adm-btn adm-btn-ghost" aria-label={'Dismiss result for '+r.filename} onClick={()=>saveReceipts(receiptRef.current.filter(item=>item.id!==r.id))}>{r.watching?'Hide':'Dismiss'}</button></div>)}</div><small>Requested checks in this visit. Results stay here even when a book leaves the list.</small></div>}
      <div className="metadata-books">{data.books.length?data.books.map(book=><BookRow key={book.id} book={book} onChange={()=>loadRef.current()} onNotice={setNotice} onCheck={checkBook} pending={receipts.some(r=>r.id===book.id&&r.watching)} limitReached={pendingCount>=20} blocked={blocked} providerRetryAt={data.providerRetryAt} runningBookId={data.runningBookId} running={data.running}/>):<div className="metadata-empty"><strong>{term?'No books match your search.':view==='intervention'?'No books need manual intervention in this view.':'No books in this group.'}</strong><p>Choose another group to see more books.</p></div>}</div>
      <nav className="metadata-pagination" aria-label="Book pages"><button className="adm-btn adm-btn-ghost" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-25))}>Previous</button><span>{data.matched?`${Math.min(offset+1,data.matched)}–${Math.min(offset+data.books.length,data.matched)} of ${data.matched}`:'0 books'}</span><button className="adm-btn adm-btn-ghost" disabled={offset+25>=data.matched} onClick={()=>setOffset(offset+25)}>Next</button></nav>
      <small className="metadata-freshness">{error?'Showing the last available status':refreshing?'Refreshing status…':'Updated '+when(updatedAt)} · Refreshes automatically, more often while checking.</small>
      <div className="metadata-footer">
        <details className="metadata-details"><summary>Recent activity{batch?.state==='finished'?' · last check finished':''}</summary><BatchStatus data={data}/>{data.overnightSummary&&<p>Overnight results for {data.overnightSummary.nightKey}: {data.overnightSummary.checked} checked · {data.overnightSummary.completed} finished · {data.overnightSummary.review+data.overnightSummary.failed} need help · {data.overnightSummary.deferred} waiting to retry.</p>}<p>Shows the latest recorded batch and overnight summary, not a complete history.</p></details>
        <details className="metadata-details"><summary>Waiting books & release dates</summary><p>{counts.due||0} ready for a check · {counts.scheduled||0} scheduled for later · {deferred} waiting to retry · {categories.conversion||0} awaiting CBZ conversion.</p><p>Ready means eligible for a check, usually overnight. Scheduled books wait for their next planned date. Retries wait because an earlier check could not finish.</p><p>Ready books need: {Object.entries(data.dueByKind||{}).map(([kind,count])=>count+' '+purpose({kind}).toLowerCase()).join(' · ')||'None'}.</p><p>{categories.unknownDates||0} books have no known release date: {categories.unknownDatesWithId||0} with a Comic Vine ID are checked monthly until a date is found; {categories.unknownDatesWithoutId||0} without an ID need a match first.</p><p>{counts.unqueued||0} books await their first review. {counts.complete||0} have no more automatic checks planned.</p></details>
        <details className="metadata-details"><summary>About these checks</summary><p>New books are converted to CBZ and tagged when they enter your library. Recent releases are checked again at day 7, 30 and 90. Books added later skip dates that have already passed. Older books with a Comic Vine ID are left alone.</p><p>Books with an ID but no release date are checked monthly until a date is found. Once known, recent books follow the remaining checks; older books leave the queue. A deferred final 90-day check may finish later.</p><p>Automatic work runs 1–6 AM Central. Check now requests only that book. Queue check requests it when another check is running or Comic Vine is temporarily unavailable. Neither starts a 25-book batch.</p><p>Groups can overlap. Counts are books, not API requests. Monitoring is not required. Automatic updates keep filenames, except when converting to CBZ. Choosing a match manually uses your normal filename convention.</p></details>
        {<details className="metadata-details"><summary>Library maintenance tools</summary><p>Check saved library references without requesting new Comic Vine data.</p><button className="adm-btn adm-btn-ghost" onClick={inspect} disabled={busy}>Check library references</button>{report&&<div className="metadata-note"><p>{report.danglingMonitoring} outdated download-tracking links · {report.missingIndexedIdentity} books without saved Comic Vine IDs · {report.identityConflict} conflicting IDs · {report.invalidXml} unreadable book details.</p><p>Removing outdated tracking links keeps your books, details, reading progress and lists.</p>{report.danglingMonitoring>0&&<button className="adm-btn" onClick={clear} disabled={busy}>Remove outdated tracking links</button>}</div>}</details>}
      </div>
    </>}
  </section>;
}

