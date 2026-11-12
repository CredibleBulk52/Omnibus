// ─── Top Shelf admin bar ──────────────────────────────────────────
// Admin tools on the Top Shelf page (claude/ADMIN_REORG.md: retiring Canon
// Admin; user 2026-10-17): the pending review: runs waiting for approval, with Approve / Reject / Open.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GenerateModal, RunEditorModal } from '../pages/TopShelfGenerators';
import { NewEntryButton, NewEntryDialog } from './NewEntry';
import { ImportButton } from './CuratedTransfer';
import '../adminBar.css';
import { AiInfo } from './AiInfo';

const getJson = async url => { const r = await fetch(url); const d = await r.json().catch(() => []); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; };

// newTab / onNewTab: the page's + New run button opens the New run dialog here, so a
// generated or added run lands in this bar's Pending review.
export default function TopShelfAdmin({ onChanged, newTab = null, onNewTab = () => {} }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(null);
  const [rejected, setRejected] = useState([]);
  const [show, setShow] = useState(null);         // 'pending' | 'rejected' (shown as Blocked) | 'categories' | null
  const [ticked, setTicked] = useState(() => new Set());   // runs ticked in the open list
  const [confirmDel, setConfirmDel] = useState(null);      // ids waiting for "Delete?" confirmation
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const [checks, setChecks] = useState({});       // run id → how Auto-resolve went (Pending review)
  const [cat, setCat] = useState(null);            // Check categories: { counts, job, proposals }
  const [catMenu, setCatMenu] = useState(false);
  const [catOff, setCatOff] = useState(() => new Set());   // proposal ids unticked in the review
  const [catBusy, setCatBusy] = useState(false);
  const [awardsCount, setAwardsCount] = useState(null);   // "Runs missing recorded awards": counted when the menu opens (slow)
  const menuRef = useRef(null);
  useEffect(() => {   // the Check categories menu closes on a click elsewhere
    if (!catMenu) return undefined;
    const down = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setCatMenu(false); };
    document.addEventListener('mousedown', down); return () => document.removeEventListener('mousedown', down);
  }, [catMenu]);
  const [polls, setPolls] = useState(0);
  const load = useCallback(async () => {
    try {
      const [p, r, c] = await Promise.all([getJson('/api/canon/runs?status=pending'), getJson('/api/canon/runs?status=rejected'), getJson('/api/editor/runs/check').catch(() => [])]);
      setPending(Array.isArray(p) ? p : []); setRejected(Array.isArray(r) ? r : []);
      setChecks(Object.fromEntries((Array.isArray(c) ? c : []).map(x => [x.id, x])));
      const k = await getJson('/api/editor/runs/categories').catch(() => null);
      if (k) { setCat(k); setCatOff(new Set(k.proposals.flatMap(pr => pr.items).filter(i => i.action === 'remove' || i.drops).map(i => i.id))); }
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Just after an import, Auto-resolve is still fetching issues: look again every 8 s (up to 3 minutes).
  const waiting = show === 'pending' && (pending || []).some(r => { const c = checks[r.id]; return c && !c.total && !c.result; });
  useEffect(() => {
    if (!waiting || polls >= 22) return undefined;
    const t = setTimeout(() => { setPolls(n => n + 1); load(); }, 8000);
    return () => clearTimeout(t);
  }, [waiting, polls, load]);
  // While a category check runs, look again every 6 s.
  const catRunning = !!(cat && cat.job && cat.job.running);
  useEffect(() => {
    if (!catRunning) return undefined;
    const t = setTimeout(load, 6000);
    return () => clearTimeout(t);
  }, [catRunning, cat, load]);
  const startCheck = async scope => {
    setCatMenu(false); setErr('');
    try {
      const r = await fetch('/api/editor/runs/categories/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load();
    } catch (e) { setErr(e.message); }
  };
  const stopCheck = async () => {
    try { await fetch('/api/editor/runs/categories/stop', { method: 'POST' }); await load(); } catch (e) { setErr(e.message); }
  };
  const catItems = cat ? cat.proposals.flatMap(pr => pr.items) : [];
  const applyCats = async () => {
    setCatBusy(true); setErr('');
    try {
      const r = await fetch('/api/editor/runs/categories/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: catItems.filter(i => !catOff.has(i.id)).map(i => i.id), dismiss: catItems.filter(i => catOff.has(i.id)).map(i => i.id) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load(); onChanged && onChanged();
      if (d.kept && d.kept.length) setErr(`Kept ${d.kept.map(k => `${k.category} on "${k.title}"`).join(', ')}: it is the run's only tag. Add another tag first, or dismiss the removal.`);
      else setShow(null);
    } catch (e) { setErr(e.message); } finally { setCatBusy(false); }
  };
  const toggleCat = id => setCatOff(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const checkLine = r => {
    const c = checks[r.id];
    if (!c) return null;
    if (c.result && c.result.error) return <span className="tsa-warn">⚠ Auto-resolve failed: {c.result.error}</span>;
    if (!c.total) return c.result ? <span className="tsa-warn">⚠ No issues from Comic Vine{c.result.skipped ? ` (${c.result.skipped})` : ''}: set the volume in the editor (Tools › Rebuild)</span>
      : <span className="tsa-muted">No issues yet: Comic Vine is still being asked…</span>;
    const vol = c.cv_volume_id ? ` · Comic Vine volume ${c.cv_volume_id}` : '';
    if (c.expected && c.total !== c.expected) return <span className="tsa-warn">⚠ {c.total} issues, but the range names {c.expected}{vol}: check it in the editor</span>;
    return <span className="tsa-ok">✓ {c.total} issue{c.total === 1 ? '' : 's'} · {c.owned} in your library{vol}</span>;
  };
  const setStatus = async (run, status) => {
    setBusy(run.id); setErr('');
    try {
      const r = await fetch(`/api/editor/run/${run.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      await load(); if (status === 'approved' || run.status === 'approved') onChanged && onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  // Several runs at once (Pending review / Blocked): approve, block, back to pending, delete.
  // Block = stored as 'rejected': the generator is told never to suggest it. Delete forgets the run,
  // so a later generation may suggest it again (user 2026-10-18).
  const bulk = async (ids, action) => {
    setBusy('bulk'); setErr('');
    try {
      const r = await fetch('/api/editor/runs/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setTicked(new Set()); setConfirmDel(null);
      await load(); if (action === 'approve') onChanged && onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  useEffect(() => { setTicked(new Set()); setConfirmDel(null); }, [show]);
  const list = show === 'pending' ? pending || [] : show === 'rejected' ? rejected : [];
  const tickedIds = list.filter(r => ticked.has(r.id)).map(r => r.id);
  const tick = id => setTicked(t => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const del = ids => (confirmDel && confirmDel.join() === ids.join()
    ? <span className="tsa-confirm">Delete {ids.length === 1 ? 'this run' : `${ids.length} runs`}? It may be suggested again.
        <button className="tsa-link danger" disabled={busy === 'bulk'} onClick={() => bulk(ids, 'delete')}>Delete</button>
        <button className="tsa-link" onClick={() => setConfirmDel(null)}>Keep</button></span>
    : <button className="tsa-link danger" disabled={busy === 'bulk'} onClick={() => setConfirmDel(ids)}>Delete</button>);
  return (
    <section className="tsa admin-bar" aria-label="Admin tools">
      <div className="tsa-bar admin-bar-row">
        <span className="admin-bar-label">Admin</span>
        <NewEntryButton label="New run" onClick={() => onNewTab('generate')} />
        <ImportButton />
        <span className="tsa-menuwrap" ref={menuRef}>
          <button className="admin-bar-btn" disabled={catRunning} onClick={() => {
            if (!catMenu) getJson('/api/editor/runs/categories?awards=1').then(k => setAwardsCount(k && k.counts ? k.counts.awards || 0 : 0)).catch(() => {});
            setCatMenu(m => !m);
          }}
            title="Check each run's categories (adapted to screen, award winning, critically acclaimed) on the web; you review the changes before they apply">
            {catRunning ? 'Checking categories…' : 'Check categories ▾'}</button>
          {catMenu && cat && <div className="tsa-menu">
            {[['unchecked', 'Runs not checked yet', cat.counts.unchecked], ['pending', 'Pending runs', cat.counts.pending], ['all', 'All runs, again', cat.counts.all],
              ...(awardsCount ? [['awards', 'Runs missing recorded awards', awardsCount]] : [])].map(([k, l, n]) => (
              <button key={k} disabled={!n} onClick={() => startCheck(k)}>{l} · {n}<small>{k === 'awards' ? 'award tag only, from the verified awards list' : n ? `${Math.ceil(n / 5)} batch${Math.ceil(n / 5) === 1 ? '' : 'es'} of up to 5 runs` : 'none'}</small></button>))}
          </div>}
        </span>
        <span className="tsa-spacer" />
        {catItems.length > 0 && <button className={`tsa-link${show === 'categories' ? ' on' : ''}`} onClick={() => setShow(s => (s === 'categories' ? null : 'categories'))}>
          Categories to review · {catItems.length}</button>}
        <button className={`tsa-link${show === 'pending' ? ' on' : ''}`} onClick={() => setShow(s => (s === 'pending' ? null : 'pending'))}>
          Pending review{pending ? ` · ${pending.length}` : ''}</button>
        {rejected.length > 0 && <button className={`tsa-link${show === 'rejected' ? ' on' : ''}`} onClick={() => setShow(s => (s === 'rejected' ? null : 'rejected'))}
          title="Runs you blocked: the generator is told never to suggest them">
          Blocked · {rejected.length}</button>}
      </div>
      {err && <div className="tsa-err">{err}</div>}
      {cat && cat.job && <CatProgress job={cat.job} onStop={stopCheck} />}
      {cat && cat.job && !cat.job.running && cat.job.errors.length > 0 && <div className="tsa-err">Category check: {cat.job.errors.length} problem(s), e.g. {cat.job.errors[0]}</div>}
      {show === 'categories' && cat && <div className="tsa-list">
        {cat.proposals.map(pr => (
          <div key={pr.run_id} className="tsa-cat">
            <div className="tsa-title"><b>{pr.title}</b><small>{[pr.parent_series, pr.issue_range_hint].filter(Boolean).join(' · ')}
              {pr.sources.length > 0 && <> · sources: {[...pr.sources.filter(u => /^https?:/.test(u)).slice(0, 3), ...pr.sources.filter(u => !/^https?:/.test(u))].map((u, n) => /^https?:/.test(u)
                ? <a key={n} href={u} target="_blank" rel="noreferrer">{(u.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] || 'link'}</a>
                : <span key={n} title="The app's own records: verified award winners, Comic Book Roundup scores">{u}</span>).reduce((a, b) => [a, ', ', b])}</>}</small></div>
            {pr.items.map(i => (
              <label key={i.id} className={`tsa-catrow ${i.action}`}>
                <input type="checkbox" checked={!catOff.has(i.id)} onChange={() => toggleCat(i.id)} />
                <span><b>{i.action === 'add' ? '+ ' : i.action === 'remove' ? '− ' : '✎ '}{i.label}</b>
                  {i.notes && <> — {i.notes}</>}
                  {i.current_notes && <small> (was: {i.current_notes})</small>}
                  {i.why && <span className="tsa-why">{i.why}</span>}
                  {i.drops && <small className="tsa-warn">{i.why ? '' : ' · '}lists fewer than the current tag; unticked</small>}
                  {i.action === 'remove' && <small>{i.why || i.drops ? '' : ' · '}{i.lastTag ? "the run's only tag: it would leave every Top Shelf row, so it is kept unless another tag is added" : 'found not to qualify; unticked: tick to remove it'}</small>}</span>
              </label>))}
          </div>))}
        <div className="tsa-catfoot">
          <span className="tsa-muted">{catItems.filter(i => !catOff.has(i.id)).length} of {catItems.length} ticked · unticked ones are dismissed</span>
          <span className="tsa-spacer" />
          <button className="admin-bar-btn primary" disabled={catBusy} onClick={applyCats}>{catBusy ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>}
      {show && show !== 'categories' && <div className="tsa-list">
        {!list.length && <div className="tsa-empty">{show === 'pending' ? 'Nothing waiting for review.' : 'No blocked runs.'}</div>}
        {list.length > 0 && <div className="tsa-bulk">
          <label className="tsa-all"><input type="checkbox" checked={tickedIds.length === list.length} onChange={() => setTicked(tickedIds.length === list.length ? new Set() : new Set(list.map(r => r.id)))} />
            {tickedIds.length ? `${tickedIds.length} ticked` : 'Tick all'}</label>
          {show === 'rejected' && !tickedIds.length && <span className="tsa-muted">The generator is told never to suggest these. Delete one to let it come back.</span>}
          {tickedIds.length > 0 && <>
            <span className="tsa-spacer" />
            {show === 'pending' ? <>
              <button className="admin-bar-btn primary" disabled={busy === 'bulk'} onClick={() => bulk(tickedIds, 'approve')}>Approve</button>
              <button className="admin-bar-btn" disabled={busy === 'bulk'} onClick={() => bulk(tickedIds, 'block')} title="Never suggest these again">Block</button>
            </> : <button className="admin-bar-btn" disabled={busy === 'bulk'} onClick={() => bulk(tickedIds, 'pending')}>Unblock</button>}
            {del(tickedIds)}
          </>}
        </div>}
        {list.map(r => (
          <div key={r.id} className={`tsa-row${ticked.has(r.id) ? ' on' : ''}`}>
            <input type="checkbox" className="tsa-tick" checked={ticked.has(r.id)} onChange={() => tick(r.id)} aria-label={`Tick ${r.title}`} />
            <div className="tsa-title"><b>{r.title}</b><small>{[r.parent_series, r.issue_range_hint].filter(Boolean).join(' · ')}</small>
              {show === 'pending' && <small className="tsa-check">{checkLine(r)}</small>}</div>
            <button className="tsa-link" onClick={() => navigate(`/canon/run/${r.id}/edit`)}>Open in editor</button>
            {show === 'pending' ? <>
              <button className="admin-bar-btn primary" disabled={busy === r.id || busy === 'bulk'} onClick={() => setStatus(r, 'approved')}>Approve</button>
              <button className="admin-bar-btn" disabled={busy === r.id || busy === 'bulk'} onClick={() => setStatus(r, 'rejected')} title="Never suggest this run again">Block</button>
            </> : <button className="admin-bar-btn" disabled={busy === r.id || busy === 'bulk'} onClick={() => setStatus(r, 'pending')} title="Back to Pending review">Unblock</button>}
            {del([r.id])}
          </div>))}
      </div>}
      {newTab && (
        <NewEntryDialog title="New run" tab={newTab} onTab={onNewTab} onClose={() => onNewTab(null)}>
          {tab => tab === 'generate'
            ? <GenerateModal embedded onClose={() => onNewTab(null)} onImported={() => { onNewTab(null); setShow('pending'); setPolls(0); load(); }} />
            : <RunEditorModal embedded run={null} onClose={() => onNewTab(null)} onSaved={() => { onNewTab(null); setShow('pending'); load(); onChanged && onChanged(); }} />}
        </NewEntryDialog>
      )}
      <style>{`
        .tsa-spacer { flex: 1; }
        .tsa-link { background: none; border: 0; color: var(--text-secondary, #bbb); font: inherit; font-size: 0.84rem; cursor: pointer; padding: 4px 2px; }
        .tsa-link:hover, .tsa-link.on { color: var(--text-primary, #fff); text-decoration: underline; text-underline-offset: 3px; }
        .tsa-err { color: #e07070; font-size: 0.84rem; padding: 0 14px 10px; }
        .tsa-prog { color: var(--text-secondary, #bbb); font-size: 0.82rem; padding: 0 14px 10px; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
        .tsa-prog b { color: var(--text-primary, #fff); font-weight: 600; }
        .tsa-prog .tsa-link { font-size: 0.82rem; padding: 0 2px; }
        .tsa-list { border-top: 1px solid var(--border-subtle, #333); }
        .tsa-row { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border-subtle, #2a2a2a); }
        .tsa-row:last-child { border-bottom: 0; }
        .tsa-row.on { background: color-mix(in srgb, var(--td-yellow) 6%, transparent); }
        .tsa-bulk { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border-subtle, #2a2a2a); font-size: 0.82rem; min-height: 38px; }
        .tsa-all { display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary, #bbb); cursor: pointer; }
        .tsa-link.danger { color: #e07070; }
        .tsa-confirm { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8rem; color: #e0a050; }
        .tsa-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .tsa-title small { color: var(--text-muted, #888); font-size: 0.76rem; }
        .tsa-check { margin-top: 2px; }
        .tsa-menuwrap { position: relative; }
        .tsa-menu { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 250px; padding: 4px; border-radius: 8px; background: var(--bg-elevated, #222); border: 1px solid var(--border-subtle, #444); box-shadow: 0 10px 28px rgba(0,0,0,0.45); }
        .tsa-menu button { display: flex; flex-direction: column; width: 100%; text-align: left; background: none; border: 0; color: var(--text-primary, #eee); font: inherit; font-size: 0.84rem; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
        .tsa-menu button:hover:not(:disabled) { background: var(--bg-hover, #333); }
        .tsa-menu button:disabled { opacity: 0.45; cursor: default; }
        .tsa-menu small { color: var(--text-muted, #888); font-size: 0.74rem; }
        .tsa-cat { padding: 10px 14px; border-bottom: 1px solid var(--border-subtle, #2a2a2a); }
        .tsa-cat a { color: var(--text-secondary, #bbb); }
        .tsa-catrow { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0 0 6px; font-size: 0.84rem; cursor: pointer; }
        .tsa-catrow input { margin-top: 3px; }
        .tsa-catrow small { color: var(--text-muted, #888); }
        .tsa-why { display: block; color: var(--text-secondary, #bbb); font-size: 0.8rem; font-style: italic; margin-top: 1px; }
        .tsa-catrow small.tsa-warn { color: #e0a050; }
        .tsa-catrow.add b { color: #6fbf7f; } .tsa-catrow.remove b { color: #e07070; } .tsa-catrow.update b { color: #e0c050; }
        .tsa-catfoot { display: flex; align-items: center; gap: 12px; padding: 10px 14px; font-size: 0.84rem; }
        .tsa-ok { color: #6fbf7f; } .tsa-warn { color: #e0a050; } .tsa-muted { color: var(--text-muted, #888); }
        .tsa-empty { padding: 12px 14px; color: var(--text-muted, #888); font-size: 0.86rem; }
      `}</style>
    </section>
  );
}

// Category check progress: batch n of N, runs done, time per batch, tokens; Stop while it runs.
// After it ends, a one-line summary for 30 minutes.
const fmtTokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
const fmtMs = ms => (ms >= 90000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);
export function CatProgress({ job, onStop }) {
  if (!job) return null;
  const tokens = job.tokens ? ` · ${fmtTokens(job.tokens)} tokens${job.cents != null ? ` · ≈ ${job.cents < 1 ? '<1' : Math.round(job.cents)}¢` : ''}` : '';
  const skipped = job.skipped ? ` (${job.skipped} already settled, skipped)` : '';
  if (job.running) {
    return (
      <div className="tsa-prog" role="status">
        <b>{job.stopped ? 'Stopping…' : `Batch ${job.batch} of ${job.batches}`}</b>
        <span>· {job.done} of {job.total} runs checked{skipped}{job.msPerBatch ? ` · about ${fmtMs(job.msPerBatch)} per batch` : ''}{tokens}<AiInfo request={job.ai_request} /></span>
        {!job.stopped && <button className="tsa-link danger" onClick={onStop} title="Stops now; the batch in progress is abandoned and its runs stay unchecked">Stop</button>}
      </div>
    );
  }
  if (!job.finishedAt || Date.now() - job.finishedAt > 30 * 60000) return null;
  return (
    <div className="tsa-prog" role="status">
      <b>Category check {job.stopped ? 'stopped' : 'finished'}</b>
      <span>· {job.done} of {job.total} runs checked{skipped} · {job.proposals} change{job.proposals === 1 ? '' : 's'} to review{tokens}<AiInfo request={job.ai_request} /></span>
    </div>
  );
}
