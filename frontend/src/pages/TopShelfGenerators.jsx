// Top Shelf's "Generate runs" and "+ Add run" dialogs. Moved out of the retired Canon
// Admin page on 2026-10-26; opened from components/TopShelfAdmin.jsx.
import { useState } from 'react';
import Modal from '../components/Modal';
import { AiInfo } from '../components/AiInfo';

const CATEGORIES = [
  { key: 'adapted_to_screen',   label: 'Adapted to Screen' },
  { key: 'award_winning',       label: 'Award Winning' },
  { key: 'critically_acclaimed', label: 'Critically Acclaimed' },
];

const SCOPE_TYPES = [
  { key: 'character',  label: 'Character' },
  { key: 'publisher',  label: 'Publisher' },
  { key: 'imprint',    label: 'Imprint' },
];

const REFINE_TYPES = [
  { key: 'era',        label: 'Era' },
  { key: 'creator',    label: 'Creator' },
  { key: 'story_type', label: 'Story Type' },
  { key: 'series',     label: 'Series' },
];

const ERA_OPTIONS = [
  'Golden Age', 'Silver Age', 'Bronze Age', 'Modern Age', 'Contemporary',
];

const STORY_TYPE_OPTIONS = [
  'Elseworlds', 'Graphic Novels', 'Limited Series', 'Annuals', 'Team-Up',
];

const ROLES = ['writer', 'penciler', 'inker', 'artist', 'colorist', 'letterer'];

