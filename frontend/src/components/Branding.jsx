import React, { useEffect, useState } from 'react';
import { identifyPalette } from '../themes/readingPalettes';
import '../branding.css';
export function brandingKey(kind, name) { let key=String(name||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); return kind==='publisher'?key.replace(/ comics$/,'').trim():key; }
let account, pending, fetchedAt = 0;
const images=new Map();
function token(){try{return localStorage.getItem('omnibus_token')||'';}catch{return '';}}
function catalog(){const user=token();if(Date.now()-fetchedAt>60000)pending=null;if(account!==user){account=user;pending=null;images.forEach(p=>p.then(url=>URL.revokeObjectURL(url)).catch(()=>{}));images.clear();}if(!pending){fetchedAt=Date.now();pending=fetch('/api/branding').then(r=>{if(!r.ok)throw Error('Artwork unavailable');return r.json().then(data=>Array.isArray(data)?data:[]);});}return pending;}
export async function refreshBranding(){pending=null;await catalog();window.dispatchEvent(new Event('omnibus:branding'));}
export function useBranding(){const [assets,setAssets]=useState([]);useEffect(()=>{let live=true;const update=()=>catalog().then(data=>{if(live)setAssets(data);}).catch(()=>{if(live)setAssets([]);});update();window.addEventListener('omnibus:branding',update);window.addEventListener('focus',update);return()=>{live=false;window.removeEventListener('omnibus:branding',update);window.removeEventListener('focus',update);};},[]);return assets;}
export function assetFor(assets,kind,name){const key=brandingKey(kind,name);return assets.find(a=>a.kind===kind&&a.key===key)||assets.find(a=>a.kind===kind&&a.aliases?.includes(key));}
// An uploaded artwork's image as a blob URL (null until loaded or when there is none). Theme banners use it (2026-11-11).
export function useBrandingImage(asset){const [url,setUrl]=useState(null);const id=asset?asset.kind+'/'+asset.key+'/'+asset.version:null;
 useEffect(()=>{let live=true;setUrl(null);if(!asset)return undefined;const cacheKey=token()+'/'+id;
 if(!images.has(cacheKey))images.set(cacheKey,fetch('/api/branding/'+asset.kind+'/'+encodeURIComponent(asset.key)+'/image?v='+asset.version).then(r=>{if(!r.ok)throw Error('Missing artwork');return r.blob();}).then(blob=>URL.createObjectURL(blob)));
 images.get(cacheKey).then(u=>{if(live)setUrl(u);}).catch(()=>{if(live)setUrl(null);});return()=>{live=false;};},[id]);
 return url;}
function Artwork({asset,alt,className,fallback=null,printed=false}){
 const [shape,setShape]=useState(null);
 const [loaded,setLoaded]=useState(null);const id=asset?asset.kind+'/'+asset.key+'/'+asset.version:null;
 useEffect(()=>{let live=true;if(!asset)return undefined;const cacheKey=token()+'/'+id;
 if(!images.has(cacheKey))images.set(cacheKey,fetch('/api/branding/'+asset.kind+'/'+encodeURIComponent(asset.key)+'/image?v='+asset.version).then(r=>{if(!r.ok)throw Error('Missing artwork');return r.blob();}).then(blob=>URL.createObjectURL(blob)));
 images.get(cacheKey).then(url=>{if(live)setLoaded({id,url});}).catch(()=>{if(live)setLoaded(null);});return()=>{live=false;};},[id]);
 if(!asset||loaded?.id!==id)return fallback;
 if(printed)return <span aria-hidden="true" className="essential-card-emblem" style={{'--emblem-image':`url("${loaded.url}")`,'--brand-scale':asset.scale||1}}/>;
 return <img className={className} data-shape={shape?.id===id?shape.value:undefined} onLoad={e=>{const img=e.currentTarget;setShape({id,value:img.naturalWidth/img.naturalHeight<=1.25?'compact':'wide'});}} src={loaded.url} alt={alt} style={{'--brand-scale':asset.scale||1}} onError={()=>setLoaded(null)}/>;
}
export function PublisherLogo({name,size='badge'}){const assets=useBranding();return <Artwork asset={assetFor(assets,'publisher',name)} alt={name} className={'brand-publisher brand-publisher--'+size} fallback={name||null}/>;}
export function CharacterSymbol({title,printed=false}){const assets=useBranding();const identity=identifyPalette(title);if(!identity)return null;return <Artwork asset={assetFor(assets,'character',identity.name)} alt="" className="brand-character" printed={printed}/>;}
