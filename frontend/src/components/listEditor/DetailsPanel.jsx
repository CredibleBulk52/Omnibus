// ─── DetailsPanel ─────────────────────────────────────────────────
// The hero information for the list being edited (name, description and
// the rest), at the top of the shared editor. Closed it is a one-line
// summary; open it shows the fields the adapter lists for this kind.
// Changes are part of the draft and save with everything else.
// claude/ADMIN_REORG.md step 3, "Hero details in the editor".
import React, { useState } from 'react';
import CatalogCollections from '../CatalogCollections';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const detailsDiff = (base, draft) => {
  if (!base || !draft) return null;
  const out = {};
  for (const k of Object.keys(draft)) if (!same(base[k], draft[k])) out[k] = draft[k];
  return Object.keys(out).length ? out : null;
};

function Field({ f, value, set, changed, events }) {
  const id = `le-d-${f.key}`;
  let input;
  if (f.type === 'textarea') input = <textarea id={id} className="le-d-input" rows={f.rows || 4} value={value ?? ''} placeholder={f.placeholder || ''} maxLength={f.max} onChange={e => set(e.target.value)} />;
  else if (f.type === 'select') input = (
    <select id={id} className="le-d-input" value={value ?? ''} onChange={e => set(f.number ? Number(e.target.value) : e.target.value)}>
      {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>);
  else if (f.type === 'switch') input = (
    <label className="le-d-switch"><input id={id} type="checkbox" checked={!!value} onChange={e => set(e.target.checked ? 1 : 0)} /> {f.switchLabel || 'On'}</label>);
  else if (f.type === 'collections') input = <CatalogCollections id={id} value={value || []} options={f.suggest || []} onChange={set} />;
  else if (f.type === 'event') input = <EventPicker id={id} value={value} events={events || []} set={set} />;
  else if (f.type === 'creators') input = <Creators value={value || []} roles={f.roles} set={set} />;
  else if (f.type === 'categories') input = <Categories value={value || []} options={f.options} set={set} />;
  else if (f.type === 'cover') input = (
    <div className="le-d-event-cur le-d-cover" id={id}>
      {value != null ? <>
        {f.image?.(value) && <img src={f.image(value)} alt="" />}
        <span>{f.describe?.(value) || 'An issue of this event'}</span>
        <button type="button" className="le-link" onClick={() => set(null)}>Use the automatic cover</button>
      </> : <span className="le-d-muted">{f.empty || 'Not chosen'}</span>}
    </div>);
  else input = <>
    <input id={id} className="le-d-input" type={f.type === 'number' ? 'number' : 'text'} value={value ?? ''} placeholder={f.placeholder || ''} maxLength={f.max}
      list={f.suggest?.length ? `${id}-opts` : undefined}
      onChange={e => set(f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} />
    {f.suggest?.length > 0 && <datalist id={`${id}-opts`}>{f.suggest.map(o => <option key={o} value={o} />)}</datalist>}
  </>;
  const help = typeof f.help === 'function' ? f.help(value) : f.help;
  return (
    <div className={`le-d-field${f.wide ? ' wide' : ''}`}>
      <label htmlFor={id} className="le-d-label">{f.label}{changed && <i className="le-d-changed" title="Changed in this draft" />}</label>
      {input}
      {help && <div className="le-d-help">{help}</div>}
    </div>
  );
}

function EventPicker({ id, value, events, set }) {
  const [q, setQ] = useState('');
  const cur = events.find(e => e.id === value);
  const shown = q.trim() ? events.filter(e => e.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 100) : events.slice(0, 100);
  return (
    <div className="le-d-event">
      <div className="le-d-event-cur">{cur ? `${cur.name}${cur.year ? ` (${cur.year})` : ''}` : value ? 'Linked to an event that no longer exists' : 'Not linked'}
        {value && <button type="button" className="le-link" onClick={() => set(null)}>Unlink</button>}</div>
      <div className="le-d-event-pick">
        <input className="le-d-input" placeholder="Find an event…" value={q} onChange={e => setQ(e.target.value)} />
        <select id={id} className="le-d-input" value="" onChange={e => { if (e.target.value) { set(e.target.value); setQ(''); } }}>
          <option value="">{shown.length ? `Choose (${shown.length}${shown.length === 100 ? '+' : ''})…` : 'No matches'}</option>
          {shown.map(e => <option key={e.id} value={e.id}>{e.name}{e.year ? ` (${e.year})` : ''}{e.publisher ? ` · ${e.publisher}` : ''}</option>)}
        </select>
      </div>
    </div>
  );
}

function Creators({ value, roles, set }) {
  const upd = (i, patch) => set(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="le-d-list">
      {value.map((c, i) => (
        <div key={i} className="le-d-creator">
          <input className="le-d-input" value={c.person_name || ''} placeholder="Name" onChange={e => upd(i, { person_name: e.target.value })} />
          <select className="le-d-input" value={c.role || 'writer'} onChange={e => upd(i, { role: e.target.value })}>{roles.map(r => <option key={r} value={r}>{r}</option>)}</select>
          <button type="button" className="le-x" aria-label="Remove creator" onClick={() => set(value.filter((_, j) => j !== i))}>×</button>
        </div>))}
      <button type="button" className="le-link" onClick={() => set([...value, { person_name: '', role: 'writer' }])}>+ Add creator</button>
    </div>
  );
}

function Categories({ value, options, set }) {
  const on = k => value.find(c => c.category === k);
  return (
    <div className="le-d-list">
      {options.map(([k, label, notesLabel]) => {
        const c = on(k);
        return (
          <div key={k} className="le-d-cat">
            <label><input type="checkbox" checked={!!c} onChange={e => set(e.target.checked ? [...value, { category: k, adaptation_notes: '' }] : value.filter(x => x.category !== k))} /> {label}</label>
            {c && notesLabel && <input className="le-d-input" value={c.adaptation_notes || ''} placeholder={notesLabel}
              onChange={e => set(value.map(x => (x.category === k ? { ...x, adaptation_notes: e.target.value } : x)))} />}
          </div>);
      })}
    </div>
  );
}

export default function DetailsPanel({ fields, base, draft, onChange, events, summary, extra }) {
  const [open, setOpen] = useState(false);
  const diff = detailsDiff(base, draft);
  const groups = [];
  for (const f of fields) { let g = groups.find(x => x.name === (f.group || '')); if (!g) groups.push(g = { name: f.group || '', fields: [] }); g.fields.push(f); }
  return (
    <section className={`le-details${open ? ' open' : ''}`}>
      <button type="button" className="le-details-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="le-details-caret">{open ? '▾' : '▸'}</span>
        <span className="le-details-title">Details</span>
        <span className="le-details-sum">{summary}</span>
        {diff && <span className="le-tag">edited</span>}
      </button>
      {open && <div className="le-details-body">
        {groups.map(g => (
          <div key={g.name || 'main'} className="le-d-group">
            {g.name && <div className="le-d-group-name">{g.name}</div>}
            <div className="le-d-grid">
              {g.fields.map(f => <Field key={f.key} f={f} value={draft[f.key]} changed={!!(diff && f.key in diff)} events={events}
                set={v => onChange({ ...draft, [f.key]: v })} />)}
            </div>
          </div>))}
        {extra}
      </div>}
    </section>
  );
}

export const detailsCss = `
  .le-details { border: 1px solid var(--border-subtle); border-radius: 10px; margin: 2px 0 14px; background: var(--bg-surface, rgba(255,255,255,0.02)); }
  .le-details-head { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: 0; color: inherit; font: inherit; text-align: left; padding: 10px 14px; cursor: pointer; }
  .le-details-caret { color: var(--text-muted); font-size: 0.75rem; width: 12px; }
  .le-details-title { font-weight: 600; font-size: 0.85rem; color: var(--text-primary); }
  .le-details-sum { flex: 1; min-width: 0; color: var(--text-muted); font-size: 0.84rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .le-details-body { padding: 4px 16px 16px 36px; }
  .le-d-group + .le-d-group { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-subtle); }
  .le-d-group-name { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 8px; }
  .le-d-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
  .le-d-field.wide { grid-column: 1 / -1; }
  .le-d-label { display: flex; align-items: center; gap: 6px; font-size: 0.76rem; color: var(--text-secondary, var(--text-muted)); margin-bottom: 4px; }
  .le-d-changed { width: 6px; height: 6px; border-radius: 50%; background: var(--td-yellow, #f5c518); display: inline-block; }
  .le-d-input { box-sizing: border-box; width: 100%; background: var(--bg-base, transparent); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 9px; font: inherit; font-size: 0.88rem; }
  .le-d-input:focus { outline: none; border-color: var(--border-active, var(--td-yellow)); }
  textarea.le-d-input { resize: vertical; line-height: 1.45; }
  .le-d-help { color: var(--text-muted); font-size: 0.74rem; margin-top: 4px; }
  .le-d-list { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .le-d-creator { display: grid; grid-template-columns: minmax(0, 1fr) 130px 26px; gap: 6px; width: 100%; }
  .le-d-cat { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 8px; align-items: center; width: 100%; font-size: 0.86rem; }
  .le-d-cat label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .le-d-event-cur { display: flex; gap: 12px; align-items: center; font-size: 0.88rem; margin-bottom: 6px; }
  .le-d-cover img { width: 34px; height: 52px; object-fit: cover; border-radius: 3px; flex: none; }
  .le-d-muted { color: var(--text-muted); }
  .le-d-event-pick { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 6px; }
  .le-d-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer; padding: 6px 0; }
  .le-d-switch input { accent-color: var(--td-yellow, #f5c518); width: 16px; height: 16px; }
  .le-d-danger { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-subtle); display: flex; align-items: center; gap: 12px; font-size: 0.85rem; }
`;
