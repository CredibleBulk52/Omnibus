import React, {useState} from 'react';
import {useConfirm} from './Confirm';
import {rlApi} from './ReadingListBits';
// Shared destructive action: remove the catalog record, never the comic files.
export default function DeleteCatalogAction({endpoint,label,name,message,onDeleted}) {
 const confirm=useConfirm(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const remove=async()=>{
  if(!(await confirm({title:`Delete ${label}?`,message:message||`Delete “${name}”? Comic files and your reading progress will stay in the library.`,confirmLabel:`Delete ${label}`,danger:true})))return;
  setBusy(true);setError('');try{const result=await rlApi('DELETE',endpoint);onDeleted(result);}catch(e){setError(e.message);setBusy(false);}
 };
 return <><button type="button" className="btn-danger manage-menu-danger" disabled={busy} onClick={remove}>{busy?'Deleting…':`Delete ${label}`}</button>{error&&<small className="rl-error" role="alert">{error}</small>}</>;
}
