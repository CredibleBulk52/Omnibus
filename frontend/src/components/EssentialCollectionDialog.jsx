import {InfoTip} from '../App';
import MembershipPicker from './MembershipPicker';
import DeleteCatalogAction from './DeleteCatalogAction';
import React, {useState} from 'react';
import {Modal,rlApi} from './ReadingListBits';
import {PublisherLogo,CharacterSymbol} from './Branding';
import {readingPalettes} from '../themes/readingPalettes';
import {collectionBranding} from '../pages/listCatalog';
export default function EssentialCollectionDialog({record,publishers,items=[],availableItems=[],onClose,onSaved}) {
 const [name,setName]=useState(record.name||''),[look,setLook]=useState(record.appearance||{}),[pinned,setPinned]=useState(record.pinned||[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [members,setMembers]=useState(items.map(l=>String(l.id)));
 const memberItems=availableItems.filter(l=>members.includes(String(l.id)));
 const identity=look.character?'character:'+look.character:look.publisher?'publisher:'+look.publisher:'site';
 const brand=collectionBranding(name,'group',publishers,look);
 const save=async()=>{setBusy(true);setError('');try{const d=await rlApi('POST','/api/essential-collections',{id:record.id,name,appearance:look,pinned:pinned.filter(id=>members.includes(id)),members});onSaved(d.collections);}catch(e){setError(e.message);setBusy(false);}};
 return <Modal title={record.id?'Edit collection':'New collection'} onClose={onClose} width={580} footer={<>{record.id&&<DeleteCatalogAction endpoint={`/api/essential-collections/${record.id}`} label="collection" name={record.name} message={`Delete “${record.name}”? Its reading orders will remain available in All Essentials and any other collections they belong to.`} onDeleted={d=>onSaved(d.collections)}/>}<button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy||!name.trim()} onClick={save}>{busy?'Saving…':'Save collection'}</button></>}>
 <div className="rl-modal-body lc-collection-dialog">
 <label className="rl-field"><span className="rl-label">Name</span><input autoFocus className="rl-input" value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
 <label className="rl-field"><span className="rl-label">Branding</span><select aria-label="Branding" className="rl-input" value={identity} onChange={e=>{const [kind,...rest]=e.target.value.split(':');setLook(kind==='site'?{publisher:''}:kind==='publisher'?{publisher:rest.join(':')}:{publisher:'',character:rest.join(':')});}}><option value="site">Site theme</option><optgroup label="Publishers">{publishers.map(n=><option key={n} value={'publisher:'+n}>{n}</option>)}</optgroup><optgroup label="Characters and teams">{readingPalettes.map(p=><option key={p.name} value={'character:'+p.name}>{p.name}</option>)}</optgroup></select></label>
 <div className="lc-publisher-head lc-collection-preview" data-publisher={brand.publisher||undefined} style={brand.style}>{brand.character?<CharacterSymbol title={brand.character}/>:brand.publisher?<PublisherLogo name={brand.publisher} size="heading"/>:null}<span className="lc-section-title">{name||'Your collection'}</span></div>
 <details><summary>Custom colors</summary><div className="lc-section-appearance"><label>Bar<input type="color" aria-label="Bar color" value={look.fill||brand.style['--publisher-fill']||'#252530'} onChange={e=>setLook({...look,fill:e.target.value})}/></label><label>Accent<input type="color" aria-label="Accent color" value={look.accent||brand.style['--publisher-accent']||'#f5c518'} onChange={e=>setLook({...look,accent:e.target.value})}/></label><button className="btn btn-secondary" onClick={()=>{const {fill,accent,...rest}=look;setLook(rest);}}>Use branding colors</button></div></details>
 <MembershipPicker label="Reading orders" items={availableItems} selected={members} onChange={setMembers}/>
 {memberItems.length>1&&<div className="rl-field"><span className="rl-label">Show first <InfoTip text="Chosen journeys appear in this order. The rest follow A–Z."/></span><div className="catalog-collection-chips">{pinned.map(id=><button type="button" key={id} onClick={()=>setPinned(pinned.filter(v=>v!==id))}>{memberItems.find(l=>String(l.id)===id)?.name||id} ×</button>)}</div><select className="rl-input" value="" onChange={e=>e.target.value&&setPinned([...pinned,e.target.value])}><option value="">Choose a journey…</option>{memberItems.filter(l=>!pinned.includes(String(l.id))).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></div>}
 {error&&<div role="alert" className="rl-error">{error}</div>}
 </div></Modal>;
}
