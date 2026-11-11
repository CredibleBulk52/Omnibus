import BrandingCrop from './BrandingCrop';
import React, { useState } from 'react';
import { useConfirm } from './Confirm';
import { readingPalettes } from '../themes/readingPalettes';
import { brandingKey, useBranding, assetFor, refreshBranding, PublisherLogo, CharacterSymbol } from './Branding';
export function BrandingEditor({kind,name}){
 const assets=useBranding(),asset=assetFor(assets,kind,name); const confirm=useConfirm();
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [pending,setPending]=useState(null);
 const key=asset?.key||brandingKey(kind,name);const url='/api/branding/'+kind+'/'+encodeURIComponent(key);
 async function run(action){setBusy(true);setError('');setMessage('');try{await action();await refreshBranding();setMessage('Saved. Shared appearances update automatically.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function request(method,path,body,headers){const r=await fetch(path,{method,body,headers});if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'Could not save artwork.');}}
 async function upload(file){if(!file)return;if(!['image/png','image/jpeg'].includes(file.type)||file.size>5*1024*1024){setError('Choose a PNG or JPEG up to 5 MB.');return;}setError('');setMessage('');setPending(file);}
 return <details className="brand-editor"><summary>Branding{asset?' · image uploaded':''}</summary><div className="brand-editor-body">
 <p>Optional {kind==='publisher'?'publisher logo':'shared character symbol'} for {name}. No image means the existing text or hero is used.</p>
 {kind==='character'&&<small>This upload is shared by every title matching this palette identity, even when page colors are turned off.</small>}
 {asset&&<div className="brand-preview">{kind==='publisher'?<><figure><PublisherLogo name={name} size="filter"/><figcaption>Filter button</figcaption></figure><figure><PublisherLogo name={name} size="heading"/><figcaption>Section heading</figcaption></figure><figure><PublisherLogo name={name} size="hero"/><figcaption>Hero card</figcaption></figure></>:<CharacterSymbol title={name}/>}</div>}
 <label>{asset?'Replace image':'Upload image'}<input aria-label={'Upload artwork for '+name} disabled={busy || !!pending} type="file" accept="image/png,image/jpeg" onChange={e=>{upload(e.target.files?.[0]);e.target.value='';}}/></label>
 {asset&&!pending&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const r=await fetch(url+'/image');if(!r.ok)throw Error('Could not load artwork.');setPending(await r.blob());}catch(e){setError(e.message);}finally{setBusy(false);}}}>Adjust crop</button>}
 {pending&&<BrandingCrop key={pending.name || 'existing'} file={pending} busy={busy} onCancel={()=>{setPending(null);setError('');}} onSave={crop=>run(async()=>{await request('PUT',url+'/image?crop='+encodeURIComponent(JSON.stringify(crop)),pending,{'Content-Type':pending.type});setPending(null);})}/>}
 {asset&&!pending&&<AssetOptions key={asset.version} asset={asset} kind={kind} busy={busy} onSave={(scale,aliases)=>run(()=>request('PATCH',url,JSON.stringify({scale,aliases}),{'Content-Type':'application/json'}))}/>}
 {asset&&!pending&&<button className="btn btn-ghost" disabled={busy} onClick={async()=>{if(await confirm({title:'Remove shared artwork?',message:'This removes the image everywhere that uses it. Text and normal hero layouts will return.',confirmLabel:'Remove',danger:true}))run(()=>request('DELETE',url));}}>Remove image</button>}
 {busy&&<span role="status">Saving…</span>}{message&&<span role="status">{message}</span>}{error&&<span className="brand-error" role="alert">{error}</span>}
 </div></details>;
}
function AssetOptions({asset,kind,busy,onSave}){const [scale,setScale]=useState(asset.scale),[aliases,setAliases]=useState(asset.aliases.join(', '));return <>
 <label>Display size <input aria-label="Artwork display size" type="range" min="0.5" max="1" step="0.05" value={scale} onChange={e=>setScale(Number(e.target.value))}/>{Math.round(scale*100)}%</label>
 {kind==='publisher'&&<label>Other publisher names <input type="text" value={aliases} onChange={e=>setAliases(e.target.value)} placeholder="Comma-separated aliases"/></label>}
 <button className="btn btn-secondary" disabled={busy} onClick={()=>onSave(scale,aliases.split(',').map(s=>s.trim()).filter(Boolean))}>Save display settings</button>
 </>;}
export default function CharacterSymbolsSettings(){const [name,setName]=useState(readingPalettes[0].name);const palette=readingPalettes.find(p=>p.name===name);return <div className="brand-symbol-settings"><p>Optional symbols shared by character and team identity. Unmatched or mixed-character titles show no symbol.</p><label>Character or team <select value={name} onChange={e=>setName(e.target.value)}>{readingPalettes.map(p=><option key={p.name}>{p.name}</option>)}</select></label><p>Matches: {palette.aliases.join(', ')}</p><BrandingEditor key={name} kind="character" name={name}/></div>;}
