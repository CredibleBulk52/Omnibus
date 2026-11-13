import { PublisherLogo, CharacterSymbol, useBranding } from '../components/Branding';
import React, { useEffect, useState } from 'react';
import { Loading, ErrorNote } from '../components/StateMessage';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isAdmin, useLibrary, useAppSettings } from '../App';
import { useReadingTheme } from '../components/ReadingTheme';
import { rlApi, prefs, CoverFan, ProgressBars, VisibilityChip, ListSettingsModal, Modal, RichText } from '../components/ReadingListBits';
import { catalogSections, normalizePublisher, collectionBranding, essentialSections, collectionsFor, publishersFor, selectLists, isNew, featuredList } from './listCatalog';
import ShelfScroller from '../components/ShelfScroller';
import CatalogCollections from '../components/CatalogCollections';
import EssentialCollectionDialog from '../components/EssentialCollectionDialog';
import CuratedMast from '../components/CuratedMast';
import AdminBar from '../components/AdminBar';
import { ImportButton, StarterPackButton } from '../components/CuratedTransfer';
import PageHeader from '../components/PageHeader';
import { NewEntryButton, NewEntryDialog, AskForList } from '../components/NewEntry';
import '../listCatalog.css';

export default function ReadingListsPage() { return <Catalog />; }
export function EssentialsPage() { return <Catalog essentials />; }

