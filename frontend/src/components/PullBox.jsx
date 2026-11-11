import React, {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import RequestSeriesDialog from './RequestSeries';
import {useConfirm} from './Confirm';
import '../readingOrderActions.css';
import '../pullBox.css';
export const PULL_CHANGED='omnibus-pull-changed';
export async function pullRequest(path='',method='GET'){
 const r=await fetch('/api/users/me/pull-box'+path,{method,cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load your Pull Box.');return data;
}
// children: buttons that sit right beside + Pull (series page: + Add to a box, 2026-11-04).
export function PullButton({seriesId,name,status,children}){
 const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[request,setRequest]=useState(false);const confirm=useConfirm();
 useEffect(()=>{let active=true;setData(null);setError('');pullRequest('/series/'+encodeURIComponent(seriesId)).then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[seriesId]);
 const toggle=async()=>{if(!data||busy)return;if(data.pulled && !await confirm({title:'Remove from My Pull Box?',message:`Stop including ${name} in My Pulls? Your reading progress and library files stay unchanged.`,confirmLabel:'Remove series'}))return;
 setBusy(true);setError('');try{const d=await pullRequest('/series/'+encodeURIComponent(seriesId),data.pulled?'DELETE':'POST');setData(d);window.dispatchEvent(new Event(PULL_CHANGED));}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <div className="order-utility-actions pull-control"><button className="order-list-button" disabled={busy||!data} aria-pressed={!!data?.pulled} onClick={toggle}>{busy?'Saving…':data?.pulled?'✓ On your pull list':'+ Pull'}</button>{children}
 {data?.pulled && <Link className="pull-box-link" to="/my-pull-box">My Pull Box →</Link>}
 {data?.pulled && data.collecting===false && ['ongoing','continuing'].includes(String(status || '').trim().toLowerCase()) && <div className="pull-note">This series isn’t actively monitored for new issues. Pulling it doesn’t enable downloads. <button onClick={()=>setRequest(true)}>Request this series</button></div>}
 {error&&<p role="alert">{error}</p>}{request&&<RequestSeriesDialog initialName={name} onClose={()=>setRequest(false)}/>}</div>;
}
export function FavoritesMigration({count,onChange}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');if(!count)return null;
 const choose=async action=>{setBusy(true);try{const d=await pullRequest('/'+action+'-favorites','POST');onChange(d);window.dispatchEvent(new Event(PULL_CHANGED));}catch(e){setError(e.message);}finally{setBusy(false);}};
 return <section className="pull-migration"><strong>Bring your favorites into My Pull Box?</strong><p>Your {count} saved series can become pulls. This won’t enable downloads.</p><button className="btn btn-primary" disabled={busy} onClick={()=>choose('import')}>Import favorites</button> <button className="btn btn-secondary" disabled={busy} onClick={()=>choose('skip')}>No thanks</button>{error&&<p role="alert">{error}</p>}</section>;
}
