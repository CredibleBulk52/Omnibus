import React,{useState} from 'react';
import {useConfirm} from './Confirm';
import {rlApi} from './ReadingListBits';
export default function DeleteSeriesAction({id,name,onDeleted}){
 const confirm=useConfirm(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const remove=async()=>{
  if(!await confirm({title:'Delete series and files?',message:`Permanently delete “${name}” and its entire series folder, including comics, artwork and metadata? This removes its reading progress for all users and stops monitoring this series. Separately stored annuals stay. This cannot be undone.`,confirmLabel:'Delete series and files',danger:true}))return;
  setBusy(true);setError('');try{await rlApi('DELETE',`/api/series/${id}`,{confirmName:name});onDeleted();}catch(e){setError(e.message);setBusy(false);}
 };
 return <><button className="btn-danger manage-menu-danger" disabled={busy} onClick={remove}>{busy?'Deleting…':'Delete series'}</button>{error&&<small className="rl-error" role="alert">{error}</small>}</>;
}