function Catalog({ essentials = false }) {
  const { activeLibrary, libraries, setActiveLibrary } = useLibrary();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const chosenTab = params.get('tab') || prefs.get('tab', 'mine');
  const scope = essentials ? 'essential' : ['mine', 'following', 'public'].includes(chosenTab) ? chosenTab : 'mine';
  useEffect(() => { if (!essentials) prefs.set('tab', scope); }, [scope, essentials]);
  const [lists, setLists] = useState(null), [error, setError] = useState('');
  const [registry,setRegistry]=useState([]),[collectionEdit,setCollectionEdit]=useState(null);

  const query = params.get('q') || '', sort = params.get('sort') || 'alpha';
  const publisher = essentials ? params.get('publisher') || '' : '';
  const collection = essentials ? params.get('collection') || '' : '';
  const all = essentials && (params.get('view') === 'all' || !!query.trim() || !!publisher || !!collection);
  const update = (patch, replace = false) => { const next = new URLSearchParams(params); for (const [key,value] of Object.entries(patch)) value ? next.set(key,value) : next.delete(key); setParams(next,{replace}); };
  const setQuery = q => update({q}, true), setSort = sort => update({sort});
  const [creating, setCreating] = useState(null),   // New list dialog: null | 'generate' | 'manual'
     [editing, setEditing] = useState(null), [revision, refresh] = useState(0);
  useEffect(()=>{if(essentials)rlApi('GET','/api/essential-collections').then(d=>setRegistry(d.collections||[])).catch(e=>setError(e.message));},[essentials,revision]);
  useEffect(() => {
    let cancelled = false; setLists(null); setError('');
    rlApi('GET', `/api/reading-lists?scope=${scope}`).then(d => { if (!cancelled) setLists(d.lists || []); })
      .catch(e => { if (!cancelled) { setError(e.message); setLists([]); } });
    return () => { cancelled = true; };
  }, [scope, revision]);
  const available = selectLists(lists || [], { library: activeLibrary, libraries, query, sort });
  const publishers = [...new Set((lists || []).flatMap(l => publishersFor(l, libraries)))].sort();
  const collectionOptions = [...new Set((lists || []).flatMap(l => collectionsFor(l, libraries)))].sort();
  const filtered = available.filter(l => !publisher || publishersFor(l, libraries).includes(publisher));
  const curated = essentialSections(filtered, libraries, registry, isAdmin() && !all && !activeLibrary);
  const visible = collection ? curated.find(s => s.key === collection || s.record?.legacyKey === collection)?.items || [] : filtered;
  const sections = essentials ? all ? [{key:'results',kind:'results',name:'',items:visible}] : curated : catalogSections(visible, libraries);
  const featured = essentials && !all ? featuredList(visible) : null;
  const path = l => `${essentials ? '/essentials' : '/reading-lists'}/${l.id}`;
  // Admin titles on the section bars (settings.catalog_publisher_notes, readable by everyone),
  // one set per page: { essentials: { DC: '…', 'group:cosmic': '…', other: '…' }, lists: {…} }.
  const appSettings = useAppSettings();
  const brandingAssets = useBranding();
  const brandingOptions = [...new Set([...publishers, ...brandingAssets.filter(a => a.kind === "publisher").map(a => a.name || a.key), "DC", "Marvel"].map(normalizePublisher))].sort();
  const [notes, setNotes] = useState(null);
  const allNotes = notes || (() => { try { return JSON.parse(appSettings.catalog_publisher_notes || '{}') || {}; } catch { return {}; } })();
  const pageKey = essentials ? 'essentials' : 'lists';
  const pageNotes = allNotes[pageKey] || {};
  const sectionStyles = allNotes[`${pageKey}_styles`] || {};
  const saveNote = async (key, text, appearance) => {
    const next = { ...allNotes, [pageKey]: { ...pageNotes, [key]: text.trim() || undefined }, ...(appearance ? {[`${pageKey}_styles`]:{...sectionStyles,[key]:appearance}} : {}) };
    await rlApi('POST', '/api/settings', { catalog_publisher_notes: JSON.stringify(next) });
    setNotes(next);
  };
  const moveCollection=async(id,direction)=>{const ids=registry.map(c=>c.id),i=ids.indexOf(id),j=i+direction;if(j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];try{const d=await rlApi('POST','/api/essential-collections/order',{ids});setRegistry(d.collections);}catch(e){setError(e.message);}};
  return <div className="rl-page">
    <PageHeader title={essentials ? 'The Omnibus Journey' : 'Your paths through the long box'} borderSeed={essentials ? 2 : 3} />
    <div className="lc-page curated-page">
    {essentials
      ? <CuratedMast className="cm-mast--inset" title="Big legends." titleEm="Start here."
          label="Essentials" intro="Secret origins. Legendary runs. Hand-picked journeys through the stories that make a hero."
          stamp={['Every hero', 'starts', 'somewhere.']} />
      : <CuratedMast className="cm-mast--inset" title="Your comics." titleEm="Your journey."
          label="Reading Lists" intro="Build your next adventure, follow a great reading order, or pick up where you left off."
          stamp={['Your long box.', 'Your Journey.', 'Your Rules.']} />}
    {essentials
      ? isAdmin() && <AdminBar><NewEntryButton label="New Essential" onClick={() => setCreating('generate')} /><NewEntryButton label="New collection" onClick={() => setCollectionEdit({name:"",appearance:{publisher:""}})} /><ImportButton /><StarterPackButton kind="lists" /></AdminBar>
      : <AdminBar label="My lists"><NewEntryButton label="New list" onClick={() => setCreating('generate')} /></AdminBar>}
    {!essentials && <div className="rl-tabs" role="tablist" aria-label="Reading lists">{[['mine','My Lists'],['following','Following'],['public','Public']].map(([key,label]) => <button key={key} className={`rl-tab ${scope === key ? 'rl-tab--active' : ''}`} role="tab" aria-selected={scope === key} onClick={() => setParams({ tab: key })}>{label}</button>)}</div>}
    <div className="lc-toolbar find-bar">
      {essentials && <div className="lc-view-switch" aria-label="Essentials view"><button className={!all ? 'active' : ''} onClick={() => update({view:null,collection:null,q:null,publisher:null})}>Collections</button><button className={all && !collection ? 'active' : ''} onClick={() => update({view:'all',collection:null})}>All Essentials</button></div>}
      {essentials && <label className="lc-sort"><span className="lc-sr">Publisher</span><select aria-label="Publisher" value={publisher} onChange={e => update({publisher:e.target.value})}><option value="">All publishers</option>{publishers.map(p => <option key={p}>{p}</option>)}</select></label>}
      <label className="lc-search"><span className="lc-sr">Search reading lists</span><input type="search" className="find-box" placeholder="Find a character, team or list…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="lc-sort"><span>Sort</span><select value={sort} onChange={e => setSort(e.target.value)}><option value="alpha">A–Z</option><option value="recent">Recently added</option><option value="progress">In progress first</option></select></label>
    </div>
    {error ? <ErrorNote title="Couldn't load lists." onRetry={() => refresh(n => n + 1)}>{error}</ErrorNote> : lists === null ? <Loading label="Loading lists…" /> : <>
      {featured && <Featured list={featured} to={path(featured)} />}
      <div className="lc-result-count" role="status">{visible.length} {visible.length === 1 ? 'reading journey' : 'reading journeys'}{activeLibrary ? ` in ${activeLibrary.name}` : ''}</div>
      {essentials && all && <div className="lc-results-heading"><h2>{collection ? pageNotes[collection] || curated.find(s => s.key === collection || s.record?.legacyKey === collection)?.name || 'More journeys' : 'All Essentials'}</h2><button className="btn btn-secondary" onClick={() => update({view:null,collection:null,q:null,publisher:null})}>Back to shelves</button></div>}
      {sections.map(({ key, kind, name, items, record }) => {
        const title = record ? record.name : pageNotes[key] || '', fallback = kind === 'group' ? name : kind === 'other' ? (essentials || sections.length > 1 ? 'More journeys' : '') : '';
        const appearance = record ? (Object.keys(record.appearance||{}).length ? record.appearance : sectionStyles[record.legacyKey] || {}) : sectionStyles[key];
        const brand = collectionBranding(name, kind, brandingOptions, appearance);
        const header = (controls, overflow = false) => kind !== 'results' && (title || fallback || kind !== 'other' || isAdmin()) && <header className={`lc-publisher-head lc-publisher-head--${kind}`} data-publisher={brand.publisher || undefined} style={brand.style}>
          {brand.character && <div className="lc-section-brand"><CharacterSymbol title={brand.character} /></div>}
          {brand.publisher && <div className="lc-section-brand"><PublisherLogo name={brand.publisher} size="heading" /></div>}
          {record ? <div className="lc-publisher-note"><h2 className="lc-section-title">{record.name}</h2>{isAdmin()&&<><button className="lc-edit-collection" title="Edit collection name, branding and reading orders" onClick={()=>setCollectionEdit({...record,appearance:{...appearance,publisher:appearance?.publisher ?? brand.publisher ?? ""},items:essentialSections(lists||[],libraries,registry,true).find(c=>c.key===key)?.items||items})}>Edit collection</button><button className="lc-order-btn" aria-label={`Move ${name} up`} disabled={registry[0]?.id===key} onClick={()=>moveCollection(key,-1)}>↑</button><button className="lc-order-btn" aria-label={`Move ${name} down`} disabled={registry.at(-1)?.id===key} onClick={()=>moveCollection(key,1)}>↓</button></>}</div> : <SectionTitle text={title} fallback={fallback} heading={kind !== 'publisher'} canEdit={isAdmin()} appearance={essentials ? sectionStyles[key] || {} : undefined} publisherOptions={brandingOptions} automaticPublisher={collectionBranding(name, kind, brandingOptions).publisher} onSave={(text, appearance) => saveNote(key, text, appearance)} />}
          <span className="lc-section-count">{items.length} {items.length === 1 ? 'list' : 'lists'}</span>{essentials && !all && overflow && <button className="lc-view-all btn btn-secondary" onClick={() => { update({view:'all',collection:key}); document.querySelector('.lc-toolbar')?.scrollIntoView({block:'start'}); }}>View all →</button>}{controls}</header>;
        const cards = items.map(list => <div className="lc-card-wrap" key={list.id}><Card list={list} to={path(list)} featured={featured?.id === list.id} essentialCatalog={essentials} />{!essentials && (list.is_owner || (isAdmin() && list.visibility !== 'private')) && <button className="lc-organize" onClick={() => setEditing(list)} aria-label={`Organize ${list.name}`} title="Collections, publisher, libraries and spotlight">Organize</button>}</div>);
        return <section className="lc-publisher" key={key} aria-label={title || fallback || name || 'Reading lists'}>
          {essentials && !all ? <ShelfScroller label={title || fallback || name || 'More journeys'} id={`collection-${encodeURIComponent(key)}`} count={items.length} className="lc-scroller" railClassName="lc-curated-row" cardSelector=".lc-card-wrap" hideWhenFits renderHeader={header}>{cards}</ShelfScroller> : <>{header(null)}<div className="rl-grid">{cards}</div></>}
      </section>; })}
      {!visible.length && <div className="rl-empty"><div className="rl-empty-title">{query ? 'No matching lists' : 'No reading lists here yet'}</div><p>{query ? 'Try another character, team or title.' : activeLibrary ? `No lists are associated with ${activeLibrary.name} yet.` : 'Your next reading journey starts here.'}</p>{query && <button className="btn btn-secondary" onClick={() => setQuery('')}>Clear search</button>}{activeLibrary && <button className="btn btn-secondary" onClick={() => setActiveLibrary(null)}>View all libraries</button>}</div>}
    </>}
    {collectionEdit && <EssentialCollectionDialog record={collectionEdit} publishers={brandingOptions} items={collectionEdit.items||[]} availableItems={lists||[]} onClose={()=>setCollectionEdit(null)} onSaved={records=>{setRegistry(records);setCollectionEdit(null);refresh(n=>n+1);}} />}
    {editing && <Organize list={editing} libraries={libraries} collectionOptions={collectionOptions} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(n => n + 1); }} />}
    {creating && <NewEntryDialog title={essentials ? 'New Essential' : 'New reading list'} tab={creating} onTab={setCreating} onClose={() => setCreating(null)} width={620}>
      {tab => tab === 'generate'
        ? <AskForList essential={essentials} onSent={() => setCreating(null)} />
        : <ListSettingsModal embedded list={null} defaultVisibility={essentials ? 'essential' : 'private'} onClose={() => setCreating(null)} onSaved={id => { setCreating(null); navigate(`/reading-lists/${id}`); }} />}
    </NewEntryDialog>}
    </div>
  </div>;
}

