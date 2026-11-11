// The event generator (Generate with AI, or Create manually). Moved out of the retired
// Events Admin page on 2026-10-26; used by the Timeline's "+ New event" (NewEventPage).
import React, { useState } from 'react';

// ─── Constants ────────────────────────────────────────────────────
import { TIER_LABEL, TIER_COLOUR as tierColour } from '../components/tiers';
import { AiInfo } from '../components/AiInfo';

// ─── Styles ───────────────────────────────────────────────────────
// ─── Create Event Form (inline, not modal) ────────────────────────
// Exported so the Timeline page's "+ New event" can open it unchanged (2026-10-17).
// mode: when given ('generate' | 'manual'), the New event dialog's tabs choose it and the form's own toggle is hidden.
export function CreateEventForm({ onCreated, mode: modeProp }) {
  const [modeState, setMode] = useState('generate');
  const mode = modeProp || modeState;
  const [step, setStep] = useState('form');
  const [name, setName] = useState('');
  const [publisher, setPublisher] = useState('');
  const [year, setYear] = useState('');
  const [tier, setTier] = useState(2);
  const [description, setDescription] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [generating, setGenerating] = useState(false);
  const [previewIssues, setPreviewIssues] = useState([]);
  const [source, setSource] = useState(null);
  const [sourceUrl, setSourceUrl] = useState(null);
  const [autoArcId, setAutoArcId] = useState(null);
  const [autoArcName, setAutoArcName] = useState(null);
  const [notesIncluded, setNotesIncluded] = useState(true);   // false: the updated generator leaves tier notes to Write tier notes
  // What the generator recorded (2026-10-20): pages read, issues left out; per issue sources, order note, flag.
  const [sourcesRead, setSourcesRead] = useState([]);
  const [omitted, setOmitted] = useState([]);
  const [showSources, setShowSources] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);   // why each tier, why an issue was moved
  const [centralNarrative, setCentralNarrative] = useState(null);   // the event's main story as the generator read it
  const [genCost, setGenCost] = useState(null);   // estimated cost of the generation
  const [genAi, setGenAi] = useState(null);       // the request's id for the ⓘ AI details (admins)
  const [guideUrl, setGuideUrl] = useState('');          // admin-chosen guide page (optional): replaces the automatic pick
  const [guideTest, setGuideTest] = useState(null);      // { loading } | result of /api/events/guide-page/test
  const [guideText, setGuideText] = useState('');        // the page's text pasted from the browser (sites that refuse Omnibus)
  const [pasteOpen, setPasteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [arcQuery, setArcQuery] = useState('');
  const [arcResults, setArcResults] = useState([]);
  const [selectedArc, setSelectedArc] = useState(null);
  const [arcSearching, setArcSearching] = useState(false);

  const searchArcs = async () => {
    if (!arcQuery.trim()) return;
    setArcSearching(true); setArcResults([]);
    try {
      const r = await fetch(`/api/cv/story-arcs?q=${encodeURIComponent(arcQuery)}`);
      const d = await r.json();
      setArcResults(d.results || []);
    } catch (e) { setError(e.message); }
    setArcSearching(false);
  };

  const generate = async (cvIssues = []) => {
    if (!name.trim()) { setError('Event name is required'); return; }
    setGenerating(true); setError('');
    try {
      const r = await fetch('/api/events/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), publisher: publisher || null, year: year ? parseInt(year) : null, cvIssues, guideUrl: guideUrl.trim() || undefined, guideText: guideText.trim() ? guideText.slice(0, 200000) : undefined }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.detail ? `${d.error} — ${d.detail}` : d.error);
      setPreviewIssues(d.issues.map((i, idx) => ({ ...i, _id: idx })));
      setSource(d.source); setSourceUrl(d.sourceUrl);
      setAutoArcId(d.autoArcId || null); setAutoArcName(d.autoArcName || null);
      setNotesIncluded(d.notesIncluded !== false);
      setSourcesRead(d.sourcesRead || []); setOmitted(d.omitted || []); setCentralNarrative(d.centralNarrative || null); setGenCost(d.cost || null); setGenAi(d.ai_request || null);
      setStep('preview');
    } catch (e) { setError(e.message); }
    setGenerating(false);
  };

  const testGuide = async () => {
    if (!guideUrl.trim() && !guideText.trim()) return;
    setGuideTest({ loading: true });
    try {
      const r = await fetch('/api/events/guide-page/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: guideUrl.trim(), text: guideText.trim() ? guideText.slice(0, 200000) : undefined, name: name.trim(), year: year ? parseInt(year) : null }) });
      setGuideTest(await r.json());
    } catch (e) { setGuideTest({ ok: false, error: e.message }); }
  };

  // Guide page field + Test, used on the form and (with Regenerate) in the preview.
  const guideField = (extra = null) => (
    <div className="adm-field">
      <label className="adm-label">Guide page <span className="a-faint a-fw4" style={{ textTransform: 'none' }}>(optional: replaces the guide Omnibus would pick)</span></label>
      <div className="a-flex a-gap-8 a-ai-c a-wrap">
        <input className="adm-input a-grow" style={{ minWidth: 200 }} value={guideUrl} placeholder="https://… a reading order with notes on each issue"
          onChange={e => { setGuideUrl(e.target.value); setGuideTest(null); }} onKeyDown={e => e.key === 'Enter' && testGuide()} />
        <button className="adm-btn" onClick={testGuide} disabled={(!guideUrl.trim() && !guideText.trim()) || guideTest?.loading}
          title="Check that Omnibus can read the page and that it looks like a reading order for this event">{guideTest?.loading ? '…' : 'Test'}</button>
        {extra}
      </div>
      <div className="a-mt-4">
        <button onClick={() => setPasteOpen(v => !v)} className="a-muted a-fs-11 a-ptr" style={{ background: 'none', border: 'none', padding: 0 }}
          title="For sites that refuse Omnibus (Tumblr answers 403): open the page in your browser, select all, copy, paste here. The address above stays as the link.">
          {pasteOpen ? '▾' : '▸'} or paste the page's text{guideText.trim() ? ` (${guideText.trim().length.toLocaleString()} characters pasted)` : ''}</button>
        {pasteOpen && <textarea className="adm-input a-w100 a-mt-4 a-fs-11 a-bb" style={{ minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
          value={guideText} onChange={e => { setGuideText(e.target.value); setGuideTest(null); }}
          placeholder="Open the page in your browser, select all (Ctrl+A), copy and paste here. Used instead of fetching the address." />}
      </div>
      {guideTest && !guideTest.loading && (
        <div className="a-fs-11 a-mt-4" style={{ color: !guideTest.ok ? 'color-mix(in srgb, var(--td-red) 70%, white)' : guideTest.warnings?.length ? '#d9a441' : '#4caa60' }}>
          {!guideTest.ok ? `Can't read it: ${guideTest.error}`
            : `${guideTest.pasted ? 'Pasted text' : 'Read'}: ${guideTest.chars.toLocaleString()} characters, ${guideTest.issueMarks} issue numbers${guideTest.namesEvent === true ? ', names the event' : ''}`
              + (guideTest.warnings?.length ? ` — ${guideTest.warnings.join('; ')} (can still be used)` : '')}
        </div>
      )}
    </div>
  );

  const generateWithCv = async () => {
    let cvIssues = [];
    if (selectedArc) {
      try {
        const r = await fetch(`/api/cv/story-arcs/${selectedArc.id}/issues`);
        const d = await r.json();
        cvIssues = (d.issues || []).map(i => ({ id: i.id, volume_name: i.volume?.name || '', issue_number: i.issue_number, cover_date: i.cover_date }));
      } catch {}
    }
    generate(cvIssues);
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), publisher: publisher || null, year: year ? parseInt(year) : null,
          cv_story_arc_id: selectedArc?.id || autoArcId || null,
          generator: notesIncluded ? null : { source, sourceUrl, sourcesRead, omitted, centralNarrative },
          issues: previewIssues.map((i, idx) => ({
            cv_issue_id: i.cv_issue_id || null, sort_order: idx + 1,
            tier: i.tier || 'recommended', tier_note: i.tier_note || null,
            phase: i.phase || null, series_name: i.series_name,
            issue_number: i.issue_number, issue_title: i.issue_title || null,
            volume_year: i.volume_year ? String(i.volume_year) : null,
            sources: i.sources || null, order_note: i.order_note || null, order_flag: i.order_flag || null, tier_reason: i.tier_reason || null,
          })),
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      onCreated(d.id, { writeNotes: !notesIncluded });
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const saveManual = async () => {
    if (!name.trim()) { setError('Event name is required'); return; }
    setSaving(true); setError('');
    try {
      const r = await fetch('/api/events/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), publisher: publisher || null,
          year: year ? parseInt(year) : null, description: description || null,
          cover_image: coverImage || null, event_tier: tier }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      onCreated(d.id);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const sourceIsMemory = source === 'AI knowledge';
  // Series by series? (each title's issues together, 3+ titles of 2+ issues). Crossovers are
  // usually read alternating between titles; checklists often group them (2026-10-17).
  const runs = previewIssues.map(i => `${i.series_name}|${i.volume_year || ''}`).filter((k, n, a) => n === 0 || a[n - 1] !== k);
  const titleCount = new Set(runs).size;
  const seriesBySeries = titleCount >= 3 && runs.length === titleCount && previewIssues.some(i => i.release_date)
    && [...new Set(runs)].every(k => previewIssues.filter(i => `${i.series_name}|${i.volume_year || ''}` === k).length >= 2);
  // Stable sort by Comic Vine release date (issues without one keep their place relative to their
  // neighbours; aftermath stays last); phases that are no longer one block are cleared.
  const orderByRelease = () => setPreviewIssues(list => {
    const keyed = list.map((i, n) => ({ i, n, d: i.release_date || null, last: i.tier === 'aftermath' ? 1 : 0 }));
    let prev = '';
    for (const k of keyed) { if (k.d) prev = k.d; else k.d = prev; }
    const sorted = keyed.sort((a, b) => a.last - b.last || String(a.d).localeCompare(String(b.d)) || a.n - b.n).map(k => k.i);
    const blocks = sorted.map(i => i.phase).filter((p, n, a) => p && (n === 0 || a[n - 1] !== p));
    const split = new Set(blocks.filter((p, n) => blocks.indexOf(p) !== n));
    return sorted.map(i => (i.phase && split.has(i.phase) ? { ...i, phase: null } : i));
  });

  if (step === 'preview') {
    return (
      <div className="a-flex a-col a-gap-12">
        <div className="a-flex a-gap-10 a-ai-c a-wrap" style={{ padding: '10px 0 4px' }}>
          <span className="a-muted a-fs-12">{previewIssues.length} issues</span>
          {genCost && <span className="a-muted a-fs-12" title={`${genCost.model} · ${genCost.input.toLocaleString()} tokens in, ${genCost.output.toLocaleString()} out · ${genCost.searches} searches · ${genCost.pages} pages read (estimate from the app's price table)`}>
            ≈ {genCost.cents < 1 ? '<1' : Math.round(genCost.cents)}¢ · {genCost.model}</span>}
          <AiInfo request={genAi} />
          {previewIssues.some(i => !i.cv_issue_id) && <span title="Comic Vine has no issue with this series, volume year and number: often a made-up issue or a wrong volume year. Check these before creating, or remove them."
            className="a-fs-11 a-err" style={{ padding: '2px 8px', borderRadius: 10, background: '#2a0e0e', border: '1px solid #5a1e1e' }}>
            {previewIssues.filter(i => !i.cv_issue_id).length} not found on Comic Vine
          </span>}
          <span className="a-fs-11" style={{ padding: '2px 8px', borderRadius: 10, background: sourceIsMemory ? '#2a1a0e' : '#0e2a1a', color: sourceIsMemory ? '#c9844c' : '#4caa60', border: `1px solid ${sourceIsMemory ? '#5a3a1e' : '#1e5a3a'}` }}>
            {sourceIsMemory ? '⚠ AI knowledge only' : `✓ ${source}`}
          </span>
          {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="a-faint a-fs-11">view source ↗</a>}
          {!notesIncluded && <button className="adm-btn a-fs-11" style={{ padding: '2px 10px' }} onClick={() => setShowSources(v => !v)}
            title="Which reading-order sites list each issue, why issues were moved from release order, and what the generator left out">
            {showSources ? 'Hide sources' : 'Show sources'}</button>}
          {!notesIncluded && <button className="adm-btn a-fs-11" style={{ padding: '2px 10px' }} onClick={() => setShowReasoning(v => !v)}
            title="Why the generator gave each issue its tier, and why it moved issues from release order">
            {showReasoning ? 'Hide reasoning' : 'Show reasoning'}</button>}
          {(autoArcId || selectedArc) && (
            <span className="a-fs-11 a-info" style={{ padding: '2px 8px', borderRadius: 10, background: '#0e1a2a', border: '1px solid #1e3a5a' }}>
              🔗 CV Arc: {selectedArc?.name || autoArcName}
            </span>
          )}
        </div>

        {seriesBySeries && (
          <div className="a-fs-12 a-text2 a-flex a-ai-c a-gap-12" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g4)', borderRadius: 6, padding: '10px 14px' }}>
            <span className="a-grow">This order goes series by series. Crossovers are usually read alternating between titles, in release order.</span>
            <button className="adm-btn" onClick={orderByRelease} title="Sort by Comic Vine release date; phases that would be split are cleared">Order by release date</button>
          </div>
        )}

        {sourceIsMemory && (
          <div style={{ background: 'var(--om-base)', border: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', borderRadius: 6, padding: '12px 14px' }}>
            <div className="a-fs-12 a-muted a-mb-8">
              No verified reading order found. Link a ComicVine story arc to improve accuracy:
            </div>
            <div className="a-flex a-gap-8">
              <input className="adm-input a-grow" value={arcQuery} onChange={e => setArcQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchArcs()} placeholder={`Search CV for "${name}"…`} />
              <button className="adm-btn" onClick={searchArcs} disabled={arcSearching}>{arcSearching ? '…' : 'Search'}</button>
            </div>
            {arcResults.length > 0 && (
              <div className="a-mt-8" style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--adm-g3)', borderRadius: 4 }}>
                {arcResults.map(arc => (
                  <button key={arc.id} onClick={() => { setSelectedArc(arc); setArcResults([]); generateWithCv(); }}
                    className="a-flex a-ai-c a-gap-10 a-ptr a-w100 a-ta-l" style={{ padding: '8px 12px', background: 'none', border: 'none', borderBottom: '1px solid var(--adm-g1)' }}>
                    {arc.image && <img src={arc.image} alt="" className="a-noshrink" style={{ width: 28, height: 40, objectFit: 'cover', borderRadius: 2 }} onError={e => { e.target.style.display='none'; }} />}
                    <div>
                      <div className="a-text a-fs-12">{arc.name}</div>
                      <div className="a-faint a-fs-11">{arc.count_of_issue_appearances} issues · {arc.publisher?.name || ''}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showSources && (
          <div className="a-fs-12 a-text2 a-flex a-col a-gap-6" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, padding: '10px 14px' }}>
            <div><span className="a-text" style={{ marginRight: 8 }}>Pages read</span>
              {sourcesRead.length ? sourcesRead.map(p => p.url ? <a key={p.code + p.url} href={p.url} target="_blank" rel="noreferrer" className="a-accent" style={{ marginRight: 10 }}>{p.code}</a> : <span key={p.code} className="a-accent" style={{ marginRight: 10 }} title="pasted text, no address">{p.code}</span>) : 'none (AI knowledge)'}</div>
            {previewIssues.some(i => i.order_flag) && <div className="a-warn">
              {previewIssues.filter(i => i.order_flag).length} placed weeks from their release date with no reason given (marked below)</div>}
            <div><span className="a-text">Left out ({omitted.length})</span>
              {omitted.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18, maxHeight: 140, overflowY: 'auto' }}>
                {omitted.map((o, n) => <li key={n}>{o.series_name} #{o.issue_number}{o.volume_year ? ` (${o.volume_year})` : ''}
                  <span className="a-faint"> — {o.listed_by.join(', ') || 'no site'}: {o.reason || 'no reason given'}</span></li>)}
              </ul>}</div>
          </div>
        )}

        {(showSources || showReasoning) && !notesIncluded && (
          <div style={{ background: 'color-mix(in srgb, var(--om-base) 90%, black)', border: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', borderRadius: 6, padding: '10px 14px' }}>
            {(() => {
              const withReason = previewIssues.filter(i => i.tier_reason);
              const own = withReason.filter(i => /own reading/i.test(i.tier_reason)).length;
              return withReason.length > 0 && <div className="a-fs-12 a-mb-8" style={{ color: own > withReason.length / 3 ? 'color-mix(in srgb, var(--td-yellow) 65%, color-mix(in srgb, var(--om-text) 55%, var(--om-base)))' : 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))' }}>
                {own} of {withReason.length} tier reasons rest on the generator's own reading{own > withReason.length / 3 ? ': the guide says little about each issue. A guide page with more notes may help.' : '.'}</div>;
            })()}
            {guideField(<button className="adm-btn adm-btn-primary" style={{ padding: '6px 12px', opacity: generating ? 0.5 : 1 }} onClick={() => generate()} disabled={generating}
              title={(guideUrl.trim() || guideText.trim()) ? 'Generate again with this guide page (replaces this preview)' : 'Generate again with the guide Omnibus picks (replaces this preview)'}>
              {generating ? '⏳ Generating…' : (guideUrl.trim() || guideText.trim()) ? '↻ Regenerate with this page' : '↻ Regenerate'}</button>)}
          </div>
        )}

        {showReasoning && centralNarrative && (
          <div className="a-fs-12 a-text2" style={{ background: 'var(--adm-g1)', border: '1px solid var(--adm-g3)', borderRadius: 6, padding: '10px 14px' }}>
            <span className="a-text" style={{ marginRight: 8 }}>Main story, as the generator read it</span>{centralNarrative}
          </div>
        )}

        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid color-mix(in srgb, var(--om-base) 90%, white)', borderRadius: 6 }}>
          {previewIssues.map((issue, idx) => (
            <div key={issue._id ?? idx} className="a-flex a-ai-c a-gap-10 a-fs-12" style={{ padding: '7px 14px', borderBottom: '1px solid var(--adm-g1)' }}>
              <span className="a-dim a-ta-r a-noshrink" style={{ width: 24 }}>{idx + 1}</span>
              <div className="a-grow a-min0">
                <span className="a-text">{issue.series_name}</span>
                <span className="a-faint a-ml-6">#{issue.issue_number}</span>
                {issue.volume_year && <span className="a-faint a-ml-6">({issue.volume_year})</span>}
                {issue.phase && <span className="a-accent a-fs-10 a-ml-8">{issue.phase}</span>}
                {!issue.cv_issue_id && <span className="a-err a-fs-10 a-ml-8" title="Comic Vine has no issue with this series, volume year and number">not found on Comic Vine</span>}
                {showSources && (issue.sources?.length > 0 || issue.order_flag) && (
                  <div className="a-fs-10 a-faint a-mt-2 a-flex a-wrap" style={{ gap: '2px 12px' }}>
                    {issue.sources?.length > 0 && <span>{issue.sources.join(' · ')}</span>}
                    {issue.order_flag && <span className="a-warn">{issue.order_flag === 'late' ? 'read weeks after its release date' : 'read weeks before its release date'}, no reason given</span>}
                  </div>
                )}
                {showReasoning && (issue.tier_reason || issue.order_note) && (
                  <div className="a-fs-10 a-muted a-mt-2 a-flex a-col a-gap-0">
                    {issue.tier_reason && <span>Tier: {issue.tier_reason}</span>}
                    {issue.order_note && <span>Moved: {issue.order_note}</span>}
                  </div>
                )}
              </div>
              <span className="a-fs-10 a-noshrink" style={{ padding: '1px 6px', borderRadius: 8, border: '1px solid', borderColor: tierColour[issue.tier] || 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', color: tierColour[issue.tier] || 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' }}>
                {TIER_LABEL[issue.tier] || issue.tier}
              </span>
              <button onClick={() => setPreviewIssues(p => p.filter((_, i) => i !== idx))}
                className="a-faint a-ptr a-fs-13 a-noshrink" style={{ background: 'none', border: 'none', padding: '0 2px' }}>✕</button>
            </div>
          ))}
        </div>

        {error && <div className="a-err a-fs-12">{error}</div>}
        <div className="a-flex a-gap-8">
          <button className="adm-btn" onClick={() => setStep('form')}>← Back</button>
          <button className="adm-btn adm-btn-primary a-ml-auto" style={{ opacity: saving ? 0.5 : 1 }}
            onClick={save} disabled={saving}>
            {saving ? 'Creating…' : '✓ Create Event'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="a-flex a-col a-gap-12">
      {/* Mode toggle */}
      {!modeProp && <div className="a-flex a-mb-4" style={{ borderBottom: '1px solid var(--adm-g3)' }}>
        {[['generate', '✦ Generate with AI'], ['manual', '✎ Create Manually']].map(([m, label]) => (
          <button key={m} onClick={() => { setMode(m); setError(''); }}
            className="a-grow a-fs-12 a-ptr" style={{ padding: '9px 16px', border: 'none', background: 'transparent', color: mode === m ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', borderBottom: `2px solid ${mode === m ? 'var(--td-yellow)' : 'transparent'}` }}>
            {label}
          </button>
        ))}
      </div>}

      <div className="a-flex a-gap-12 a-wrap">
        <div className="adm-field" style={{ flex: 2, minWidth: 200 }}>
          <label className="adm-label">Event Name *</label>
          <input className="adm-input" value={name} onChange={e => setName(e.target.value)}
            placeholder={mode === 'generate' ? 'e.g. Blackest Night' : 'e.g. Batman: Knightfall'}
            onKeyDown={e => e.key === 'Enter' && mode === 'generate' && generate()} />
        </div>
        <div className="adm-field a-grow" style={{ minWidth: 130 }}>
          <label className="adm-label">Publisher</label>
          <input className="adm-input" value={publisher} onChange={e => setPublisher(e.target.value)} placeholder="DC Comics…" />
        </div>
        <div className="adm-field" style={{ width: 90 }}>
          <label className="adm-label">Year</label>
          <input className="adm-input" type="number" value={year} onChange={e => setYear(e.target.value)} placeholder="2009" />
        </div>
      </div>

      {mode === 'manual' && (
        <>
          <div className="adm-field">
            <label className="adm-label">Tier</label>
            <div className="a-flex a-gap-8">
              {[[1,'T1 Crisis-Level'],[2,'T2 Major Event'],[3,'T3 Crossover Arc']].map(([val, label]) => (
                <button key={val} onClick={() => setTier(val)}
                  className="a-grow a-fs-11 a-ptr" style={{ padding: '7px 6px', borderRadius: 4, border: `1px solid ${tier === val ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-base) 90%, white)'}`, background: tier === val ? 'color-mix(in srgb, var(--td-yellow) 12%, transparent)' : 'transparent', color: tier === val ? 'var(--td-yellow)' : 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="adm-field">
            <label className="adm-label">Description</label>
            <textarea className="adm-input" style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
              value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description…" />
          </div>
          <div className="adm-field">
            <label className="adm-label">Cover Image URL <span className="a-faint a-fw4" style={{ textTransform:'none' }}>(optional)</span></label>
            <div className="a-flex a-gap-8 a-ai-c">
              <input className="adm-input a-grow" value={coverImage} onChange={e => setCoverImage(e.target.value)} placeholder="https://…" />
              {coverImage && <img src={coverImage} alt="" className="a-noshrink" style={{ width:36, height:52, objectFit:'cover', borderRadius:3, border: '1px solid var(--adm-g4)' }} onError={e => { e.target.style.display='none'; }} />}
            </div>
          </div>
        </>
      )}

      {mode === 'generate' && guideField()}

      {mode === 'generate' && (
        <div className="a-fs-12 a-faint" style={{ lineHeight: 1.5 }}>
          The reading order is built from reading-order guides (FindMeComics, Comic Book Treasury,
          readingorders.com and others). If no guide covers the event, AI knowledge is used instead.
        </div>
      )}

      {error && <div className="a-err a-fs-12">{error}</div>}

      <div className="a-flex a-gap-8">
        {mode === 'generate'
          ? <button className="adm-btn adm-btn-primary" style={{ opacity: (!name.trim() || generating) ? 0.5 : 1 }}
              onClick={() => generate()} disabled={!name.trim() || generating}>
              {generating ? '⏳ Generating…' : '✦ Generate Reading Order'}
            </button>
          : <button className="adm-btn adm-btn-primary" style={{ opacity: (!name.trim() || saving) ? 0.5 : 1 }}
              onClick={saveManual} disabled={!name.trim() || saving}>
              {saving ? 'Creating…' : '✎ Create Event'}
            </button>
        }
      </div>
    </div>
  );
}
