import MembershipPicker from '../components/MembershipPicker';
import useBoxArtwork from '../components/useBoxArtwork';
import { useConfirm } from '../components/Confirm';
import React, { useState, useEffect, useCallback } from 'react';
import { Loading, Empty, ErrorNote } from '../components/StateMessage';
import BackLink from '../components/BackLink';
// Back returns to the boxes page it came from (The Comic Box or My Comic Boxes).
const BOX_PAGES = /^\/(collections|my-boxes)$/;
import { useParams, useNavigate } from 'react-router-dom';
import { useSeriesCache, useLibrary, isAdmin, getUser, useAppSettings } from '../App';
import BoxMissingSeries from '../components/BoxMissingSeries';
import ShelfView from '../components/ComicSeriesShelfView';
import SeriesSelectControls from '../components/SeriesSelectControls';
import { useViewState } from '../hooks/useViewState';
import ConditionGroup, { testSeriesAgainstGroup } from '../components/ConditionBuilder';
import PageHeader from '../components/PageHeader';
import ComicCollectionHero, { CollectionManageMenu } from '../components/ComicCollectionHero';
import { collectionPresentation, editableCollectionRules } from './collectionPresentation.mjs';
import '../comicCollectionDetail.css';

export default function CollectionDetail() {
  const confirm = useConfirm();
  const { id } = useParams();
  const navigate = useNavigate();
  const { fetchSeries } = useSeriesCache();
  const { libraries } = useLibrary();
  const appSettings = useAppSettings();
  const [collection, setCollection] = useState(null);
  const [allSeries, setAllSeries] = useState([]);
  const [matchedSeries, setMatchedSeries] = useState([]);
  const [showGrouped, setShowGrouped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useViewState(`collection:${id}:page`, 0);
  const [search, setSearch] = useViewState(`collection:${id}:search`, '');
  const [editing, setEditing] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [coverVersion, setCoverVersion] = useState(0);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [selectable, setSelectable] = useState(false);
  const [selected, setSelected] = useState([]);

  const load = useCallback(async () => {
    setLoading(true); setCollection(null); setActionError('');
    try {
      const [col, series] = await Promise.all([
        fetch(`/api/collections/${id}`).then(async r => { const data=await r.json(); if(!r.ok) throw new Error(data.error || 'Could not load this box.'); return data; }),
        fetchSeries(null), // uses cache — instant on second visit
      ]);
      setCollection(col);
      setEditForm({ name: col.name, description: col.description || '', cardDescription:col.card_description || '', era: col.era || '', collectionType: col.collectionType || col.collection_type || 'manual', conditionGroup: col.conditionGroup || null, rules: col.rules || [], sortOrder: col.sort_order ?? 0, libraryId: col.library_id || '' });
      setAllSeries(series);

      // Filter series based on collection type
      if (col.collectionType === 'manual' || col.collection_type === 'manual') {
        // Manual: use explicitly added series IDs
        const manualIds = new Set((col.manualSeries || []).map(s => s.seriesId || s));
        const manual = series.filter(s => manualIds.has(s.id));
        setMatchedSeries(manual);
      } else if (col.conditionGroup) {
        // Smart collection with condition group
        try {
          const group = JSON.parse(col.conditionGroup);
          console.log('[collection] conditionGroup:', group);
          // Sample first 3 series to verify enrich fields are present
          if (series.length > 0) {
            const s0 = series[0];
            console.log('[collection] sample series fields:', {
              id: s0.id,
              displayTitle: s0.displayTitle,
              displayCharacters: s0.displayCharacters,
              displayGenres: s0.displayGenres,
              displayEra: s0.displayEra,
              displayStatus: s0.displayStatus,
              hasSeriesJson: !!s0.seriesJson,
              seriesJsonChars: s0.seriesJson?.characters,
            });
          }
          const matched = series.filter(s => testSeriesAgainstGroup(s, group));
          console.log('[collection] matched', matched.length, 'of', series.length, 'series');
          setMatchedSeries(matched);
        } catch (e) {
          console.error('[collection] conditionGroup parse error:', e);
          // Fallback to flat rules
          setMatchedSeries(applyFlatRules(series, col.rules || []));
        }
      } else if (col.rules?.length > 0) {
        setMatchedSeries(applyFlatRules(series, col.rules));
      } else {
        // Empty collection
        setMatchedSeries([]);
      }
    } catch (e) {
      setActionError(e.message || 'Could not load this box.');
    }
    setLoading(false);
  }, [id, fetchSeries]);

  useEffect(() => { load(); }, [load]);

  // applyFlatRules mirrors testSeriesAgainstRule — used as fallback when conditionGroup parse fails
  const applyFlatRules = (seriesList, rules) => {
    if (!rules || rules.length === 0) return [];
    const normaliseStatus = v => v === 'ongoing' ? 'continuing' : v;
    return seriesList.filter(s => {
      return rules.every(rule => {
        // Support both flat rule shapes: {rule_type, rule_value} and {type, operator, value}
        const type     = rule.type || rule.rule_type || '';
        const operator = rule.operator || 'contains';
        const value    = rule.value || rule.rule_value || '';
        const value2   = rule.value2 || '';
        if (!value && operator !== 'between') return true;
        const val  = normaliseStatus(value.toLowerCase().trim());
        const val2 = value2.toLowerCase().trim();

        const m    = s.seriesJson || {};
        const meta = s.metadata  || {};

        let fieldVals;
        switch (type) {
          case 'era':       fieldVals = [s.displayEra || m.era || '']; break;
          case 'publisher': fieldVals = [s.displayPublisher || m.publisher || meta.publisher || '']; break;
          case 'genre':     fieldVals = s.displayGenres || m.genres || meta.genres || []; break;
          case 'character': fieldVals = s.displayCharacters || m.characters || []; break;
          case 'status':    fieldVals = [normaliseStatus((s.displayStatus || m.status || '').toLowerCase())]; break;
          case 'year':      fieldVals = [String(s.displayYear || m.year || '')]; break;
          case 'title':     fieldVals = [(s.displayTitle || m.name || meta.title || '').replace(/\s*\(\d{4}\)\s*$/, '')]; break;
          default:          return true;
        }

        const lower = fieldVals.map(v => String(v).toLowerCase());
        switch (operator) {
          case 'is':           return lower.some(fv => fv === val);
          case 'contains':     return lower.some(fv => fv.includes(val));
          case 'starts_with':  return lower.some(fv => fv.startsWith(val));
          case 'greater_than': return lower.some(fv => parseFloat(fv) > parseFloat(val));
          case 'less_than':    return lower.some(fv => parseFloat(fv) < parseFloat(val));
          case 'between':      return lower.some(fv => { const n = parseFloat(fv); return n >= parseFloat(val) && n <= parseFloat(val2); });
          default:             return lower.some(fv => fv.includes(val));
        }
      });
    });
  };

  const save = async () => {
    if (!editForm.name?.trim()) { setActionError('Enter a box name.'); return; }
    setSaving(true); setActionError('');
    try {
      const response = await fetch(`/api/collections/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editForm, publisher: collection.publisher, cover_series_id: collection.cover_series_id, rules: (editForm.rules || []).map(r => ({ ...r, type: r.type ?? r.rule_type, value: r.value ?? r.rule_value })) }),
      });
      if (!response.ok) throw new Error('Could not save this box. Your edits have been kept.');
      setEditing(false); await load();
    } catch (error) { setActionError(error.message); }
    finally { setSaving(false); }
  };

  // Sharing (stage 2, claude/BOXES_UNIFIED_PLAN.md): the owner shares or stops sharing;
  // another user follows a shared box or copies it into their own boxes.
  const post = async (url, method = 'POST', body) => {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Could not update the box.');
    return d;
  };
  const toggleShare = async () => {
    const on = !collection.shared;
    if (!on && !(await confirm({ title: 'Stop sharing this box?', message: 'Other readers will no longer see it, and it leaves the boxes of anyone following it.', confirmLabel: 'Stop sharing' }))) return;
    setActionError('');
    try { const d = await post(`/api/collections/${id}/share`, 'POST', { shared: on }); setCollection(prev => ({ ...prev, visibility: d.visibility, shared: d.shared })); }
    catch (e) { setActionError(e.message); }
  };
  const toggleFollow = async () => {
    setActionError('');
    try { const d = await post(`/api/collections/${id}/follow`, collection.following ? 'DELETE' : 'POST'); setCollection(prev => ({ ...prev, following: d.following })); }
    catch (e) { setActionError(e.message); }
  };
  const copyBox = async () => {
    setActionError('');
    try { const d = await post(`/api/collections/${id}/copy`); navigate(`/collections/${d.id}`); }
    catch (e) { setActionError(e.message); }
  };

  const remove = async () => {
    if (!(await confirm({ title: 'Delete this box?', message: `Delete "${collection.name}"? The series in it stay in your library.`, confirmLabel: 'Delete box', danger: true }))) return;
    setActionError('');
    try {
      const response = await fetch(`/api/collections/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete this box. Please try again.');
      navigate('/collections');
    } catch (error) { setActionError(error.message); }
  };

  const uploadCover = async file => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      setActionError('Choose a PNG or JPEG image smaller than 10 MB.'); return;
    }
    setUploading(true); setActionError('');
    try {
      const response = await fetch(`/api/collections/${id}/cover`, { method:'POST', headers:{'Content-Type':file.type}, body:file });
      if (!response.ok) throw new Error('Could not upload the artwork. Please try again.');
      setCoverVersion(Date.now()); await load();
    } catch (error) { setActionError(error.message); }
    finally { setUploading(false); }
  };

  const beginEdit = (rules = false) => {
    setActionError(''); setEditingRules(rules);
    const fresh = { memberIds:(collection.manualSeries||[]).map(s=>String(s.seriesId||s)), name:collection.name, description:collection.description || '', cardDescription:collection.card_description || '', era:collection.era || '', publisher:collection.publisher, cover_series_id:collection.cover_series_id, collectionType:collection.collectionType || collection.collection_type || 'manual', conditionGroup:collection.conditionGroup || null, rules:collection.rules || [], sortOrder:collection.sort_order ?? 0, libraryId:collection.library_id || '' };
    if (rules) {
      try { fresh.conditionGroup = JSON.stringify(editableCollectionRules(collection)); }
      catch { setActionError('The saved matching rules could not be read. They have not been changed.'); return; }
    }
    setEditForm(fresh); setEditing(true);
  };

  const removeSeries = async (seriesId) => {
    setActionError('');
    const r = await fetch(`/api/collections/${id}/series/${encodeURIComponent(seriesId)}`, { method: 'DELETE' });
    if (!r.ok) { setActionError('Could not remove the series from this box.'); return; }
    setMatchedSeries(prev => prev.filter(s => s.id !== seriesId));
  };

  const coverUrl = useBoxArtwork(collection?.cover_image
    ? `/api/collections/${id}/cover?v=${encodeURIComponent(coverVersion || collection.cover_image)}`
    : collection?.purpose === 'pull' ? '/pull-box-art.png' : null);

  if (loading) return <Loading label="Loading comic box…" />;
  if (!collection && actionError) return <ErrorNote>{actionError}</ErrorNote>;
  if (!collection) return (
    <Empty title="Comic box not found" action={<BackLink to="/collections" label="Comic Boxes" match={BOX_PAGES} />}>It may have been deleted.</Empty>
  );

  const isManual = collection.collectionType === 'manual' || collection.collection_type === 'manual';
  // Smart boxes leave out series shelved under a home (tie-ins); manual boxes show what was added (2026-11-13).
  const groupedOut = isManual ? 0 : matchedSeries.filter(s => s.group?.hidden).length;
  const boxSeries = isManual || showGrouped || search.trim() ? matchedSeries : matchedSeries.filter(s => !s.group?.hidden);
  const userId = getUser()?.id;
  const canEdit = collection.owner_id ? collection.owner_id === userId : isAdmin();
  const othersBox = !!collection.owner_id && collection.owner_id !== userId;   // a shared box of another user
  const shownTitle = othersBox && collection.owner_name ? `${collection.owner_name}'s ${collectionPresentation(collection).title}` : collectionPresentation(collection).title;


  return (
    <div className="page-bg comic-collection-detail" style={{ padding: 0 }}>
      {actionError && <div role="alert" className="collection-action-error">{actionError}</div>}
      <PageHeader title={<>{shownTitle}{collectionPresentation(collection).dates && <span className="ccd-dates">{collectionPresentation(collection).dates}</span>}</>} borderSeed={2}>
      </PageHeader>

      {editing && canEdit ? (
        <div className="ccd-editor">
          <div className="form-group">
            <label className="form-label">Name</label>
            <input className="form-input" value={editForm.name}
              onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea className="form-textarea" value={editForm.description}
              onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))} />
          </div>
          <div className="form-group"><label className="form-label">Card description ({[...(editForm.cardDescription||'')].length}/140)</label><textarea className="form-textarea" maxLength={140} value={editForm.cardDescription||''} onChange={e=>setEditForm(p=>({...p,cardDescription:e.target.value}))} placeholder="Optional short introduction; otherwise the full description is previewed." /></div>
          <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
            <div className="form-group" style={{ maxWidth:120 }}>
              <label className="form-label">Display Order</label>
              <input className="form-input" type="number" min="0" step="1"
                value={editForm.sortOrder ?? 0}
                onChange={e => setEditForm(p => ({ ...p, sortOrder: e.target.value }))}
                style={{ textAlign:'center' }} />
              <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:3 }}>Lower = appears first</div>
            </div>
            <div className="form-group" style={{ flex:1, minWidth:200 }}>
              <label className="form-label">Library</label>
              <select disabled={collection.purpose==='pull'} className="form-input" value={editForm.libraryId || ''}
                onChange={e => setEditForm(p => ({ ...p, libraryId: e.target.value }))}>
                <option value="">All Libraries</option>
                {libraries.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div style={{ fontSize:'0.72rem', color:'var(--text-muted)', marginTop:3 }}>Only show in this library (or all if unset)</div>
            </div>
          </div>
          {isManual && collection.purpose!=='pull' && <MembershipPicker label="Series in this box" items={allSeries} selected={editForm.memberIds||[]} onChange={memberIds=>setEditForm(p=>({...p,memberIds}))}/> }
          {editingRules && <section className="ccd-rule-editor"><h3>Matching rules</h3><ConditionGroup group={JSON.parse(editForm.conditionGroup)} onChange={group => setEditForm(p => ({ ...p, conditionGroup:JSON.stringify(group) }))} depth={0} /></section>}
          <div style={{ display:'flex', gap:8, marginTop:4 }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost" disabled={saving} onClick={() => { setEditing(false); setActionError(''); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <ComicCollectionHero collection={collection} count={matchedSeries.length} isManual={isManual}
          coverUrl={coverUrl} back={<BackLink to="/collections" label="Comic Boxes" match={BOX_PAGES} />}
          manage={canEdit ? <CollectionManageMenu isManual={isManual} uploading={uploading}
            personal={!!collection.owner_id} shared={!!collection.shared} onShare={toggleShare}
            onEdit={() => beginEdit(false)} onEditRules={() => beginEdit(true)} onDelete={remove} onUpload={uploadCover} />
            : othersBox ? <div className="ccd-share-actions">
              <button type="button" className="btn btn-secondary" onClick={toggleFollow}>{collection.following ? '★ Following' : '☆ Follow'}</button>
              <button type="button" className="btn btn-ghost" onClick={copyBox}>⧉ Copy to my boxes</button>
            </div> : null} />
      )}

      {/* Series shelf */}
      <ShelfView
        series={boxSeries}
        loading={loading}
        page={page}
        onPageChange={p => { setPage(p); window.scrollTo(0,0); }}
        searchValue={search}
        onSearchChange={setSearch}
        pageSize={60}
        viewKey={`collection:${id}`}
        showSearch={true}
        compactControls={true}
        selectable={selectable}
        selected={selected}
        onSelectionChange={setSelected}
        extraControls={<>
          <SeriesSelectControls selectable={selectable} setSelectable={setSelectable} selected={selected} setSelected={setSelected} />
          {groupedOut > 0 && <button type="button" className="btn btn-ghost" onClick={() => setShowGrouped(v => !v)}
            title="Tie-ins shelved under their home series' Specials tab">{showGrouped ? 'Hide grouped tie-ins' : `Show ${groupedOut} grouped tie-in${groupedOut === 1 ? '' : 's'}`}</button>}
        </>}
        seriesMenu={canEdit && isManual ? { onRemove: s => removeSeries(s.id) } : {}}
      />
      {/* Recommended series the library lacks: placeholders with Add / Request (2026-11-04). */}
      <BoxMissingSeries boxId={id} boxName={shownTitle} canEdit={canEdit} onArrived={load}
        canDownload={isAdmin() || appSettings?.download_manager_admin_only !== 'true'} />
    </div>
  );
}

