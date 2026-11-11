import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

// CV Admin was folded into the Library and Settings pages (2026-10-16,
// claude/ADMIN_REORG.md). Old links land in the right place.
export default function CVAdminPage() {
  const [params] = useSearchParams();
  const tab = params.get('tab') || 'sweeper';
  const to = tab === 'usage' ? '/settings?group=connections'
    : tab === 'characters' ? '/library?group=characters'
    : tab === 'no-cv-id' ? '/library?group=metadata&view=unidentified'
    : '/library?group=metadata';
  return <Navigate to={to} replace />;
}
export function CharacterVerification() {
  const [libraryChars, setLibraryChars]   = useState([]); // from your actual series.json
  const [cacheMap,     setCacheMap]        = useState({}); // name -> {image_url, cv_id, cached_at}
  const [overrides,    setOverrides]       = useState({}); // name -> {cv_id, image_url} (pending saves)
  const [previews,     setPreviews]        = useState({}); // cvId -> {name, image, publisher}
  const [searchRes,    setSearchRes]       = useState({}); // name -> [{id,name,image,publisher,appearances}]
  const [busy,         setBusy]            = useState({}); // name -> 'searching'|'previewing'
  const [saveMsg,      setSaveMsg]         = useState('');
  const [filter,       setFilter]          = useState('');
  const [tab,          setTab]             = useState('all'); // all | cached | overrides
  const previewQueue   = useRef([]);
  const previewRunning = useRef(false);

  const [loading, setLoading] = useState(true);

  // ── Load library characters + current cache ──────────────────────
  useEffect(() => {
    Promise.all([
      fetch('/api/characters').then(r => r.json()),
      fetch('/api/admin/cv-characters').then(r => r.json()),
    ]).then(([chars, admin]) => {
      // chars = { content: [{name, seriesCount}], totalElements }
      const charList = (chars.content || []).map(c => ({
        name: c.name,
        count: c.seriesCount || c.count || 0,
      }));
      setLibraryChars(charList);
      const cm = {};
      (admin.entries || []).forEach(e => {
        cm[e.name.toLowerCase()] = {
          ...e,
          // normalise the override flag name
          hasOverride: e.hasUserOverride || e.hasOverride || false,
        };
      });
      setCacheMap(cm);
      setLoading(false);
    }).catch(e => { console.error(e); setLoading(false); });
  }, []);

  // ── Throttled preview queue (1 req / 350ms to respect CV rate limits) ──
  const queuePreview = useCallback((cvId) => {
    if (!cvId || previews[cvId] || previewQueue.current.includes(cvId)) return;
    previewQueue.current.push(cvId);
    if (!previewRunning.current) drainPreviewQueue();
  }, [previews]);

  const drainPreviewQueue = useCallback(async () => {
    previewRunning.current = true;
    while (previewQueue.current.length > 0) {
      const cvId = previewQueue.current.shift();
      if (previews[cvId]) continue;
      try {
        const r = await fetch(`/api/admin/cv-preview/${cvId}`);
        const d = await r.json();
        if (d.name) {
          setPreviews(p => ({ ...p, [cvId]: {
            name: d.name,
            realName: d.real_name,
            image: d.image?.medium_url,
            publisher: d.publisher?.name,
            appearances: d.count_of_issue_appearances,
          }}));
        }
      } catch {}
      await new Promise(r => setTimeout(r, 350)); // CV rate limit
    }
    previewRunning.current = false;
  }, [previews]);

  // Queue previews for cached characters as they load
  useEffect(() => {
    Object.values(cacheMap).forEach(e => {
      if (e.cv_id) queuePreview(e.cv_id);
    });
  }, [cacheMap, queuePreview]);

  // ── Search CV for a character by name ────────────────────────────
  const searchCV = async (name) => {
    setBusy(b => ({ ...b, [name]: 'searching' }));
    try {
      const r = await fetch(`/api/admin/cv-search/${encodeURIComponent(name)}`);
      const results = await r.json();
      setSearchRes(s => ({ ...s, [name]: results }));
      results.forEach(c => queuePreview(String(c.id)));
    } catch {}
    setBusy(b => ({ ...b, [name]: null }));
  };

  // ── Select a CV result for a character ───────────────────────────
  const selectResult = (name, cvId) => {
    // Always store with lowercase key so it matches server lookup
    setOverrides(o => ({ ...o, [name.toLowerCase()]: cvId }));
    queuePreview(cvId);
  };

  // ── Save overrides to server ──────────────────────────────────────
  const saveOverrides = async () => {
    if (!Object.keys(overrides).length) return;
    setSaveMsg('Saving...');
    try {
      const r = await fetch('/api/admin/cv-characters/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: overrides }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Save failed');
      setSaveMsg(`✓ Saved ${d.count} override${d.count !== 1 ? 's' : ''} — reload home page to see updated images`);
      // Merge into cacheMap so UI reflects saved state immediately
      setCacheMap(m => {
        const next = { ...m };
        Object.entries(overrides).forEach(([name, cvId]) => {
          const key = name.toLowerCase();
          next[key] = { ...(next[key] || {}), cv_id: cvId, hasOverride: true, hasUserOverride: true };
        });
        return next;
      });
      setOverrides({});
    } catch { setSaveMsg('✗ Save failed'); }
  };

  // ── Clear a single cached entry so it re-resolves ─────────────────
  const clearOne = async (name) => {
    await fetch('/api/admin/cv-characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cvId: '' }),
    });
    setCacheMap(m => { const n = { ...m }; delete n[name.toLowerCase()]; return n; });
    setSaveMsg(`Cache cleared for "${name}" — will re-resolve on next search`);
  };

  // ── Filtered + sorted list ────────────────────────────────────────
  const displayed = libraryChars.filter(c => {
    const n = c.name.toLowerCase();
    if (filter && !n.includes(filter.toLowerCase())) return false;
    if (tab === 'cached')    return !!cacheMap[n];
    if (tab === 'overrides') return !!cacheMap[n]?.hasOverride;
    if (tab === 'uncached')  return !cacheMap[n];
    return true;
  });

  const pendingCount = Object.keys(overrides).length;
  const cachedCount  = Object.values(cacheMap).filter(e => e.cv_id).length;

  return (
    <div style={{ padding:'24px 32px', background:'var(--bg-base)', minHeight:'100vh' }}>

      {/* ── Header ── */}
      <div className="a-mb-20" style={{ borderBottom:'1px solid var(--border-subtle)', paddingBottom:16 }}>
        <div className="a-fs-22 a-text a-mb-4" style={{ fontFamily:"'Boogaloo', cursive" }}>
          Comic Vine Character Verification
        </div>
        <div className="a-text2 a-fs-13">
          Characters are resolved automatically using CV's <code style={{color:'var(--color-accent)'}}>count_of_issue_appearances</code> to
          pick the primary-universe version. Use this page to verify results and manually override any that are wrong.
          <br/>
          <span className="a-muted a-fs-13">
            {libraryChars.length} characters in your library · {cachedCount} cached · 7-day TTL
          </span>
        </div>
      </div>



      {/* ── Toolbar ── */}
      <div className="a-flex a-gap-10 a-mb-16 a-wrap a-ai-c">
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter characters…"
          className="a-text a-fs-13" style={{ background:'var(--bg-elevated)', border:'1px solid var(--border-subtle)', borderRadius:6, padding:'7px 13px', outline:'none', width:220 }}
        />
        {['all','cached','uncached','overrides'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="a-ptr a-fs-12 a-upper" style={{ padding:'6px 14px', borderRadius:6, letterSpacing:'0.05em', border:'1px solid var(--border-subtle)', background: tab===t ? 'color-mix(in srgb, var(--td-yellow) 15%, transparent)' : 'var(--bg-elevated)', color: tab===t ? 'var(--color-accent)' : 'var(--text-secondary)' }}>
            {t}
          </button>
        ))}
        <div className="a-ml-auto a-flex a-gap-10 a-ai-c">
          {saveMsg && (
            <span className="a-fs-13" style={{ color: saveMsg.startsWith('✓') ? '#6db86d' : saveMsg.startsWith('✗') ? 'color-mix(in srgb, var(--td-red) 60%, white)' : 'var(--text-secondary)' }}>
              {saveMsg}
            </span>
          )}
          <button onClick={saveOverrides} disabled={!pendingCount}
            className="a-fs-13" style={{ padding:'7px 18px', borderRadius:6, cursor: pendingCount ? 'pointer' : 'not-allowed', border:'1px solid color-mix(in srgb, var(--td-yellow) 40%, transparent)', background: pendingCount ? 'color-mix(in srgb, var(--td-yellow) 15%, transparent)' : 'var(--bg-elevated)', color:'var(--color-accent)', opacity: pendingCount ? 1 : 0.4 }}>
            {pendingCount ? `Save ${pendingCount} Override${pendingCount>1?'s':''}` : 'No Pending Changes'}
          </button>
        </div>
      </div>

      {/* ── Column headers ── */}
      <div className="a-grid a-gap-12 a-muted a-fs-11 a-upper a-mb-4" style={{ gridTemplateColumns:'200px 110px 130px 1fr', padding:'8px 12px', letterSpacing:'0.08em', borderBottom:'1px solid var(--border-subtle)' }}>
        <span>Character (series count)</span>
        <span>Status</span>
        <span>Resolved Image</span>
        <span>Actions / Search Results</span>
      </div>

      {/* ── Rows ── */}
      {loading && (
        <div className="a-muted a-ta-c a-fs-15" style={{ padding:'40px' }}>
          <div className="spinner" style={{ margin:'0 auto 12px' }} />
          Loading characters from your library…
        </div>
      )}

      {!loading && displayed.length === 0 && (
        <div className="a-muted a-ta-c a-fs-15" style={{ padding:'40px' }}>
          {libraryChars.length === 0
            ? 'No characters found — make sure your series have been enriched with metadata.'
            : 'No characters match this filter.'}
        </div>
      )}

      {displayed.map(char => {
        const n          = char.name.toLowerCase();
        const cached     = cacheMap[n];
        const pendingId  = overrides[char.name.toLowerCase()];
        const effectiveId = pendingId || cached?.cv_id;
        const preview    = effectiveId ? previews[effectiveId] : null;
        const results    = searchRes[char.name] || [];
        const isBusy     = busy[char.name];
        const isPending  = !!pendingId;
        const isOverride = cached?.hasOverride;

        let statusLabel, statusColor;
        if (isPending)       { statusLabel = '⟳ pending'; statusColor = '#f5c518'; }
        else if (isOverride) { statusLabel = '✎ override'; statusColor = '#7eb8d4'; }
        else if (preview)    { statusLabel = '✓ resolved'; statusColor = '#6db86d'; }
        else if (cached?.cv_id) { statusLabel = '⟳ preview…'; statusColor = 'var(--text-muted)'; }
        else                 { statusLabel = '○ uncached'; statusColor = 'var(--text-muted)'; }

        return (
          <div key={char.name}
            className="a-grid a-gap-12 a-mb-2" style={{ gridTemplateColumns:'200px 110px 130px 1fr', padding:'10px 12px', borderRadius:6, alignItems:'start', background: isPending ? 'color-mix(in srgb, var(--td-yellow) 5%, transparent)' : 'transparent', border:`1px solid ${isPending ? 'color-mix(in srgb, var(--td-yellow) 20%, transparent)' : 'transparent'}` }}>

            {/* Name + count */}
            <div>
              <div className="a-mono a-fs-13 a-text" style={{ textTransform:'capitalize' }}>
                {char.name}
              </div>
              <div className="a-fs-11 a-muted a-mt-2">
                {char.count} series
              </div>
              {effectiveId && (
                <a href={`https://comicvine.gamespot.com/character/4005-${effectiveId}/`}
                  target="_blank" rel="noreferrer"
                  className="a-fs-10 a-accent" style={{ textDecoration:'none' }}>
                  CV #{effectiveId} ↗
                </a>
              )}
            </div>

            {/* Status */}
            <div className="a-fs-12" style={{ color: statusColor, paddingTop:2 }}>
              {statusLabel}
              {preview && (
                <div className="a-fs-10 a-muted a-mt-2">
                  {preview.publisher}<br/>
                  {preview.appearances ? `${preview.appearances.toLocaleString()} appearances` : ''}
                </div>
              )}
            </div>

            {/* Resolved image */}
            <div className="a-flex a-col a-ai-c a-gap-4">
              {preview?.image ? (
                <>
                  <img src={preview.image} alt={preview.name}
                    style={{ width:72, height:108, objectFit:'cover', borderRadius:3,
                      boxShadow:'0 2px 8px rgba(0,0,0,0.6)',
                      outline: isPending ? '2px solid var(--color-primary)' : 'none' }} />
                  <span className="a-fs-10 a-text2 a-ta-c" style={{ maxWidth:90 }}>
                    {preview.name}
                    {preview.realName && preview.realName !== 'None' ? ` (${preview.realName})` : ''}
                  </span>
                </>
              ) : (
                <div className="a-flex a-ai-c a-jc-c a-muted a-fs-11 a-ta-c" style={{ width:72, height:108, background:'var(--bg-elevated)', borderRadius:3, padding:6 }}>
                  {effectiveId ? '⟳' : 'no ID'}
                </div>
              )}
            </div>

            {/* Actions + search results */}
            <div>
              <div className="a-flex a-gap-6 a-mb-8 a-wrap">
                <button onClick={() => searchCV(char.name)} disabled={!!isBusy}
                  className="a-text2 a-fs-12 a-ptr" style={{ padding:'4px 12px', borderRadius:4, border:'1px solid var(--border-subtle)', background:'var(--bg-elevated)' }}>
                  {isBusy === 'searching' ? '⟳ Searching…' : '🔍 Search CV'}
                </button>
                {effectiveId && (
                  <button onClick={() => clearOne(char.name)}
                    className="a-muted a-fs-12 a-ptr" style={{ padding:'4px 10px', borderRadius:4, border:'1px solid var(--border-subtle)', background:'var(--bg-elevated)' }}>
                    Clear Cache
                  </button>
                )}
                {isPending && (
                  <button onClick={() => setOverrides(o => { const n={...o}; delete n[char.name.toLowerCase()]; return n; })}
                    className="a-fs-12 a-ptr" style={{ padding:'4px 10px', borderRadius:4, border:'1px solid color-mix(in srgb, var(--td-yellow) 30%, transparent)', background:'transparent', color:'var(--color-accent)' }}>
                    ✕ Cancel
                  </button>
                )}
              </div>

              {/* CV search results as clickable cards */}
              {results.length > 0 && (
                <div className="a-flex a-gap-6 a-wrap">
                  {results.slice(0,8).map(res => {
                    const rid = String(res.id);
                    const rp  = previews[rid];
                    const sel = (pendingId || cached?.cv_id) === rid;
                    return (
                      <div key={rid} onClick={() => selectResult(char.name, rid)}
                        className="a-ptr a-flex a-col a-ai-c a-gap-2" style={{ padding:4, borderRadius:4, width:72, border:`1px solid ${sel ? 'var(--color-primary)' : 'var(--border-subtle)'}`, background: sel ? 'color-mix(in srgb, var(--td-yellow) 12%, transparent)' : 'var(--bg-elevated)', transition:'all 150ms' }}>
                        {rp?.image ? (
                          <img src={rp.image} alt="" style={{ width:64, height:96, objectFit:'cover', borderRadius:2 }} />
                        ) : (
                          <div className="a-flex a-ai-c a-jc-c a-muted a-fs-10" style={{ width:64, height:96, background:'var(--bg-base)', borderRadius:2 }}>⟳</div>
                        )}
                        <span className="a-fs-10 a-ta-c a-ovh a-ellip a-nowrap" style={{ color: sel ? 'var(--color-accent)' : 'var(--text-secondary)', lineHeight:1.2, maxWidth:68 }}>
                          {res.name}
                        </span>
                        <span className="a-fs-10 a-muted">
                          {(res.publisher?.name||'?').replace('DC Comics','DC').replace('Marvel','MRV')}
                        </span>
                        {res.count_of_issue_appearances > 0 && (
                          <span className="a-fs-10 a-muted">
                            {res.count_of_issue_appearances} iss.
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