// A section bar's custom title, in the comic display face. Admins edit it in place.
// Publisher bars show it beside the logo; group and "other" bars use it as their heading
// (falling back to the group name). Shared by the Reading Lists and Essentials pages.
function SectionTitle({ text, fallback, heading, canEdit, onSave, appearance, publisherOptions = [], automaticPublisher }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  const [look, setLook] = useState(appearance || {});
  const save = async () => { setBusy(true); setError(''); try { await onSave(draft, appearance !== undefined ? look : undefined); setEditing(false); } catch (e) { setError(e.message); } setBusy(false); };
  if (editing) return <div className="lc-publisher-note lc-publisher-note--edit">
    <input className="lc-publisher-input" autoFocus maxLength={120} value={draft} placeholder={fallback || 'Section title…'} aria-label="Section title"
      onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setDraft(text); } }} />
    {appearance !== undefined && <div className="lc-section-appearance">
      <label>Publisher logo<select value={look.publisher ?? '__auto'} onChange={e => {const next={...look}; if(e.target.value === '__auto') delete next.publisher; else next.publisher=e.target.value; setLook(next);}}><option value="__auto">Automatic{automaticPublisher ? ` (${automaticPublisher})` : ''}</option><option value="">None</option>{publisherOptions.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Bar color<input aria-label="Bar color" type="color" value={look.fill || ((look.publisher ?? automaticPublisher) === 'DC' ? '#173e64' : (look.publisher ?? automaticPublisher) === 'Marvel' ? '#612525' : '#252530')} onChange={e => setLook({...look,fill:e.target.value})} /></label>
      <label>Accent color<input aria-label="Accent color" type="color" value={look.accent || ((look.publisher ?? automaticPublisher) === 'DC' ? '#75bdff' : (look.publisher ?? automaticPublisher) === 'Marvel' ? '#ff938a' : '#f5c518')} onChange={e => setLook({...look,accent:e.target.value})} /></label>
      <button type="button" className="lc-publisher-btn lc-publisher-btn--ghost" onClick={() => setLook({})}>Reset appearance</button>
    </div>}
    <button type="button" className="lc-publisher-btn" disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</button>
    <button type="button" className="lc-publisher-btn lc-publisher-btn--ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(text); }}>Cancel</button>
    {error && <small className="lc-publisher-error" role="alert">{error}</small>}
  </div>;
  const shown = text || fallback, Tag = heading ? 'h2' : 'p';
  if (!shown && !canEdit) return null;
  return <div className="lc-publisher-note">
    {shown && <Tag className="lc-section-title">{shown}</Tag>}
    {canEdit && <button type="button" className="lc-publisher-btn lc-publisher-btn--ghost" onClick={() => {setLook(appearance || {});setEditing(true);}} title="Edit this section header">✎ {appearance !== undefined ? 'Edit header' : text ? 'Edit title' : 'Add title'}</button>}
  </div>;
}

