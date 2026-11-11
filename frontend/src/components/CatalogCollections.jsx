import {InfoTip} from '../App';
import React from 'react';
import './catalogCollections.css';
export default function CatalogCollections({value=[],options=[],onChange,id}) {
 const records=options.map(o=>typeof o==='string'?{id:o,name:o}:o);
 const selected=value.map(v=>records.find(o=>o.id===v||o.name===v)||{id:v,name:v});
 return <div className="catalog-collections">
  <div className="catalog-collection-chips">{selected.map((o,i)=><button type="button" key={o.id} onClick={()=>onChange(value.filter((_,j)=>j!==i))} aria-label={`Remove ${o.name}`}>{o.name} <span aria-hidden="true">×</span></button>)}</div>
  <select id={id} className="rl-input le-d-input" value="" disabled={value.length>=20} onChange={e=>e.target.value&&onChange([...value,e.target.value])}><option value="">Add to collection…</option>{records.filter(o=>!selected.some(s=>s.id===o.id)).map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
  <InfoTip text="Create collections on the Essentials page. A journey can belong to more than one."/>
 </div>;
}
