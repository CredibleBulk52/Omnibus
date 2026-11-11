import React, {useState} from 'react';
import './membershipPicker.css';
export default function MembershipPicker({label,items,selected,onChange}) {
 const [query,setQuery]=useState('');
 const title=i=>i.displayTitle||i.name||i.title||String(i.id);
 const shown=items.filter(i=>title(i).toLowerCase().includes(query.trim().toLowerCase()));
 return <fieldset className="membership-picker"><legend>{label} · {selected.length} selected</legend>
 <input className="form-input rl-input" aria-label={`Find ${label.toLowerCase()}`} placeholder={`Find ${label.toLowerCase()}…`} value={query} onChange={e=>setQuery(e.target.value)}/>
 <div className="membership-options">{shown.map(i=>{const id=String(i.id);return <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={e=>onChange(e.target.checked?[...selected,id]:selected.filter(v=>v!==id))}/><span>{title(i)}{i.displayYear?` (${i.displayYear})`:''}</span></label>;})}{!shown.length&&<span>No matches.</span>}</div></fieldset>;
}