function Featured({ list, to }) {
  const theme = useReadingTheme(list, list.progress?.cover_book_ids?.[0]);
  return <section className="lc-feature rl-themed" style={theme.style} aria-label="Featured reading journey">
    <div className="lc-feature-art"><CoverFan bookIds={list.progress?.cover_book_ids} emptyText="Your next great read" /><div className="rl-burst">Featured</div></div>
    <div className="lc-feature-copy"><span className="lc-kicker">The Essential Spotlight</span><h2>{list.name}</h2>{list.description && <div className="lc-feature-description"><RichText text={list.description} /></div>}<ProgressBars progress={list.progress} compact /><Link className="btn btn-primary" to={to}>Explore reading order <span aria-hidden="true">→</span></Link></div>
  </section>;
}
function Card({ list, to, featured, essentialCatalog }) {
  const p = list.progress || {}, theme = useReadingTheme(list, p.cover_book_ids?.[0]);
  const badge = featured ? 'Featured' : isNew(list) ? 'New!' : p.total > 0 && p.read === p.total ? 'Done!' : null;
  return <Link to={to} className="rl-card rl-themed" style={theme.style}>
    <div className={`rl-art rl-art--${list.visibility}`}>
      {essentialCatalog && theme.identityApplied && <CharacterSymbol title={list.name} printed />}
      <CoverFan bookIds={p.cover_book_ids} emptyText="No covers yet" />
      {badge && <div className="rl-burst">{badge}</div>}
    </div>
    <div className="rl-caption"><div className="rl-caption-title">{list.name}</div>{!list.is_owner && list.owner_name && <div className="rl-caption-by">by {list.owner_name}</div>}</div>
    <div className="rl-card-meta"><div className="rl-chip-row" hidden={essentialCatalog && !list.following}>{!essentialCatalog && <VisibilityChip visibility={list.visibility} />}{list.following && <span className="rl-chip rl-chip--following">Following</span>}</div>{list.description && <div className="rl-card-desc"><RichText text={list.description} /></div>}<div style={{marginTop:'auto'}}><ProgressBars progress={p} compact /></div></div>
  </Link>;
}
function Organize({ list, libraries, collectionOptions, onClose, onSaved }) {
  const saved = list.catalog?.explicit || {};
  const [collections, setCollections] = useState(collectionsFor(list, libraries));
  const [publishers, setPublishers] = useState((saved.publishers || []).join(', '));
  const [ids, setIds] = useState(saved.library_ids || []), [featured, setFeatured] = useState(saved.featured === true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() { setBusy(true); setError(''); try { await rlApi('PATCH', `/api/reading-lists/${list.id}`, { catalog: { ...saved, ...(list.visibility === 'essential' ? {collections} : {}), publishers: publishers.split(',').map(s => s.trim()).filter(Boolean), library_ids: ids, featured } }); onSaved(); } catch(e) { setError(e.message); setBusy(false); } }
  return <Modal title="Organize reading list" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button></>}><div className="rl-modal-body">
    {list.visibility === 'essential' && <div className="rl-field"><label className="rl-label" htmlFor="organize-collections">Collections</label><CatalogCollections id="organize-collections" value={collections} options={collectionOptions} onChange={setCollections} /></div>}
    <label className="rl-field"><span className="rl-label">Publishers</span><input className="rl-input" value={publishers} onChange={e => setPublishers(e.target.value)} placeholder="Automatic, or e.g. DC, Marvel" /><small>Separate multiple publishers with commas. Leave blank to use linked comic metadata.</small></label>
    <fieldset className="lc-library-options"><legend>Libraries</legend>{libraries.map(l => <label key={l.id}><input type="checkbox" checked={ids.includes(String(l.id))} onChange={e => setIds(e.target.checked ? [...ids, String(l.id)] : ids.filter(id => id !== String(l.id)))} />{l.name}</label>)}<small>Leave unchecked for automatic associations. Choose libraries to keep the list here even when its comics are missing.</small></fieldset>
    {isAdmin() && list.visibility === 'essential' && <label className="rl-field"><span><input type="checkbox" checked={featured} onChange={e => setFeatured(e.target.checked)} /> Include in Essential Spotlight</span><small>One eligible featured list is shown each day, respecting the selected library. Without a selection, the spotlight rotates through available Essentials.</small></label>}
    {error && <div className="rl-error" role="alert">{error}</div>}
  </div></Modal>;
}