// ─── Generate Modal ───────────────────────────────────────────────
// Exported so Top Shelf's "Generate runs" can open it unchanged (2026-10-17).
export function GenerateModal({ onClose, onImported, embedded = false }) {
  const [scopeType,        setScopeType]        = useState('character');
  const [scopeValue,       setScopeValue]        = useState('');
  const [refineType,       setRefineType]        = useState('');
  const [refineValue,      setRefineValue]       = useState('');
  // Each category: '' (doesn't matter) → 'must' (✓) → 'not' (✕). User 2026-10-18.
  const [catMode,          setCatMode]           = useState({ critically_acclaimed: 'must' });
  const [generating,       setGenerating]        = useState(false);
  const [importing,        setImporting]         = useState(false);
  const [results,          setResults]           = useState(null);
  const [selected,         setSelected]          = useState(new Set());
  const [eventOverrides,   setEventOverrides]    = useState({});
  const [error,            setError]             = useState('');
  const [usage,            setUsage]             = useState(null);
  const [dropped,          setDropped]           = useState([]);

  const cycleCategory = (key) => setCatMode(m => ({ ...m, [key]: { '': 'must', must: 'not', not: '' }[m[key] || ''] }));
  const mustCats = CATEGORIES.map(c => c.key).filter(k => catMode[k] === 'must');
  const notCats  = CATEGORIES.map(c => c.key).filter(k => catMode[k] === 'not');
  // ✓ chips decide what qualifies (2+ ✓ = all of them); with none, any category not ✕ qualifies.
  const categories = mustCats.length ? mustCats : CATEGORIES.map(c => c.key).filter(k => !notCats.includes(k));
  const catMatch = mustCats.length > 1 ? 'all' : 'any';
  const lbl = k => CATEGORIES.find(c => c.key === k)?.label.toLowerCase();
  const orList = ks => ks.map(lbl).join(' or ');
  const catSummary = !categories.length ? 'Leave at least one category unexcluded.'
    : `Finds runs that are ${catMatch === 'all' ? mustCats.map(lbl).join(' and ') : orList(categories)}${notCats.length ? `, but not ${orList(notCats)}` : ''}.`;

  const clearRefinement = () => { setRefineType(''); setRefineValue(''); };

  const generate = async () => {
    if (!scopeValue.trim()) { setError('Enter a scope value first'); return; }
    if (!categories.length) { setError('At least one category must not be excluded'); return; }
    if (refineType && !refineValue.trim()) { setError('Enter a refinement value or clear the refinement'); return; }
    setGenerating(true); setError(''); setResults(null); setEventOverrides({});
    try {
      const r = await fetch('/api/canon/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope_type: scopeType,
          scope_value: scopeValue.trim(),
          scope_refine_type: refineType || undefined,
          scope_refine_value: refineValue.trim() || undefined,
          categories,
          match: catMatch,
          exclude: notCats,
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResults(d.runs);
      setDropped(d.dropped || []);
      setUsage(d.usage ? { ...d.usage, ai_request: d.ai_request || null } : null);
      // Pre-select non-crossovers AND duplicates (merges are desirable)
      setSelected(new Set(d.runs.map((_, i) => i).filter(i => !d.runs[i].is_crossover)));
    } catch (e) { setError(e.message); }
    setGenerating(false);
  };

  const toggleSelect = (i) => {
    setSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  };

  const setEventOverride = (i, eventId) => {
    setEventOverrides(prev => ({ ...prev, [i]: eventId }));
  };

  const importSelected = async () => {
    if (!selected.size) { setError('Select at least one run to import'); return; }
    setImporting(true); setError('');
    try {
      // Iterate over the original indices directly — no need to filter then
      // search backwards with indexOf to recover the position.
      const toImport = [...selected].sort((a, b) => a - b).map(i => {
        const run = results[i];
        const override = eventOverrides[i];
        const acceptedEventId = override !== undefined
          ? override
          : (run.matched_event?.id || null);
        return { ...run, accepted_event_id: acceptedEventId };
      });
      const r = await fetch('/api/canon/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs: toImport }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      onImported(d);
    } catch (e) { setError(e.message); setImporting(false); }
  };

  const content = (
      <div className="adm-modal-content order-generator">
        <div className="a-grow a-flex a-col" style={{ overflowY: 'auto' }}>
          {/* Scope controls */}
          <div className="a-flex a-col a-gap-12" style={{ padding: '16px 20px', borderBottom: '1px solid var(--adm-g3)' }}>
            {/* Scope type buttons */}
            <div className="a-flex a-gap-8">
              {SCOPE_TYPES.map(({ key, label }) => (
                <button key={key}
                  className={`tsg-scope-btn ${scopeType === key ? 'tsg-scope-btn-active' : ''}`}
                  onClick={() => { setScopeType(key); clearRefinement(); }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Primary scope value */}
            <input className="adm-input" value={scopeValue}
              onChange={e => setScopeValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && generate()}
              placeholder={
                scopeType === 'character' ? 'e.g. Batman, Spider-Man, Daredevil…' :
                scopeType === 'publisher' ? 'e.g. Marvel, DC Comics, Image Comics…' :
                'e.g. DC Vertigo, Marvel MAX, DC Black Label…'
              }
            />

            {/* Refinement — available for all scope types; "Series" only shown for character */}
            <div>
              <div className="a-fs-11 a-faint a-mb-6 a-upper" style={{ letterSpacing: '0.06em' }}>
                Refine by <span className="a-dim" style={{ textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
              </div>
              <div className="a-flex a-gap-8 a-ai-c">
                <div className="a-flex a-gap-6 a-noshrink a-wrap">
                  {REFINE_TYPES
                    .filter(({ key }) => scopeType === 'character' || key !== 'series')
                    .map(({ key, label }) => (
                      <button key={key}
                        style={{ ...s.scopeBtn, fontSize: 11, padding: '3px 10px', ...(refineType === key ? s.scopeBtnActive : {}) }}
                        onClick={() => { setRefineType(refineType === key ? '' : key); setRefineValue(''); }}>
                        {label}
                      </button>
                    ))}
                </div>
                {refineType && (
                  <button className="tsg-scope-btn a-fs-11 a-err" style={{ padding: '3px 8px', borderColor: '#3a1a1a' }}
                    onClick={clearRefinement}>✕</button>
                )}
              </div>

              {/* Refinement value input */}
              {refineType === 'era' && (
                <select className="adm-input a-mt-8" value={refineValue} onChange={e => setRefineValue(e.target.value)}>
                  <option value="">Select an era…</option>
                  {ERA_OPTIONS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              )}
              {refineType === 'story_type' && (
                <select className="adm-input a-mt-8" value={refineValue} onChange={e => setRefineValue(e.target.value)}>
                  <option value="">Select a story type…</option>
                  {STORY_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              {(refineType === 'creator' || refineType === 'series') && (
                <input className="adm-input a-mt-8" value={refineValue}
                  onChange={e => setRefineValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && generate()}
                  placeholder={refineType === 'creator' ? 'e.g. Grant Morrison, Frank Miller…' : 'e.g. Legends of the Dark Knight, Detective Comics…'}
                />
              )}
            </div>

            {/* Categories */}
            <div>
              <div className="a-fs-11 a-faint a-mb-6 a-upper" style={{ letterSpacing: '0.06em' }}>Categories</div>
              <div className="a-flex a-gap-8">
                {CATEGORIES.map(({ key, label }) => {
                  const m = catMode[key] || '';
                  return (
                    <button key={key} aria-pressed={!!m}
                      title={m === 'must' ? 'Must have · click to exclude' : m === 'not' ? 'Must not have · click to clear' : "Doesn't matter · click to require"}
                      style={{ ...s.catBtn, ...(m === 'must' ? s.catBtnActive : m === 'not' ? s.catBtnNot : {}) }}
                      onClick={() => cycleCategory(key)}>
                      {m === 'must' ? '✓ ' : m === 'not' ? '✕ ' : ''}{label}
                    </button>
                  );
                })}
              </div>
              <div className="a-fs-11 a-mt-6" style={{ color: categories.length ? 'color-mix(in srgb, var(--om-text) 45%, var(--om-base))' : 'color-mix(in srgb, var(--td-red) 75%, white)' }}>{catSummary}</div>
            </div>

            {error && !results && <div className="a-err a-fs-12">{error}</div>}
            <div className="a-flex a-jc-e">
              <button className="adm-btn adm-btn-primary" style={{ opacity: generating ? 0.5 : 1 }} onClick={generate} disabled={generating}>
                {generating ? '⏳ Generating…' : '✨ Generate'}
              </button>
            </div>
          </div>

          {/* Results preview */}
          {results && (
            <div className="a-grow" style={{ overflowY: 'auto' }}>
              <div className="a-flex a-ai-c a-jc-b" style={{ padding: '10px 20px', borderBottom: '1px solid var(--adm-g3)', position: 'sticky', top: 0, background: 'var(--adm-g1)', zIndex: 1 }}>
                <span className="a-fs-12 a-muted">
                  {results.length} generated — {selected.size} selected
                  {usage && <span className="a-faint a-ml-8 a-fs-11" title="Estimate from the app's price table">
                    {usage.est_cents != null ? `≈ ${Math.round(usage.est_cents)}¢${usage.model ? ` · ${usage.model}` : ''} · ` : ''}({usage.input_tokens}↑ {usage.output_tokens}↓ tokens{usage.searches != null ? ` · ${usage.searches} searches` : ''})<AiInfo request={usage.ai_request} /></span>}
                  {dropped.length > 0 && <span className="a-faint a-ml-8 a-fs-11" title={dropped.map(d => `${d.title}: ${d.reason}`).join('\n')}>· {dropped.length} left out by your filter</span>}
                </span>
                <div className="a-flex a-gap-6">
                  <button className="adm-btn a-fs-11" style={{ padding: '3px 8px' }}
                    onClick={() => setSelected(new Set(results.map((_, i) => i).filter(i => !results[i].is_crossover)))}>
                    Select non-crossovers
                  </button>
                  <button className="adm-btn a-fs-11" style={{ padding: '3px 8px' }}
                    onClick={() => setSelected(new Set(results.map((_, i) => i).filter(i => !!results[i].duplicate_of)))}
                    title="Select only runs that will merge into existing entries">
                    Select merges only
                  </button>
                  <button className="adm-btn a-fs-11" style={{ padding: '3px 8px' }} onClick={() => setSelected(new Set())}>None</button>
                </div>
              </div>

              {results.map((run, i) => {
                const writers    = run.creators?.filter(c => c.role === 'writer').map(c => c.name).join(', ');
                const isSelected = selected.has(i);
                const isDup      = !!run.duplicate_of;
                const isEvent    = !!run.matched_event;
                const isCrossover = !!run.is_crossover;
                const overrideVal = eventOverrides[i];
                // Effective event: override takes precedence
                const effectiveEventId = overrideVal !== undefined ? overrideVal : (run.matched_event?.id || null);

                let rowBg = isSelected ? '#0e1a0e' : 'transparent';
                let rowBorder = isSelected ? '#4caa60' : '#1a1a2a';
                if (isCrossover) { rowBg = '#111118'; rowBorder = '#f5c518'; }
                if (isDup) { rowBg = '#0a0a1a'; rowBorder = '#4a8ccc'; }

                return (
                  <div key={i} className="tsg-gen-row" style={{ background: rowBg, borderLeft: `3px solid ${rowBorder}` }}>
                    {/* Checkbox */}
                    <div className="a-noshrink" style={{ paddingTop: 2 }} onClick={() => toggleSelect(i)}>
                      <div className="a-flex a-ai-c a-jc-c a-ptr" style={{ width: 14, height: 14, border: `1.5px solid ${isSelected ? '#4caa60' : 'color-mix(in srgb, var(--om-base) 80%, white)'}`, borderRadius: 3, background: isSelected ? '#4caa60' : 'transparent' }}>
                        {isSelected && <span className="a-fs-10 a-fw7" style={{ color: 'var(--adm-g0)' }}>✓</span>}
                      </div>
                    </div>

                    <div className="a-grow a-min0" onClick={() => toggleSelect(i)}>
                      <div className="a-flex a-ai-b a-gap-8 a-mb-2 a-wrap">
                        <span className="a-fs-13 a-fw6 a-text">{run.title}</span>
                        {run.parent_series && <span className="a-fs-11 a-faint">{run.parent_series}</span>}
                        {run.issue_range_hint && <span className="a-fs-11 a-faint a-italic">{run.issue_range_hint}</span>}
                      </div>
                      {writers && <div className="a-fs-11 a-muted a-mb-2">✍ {writers}</div>}
                      {run.description && <div className="a-fs-11 a-faint" style={{ lineHeight: 1.4 }}>{run.description.slice(0, 100)}{run.description.length > 100 ? '…' : ''}</div>}
                      <div className="a-flex a-gap-4 a-wrap a-mt-4">
                        {run.categories?.map(c => (
                          <span key={c} className="tsg-gen-cat-pill">{CATEGORIES.find(x => x.key === c)?.label || c}</span>
                        ))}
                        {run.adaptation_notes && <span className="tsg-gen-cat-pill a-info" style={{ borderColor: '#1a3a5a' }}>{run.adaptation_notes}</span>}
                        {isCrossover && <span className="tsg-gen-cat-pill a-accent" style={{ borderColor: 'color-mix(in srgb, var(--td-yellow) 35%, transparent)' }}>⚡ Crossover — review before importing</span>}
                        {isDup && (
                          <span className="tsg-gen-cat-pill a-info" style={{ borderColor: '#1a3a5a' }}>
                            ↗ Merges into existing — adds {run.categories?.map(c => CATEGORIES.find(x => x.key === c)?.label || c).join(', ')} tag{run.categories?.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Event link control */}
                    {isEvent && (
                      <div className="a-noshrink a-flex a-col a-ai-e a-gap-4" style={{ minWidth: 140 }}
                        onClick={e => e.stopPropagation()}>
                        <div className="a-fs-10 a-accent a-ta-r">⚡ Matches event:</div>
                        <div className="a-fs-11 a-text a-ta-r">{run.matched_event.name}</div>
                        <div className="a-flex a-gap-4">
                          <button
                            className="tsg-gen-cat-pill a-ptr a-fs-10" style={{ background: effectiveEventId ? '#1a2a0a' : 'transparent', color: effectiveEventId ? '#4caa60' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', borderColor: effectiveEventId ? '#2a4a1a' : 'color-mix(in srgb, var(--om-base) 95%, white)' }}
                            onClick={() => setEventOverride(i, run.matched_event.id)}>
                            {effectiveEventId ? '✓ Linked' : 'Link'}
                          </button>
                          <button
                            className="tsg-gen-cat-pill a-ptr a-fs-10" style={{ background: overrideVal === null ? '#2a0a0a' : 'transparent', color: overrideVal === null ? 'color-mix(in srgb, var(--td-red) 75%, white)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', borderColor: overrideVal === null ? '#4a1a1a' : 'color-mix(in srgb, var(--om-base) 95%, white)' }}
                            onClick={() => setEventOverride(i, null)}>
                            Ignore
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {results && (
          <div className="a-flex a-gap-8 a-jc-b a-ai-c a-noshrink" style={{ padding: '12px 20px', borderTop: '1px solid var(--adm-g3)' }}>
            {error && <div className="a-err a-fs-12 a-grow">{error}</div>}
            <div className="a-flex a-gap-8 a-ml-auto">
              <button className="adm-btn" onClick={() => { setResults(null); setSelected(new Set()); setEventOverrides({}); }}>← Re-generate</button>
              <button className="adm-btn adm-btn-primary" style={{ opacity: (!selected.size || importing) ? 0.5 : 1 }}
                onClick={importSelected} disabled={!selected.size || importing}>
                {importing ? 'Importing…' : `Import ${selected.size} run${selected.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
  );
  // embedded: shown inside the New run dialog (components/NewEntry.jsx) instead of its own dialog.
  if (embedded) return content;
  return <Modal title="✨ Generate Canon Runs" onClose={onClose} width={700}>{content}</Modal>;
}

// ─── Run Editor Modal ─────────────────────────────────────────────
// Exported for Top Shelf's "+ Add run" (2026-10-17).
export function RunEditorModal({ run, onClose, onSaved, embedded = false }) {
  const isNew = !run;
  const [form, setForm] = useState({
    title: run?.title || '',
    parent_series: run?.parent_series || '',
    cv_volume_id: run?.cv_volume_id || '',
    issue_range_hint: run?.issue_range_hint || '',
    description: run?.description || '',
    status: run?.status || 'pending',
    categories: run?.categories?.map(c => ({ ...c })) || [],
    creators: run?.creators?.map(c => ({ ...c })) || [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleCategory = (key) => {
    setForm(f => {
      const exists = f.categories.find(c => c.category === key);
      return exists
        ? { ...f, categories: f.categories.filter(c => c.category !== key) }
        : { ...f, categories: [...f.categories, { category: key, adaptation_notes: '' }] };
    });
  };

  const updateAdaptationNotes = (key, notes) => {
    setForm(f => ({ ...f, categories: f.categories.map(c => c.category === key ? { ...c, adaptation_notes: notes } : c) }));
  };

  const addCreator = () => setForm(f => ({ ...f, creators: [...f.creators, { person_name: '', role: 'writer' }] }));
  const updateCreator = (i, field, val) => setForm(f => ({ ...f, creators: f.creators.map((c, idx) => idx === i ? { ...c, [field]: val } : c) }));
  const removeCreator = (i) => setForm(f => ({ ...f, creators: f.creators.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!form.title.trim()) { setError('Title is required'); return; }
    setSaving(true); setError('');
    try {
      const url = isNew ? '/api/canon/runs' : `/api/canon/runs/${run.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          creators: form.creators.filter(c => c.person_name.trim()),
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      onSaved();
    } catch (e) { setError(e.message); setSaving(false); }
  };

  const content = (
      <div className="adm-modal-content">
        <div className="a-flex a-col a-gap-12" style={{ overflowY: 'auto', padding: '16px 20px' }}>
          <div>
            <label className="adm-label">Title *</label>
            <input className="adm-input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Born Again" />
          </div>
          <div className="a-grid a-gap-10" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <label className="adm-label">Parent series</label>
              <input className="adm-input" value={form.parent_series} onChange={e => setForm(f => ({ ...f, parent_series: e.target.value }))} placeholder="Daredevil" />
            </div>
            <div>
              <label className="adm-label">Issue range hint</label>
              <input className="adm-input" value={form.issue_range_hint} onChange={e => setForm(f => ({ ...f, issue_range_hint: e.target.value }))} placeholder="Daredevil #168–191 (1964 vol)" />
            </div>
          </div>
          <div>
            <label className="adm-label">CV Volume ID</label>
            <input className="adm-input" value={form.cv_volume_id} onChange={e => setForm(f => ({ ...f, cv_volume_id: e.target.value }))} placeholder="18458" />
          </div>
          <div>
            <label className="adm-label">Description</label>
            <textarea className="adm-input" style={{ minHeight: 80, resize: 'vertical' }} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Miller's definitive Daredevil run…" />
          </div>

          {/* Categories */}
          <div>
            <label className="adm-label">Categories</label>
            <div className="a-flex a-col a-gap-8">
              {CATEGORIES.map(({ key, label }) => {
                const active = form.categories.find(c => c.category === key);
                return (
                  <div key={key}>
                    <label className="a-flex a-ai-c a-gap-8 a-ptr">
                      <input type="checkbox" checked={!!active} onChange={() => toggleCategory(key)} />
                      <span className="a-text a-fs-13">{label}</span>
                    </label>
                    {active && key === 'adapted_to_screen' && (
                      <input className="adm-input a-mt-6 a-ml-20"
                        value={active.adaptation_notes || ''}
                        onChange={e => updateAdaptationNotes(key, e.target.value)}
                        placeholder="e.g. HBO series 2019, animated film 2012" />
                    )}
                    {active && key === 'award_winning' && (
                      <input className="adm-input a-mt-6 a-ml-20"
                        value={active.adaptation_notes || ''}
                        onChange={e => updateAdaptationNotes(key, e.target.value)}
                        placeholder="e.g. Eisner Award — Best Limited Series (1987)" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Creators */}
          <div>
            <label className="adm-label">Creators</label>
            <div className="a-flex a-col a-gap-6">
              {form.creators.map((c, i) => (
                <div key={i} className="a-flex a-gap-6 a-ai-c">
                  <input className="adm-input" style={{ flex: 2 }} value={c.person_name}
                    onChange={e => updateCreator(i, 'person_name', e.target.value)} placeholder="Frank Miller" />
                  <select className="adm-input a-grow" value={c.role}
                    onChange={e => updateCreator(i, 'role', e.target.value)}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className="adm-icon-btn a-fs-13 a-noshrink" onClick={() => removeCreator(i)}>✕</button>
                </div>
              ))}
              <button className="tsg-add-btn" onClick={addCreator}>+ Add creator</button>
            </div>
          </div>

          {/* Status */}
          <div>
            <label className="adm-label">Status</label>
            <select className="adm-input" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {error && <div className="a-err a-fs-13">{error}</div>}
        </div>
        <div className="a-flex a-gap-8 a-jc-e" style={{ padding: '12px 20px', borderTop: '1px solid var(--adm-g3)' }}>
          <button className="adm-btn" onClick={onClose}>Cancel</button>
          <button className="adm-btn adm-btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Create' : 'Save'}</button>
        </div>
      </div>
  );
  // embedded: shown inside the New run dialog (components/NewEntry.jsx) instead of its own dialog.
  if (embedded) return content;
  return <Modal title={<>{isNew ? 'Add Canon Run' : 'Edit Canon Run'}</>} onClose={onClose} width={620}>{content}</Modal>;
}

const s = {






  scopeBtn:      { background: 'none', border: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', color: 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  scopeBtnActive:{ background: 'color-mix(in srgb, var(--om-base) 95%, white)', color: 'var(--om-text)', borderColor: 'color-mix(in srgb, var(--om-base) 85%, white)' },
  catBtn:        { background: 'none', border: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', color: 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer', flex: 1 },
  catBtnActive:  { background: 'var(--om-base)', color: 'var(--td-yellow)', borderColor: 'color-mix(in srgb, var(--td-yellow) 35%, transparent)' },
  catBtnNot:     { background: 'var(--om-base)', color: '#d07070', borderColor: '#4a1a20', textDecoration: 'line-through', textDecorationColor: 'rgba(208,112,112,0.5)' },
};
