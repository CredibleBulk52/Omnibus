import { useConfirm } from './Confirm';
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Library health ───────────────────────────────────────────────
// The attention list at the top of the Library page and the duplicate-copy
// review (claude/ADMIN_REORG.md, LIBRARY_HEALTH.md). "Needs you" rows add up
// to the badge on the Library button; information rows do not.
export const HEALTH_EVENT = 'omnibus:library-health';
export const healthChanged = () => { try { window.dispatchEvent(new Event(HEALTH_EVENT)); } catch {} };

// Badge for the Library nav button (admins only). Refreshes every 2 minutes
// and after any fix made on the Library page.
export function useLibraryBadge(enabled) {
  const [badge, setBadge] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const load = () => fetch('/api/admin/library-health').then(r => r.ok ? r.json() : null)
      .then(d => { if (!stopped && d) setBadge(d.badge || 0); }).catch(() => {});
    load();
    const t = setInterval(load, 120000);
    window.addEventListener(HEALTH_EVENT, load);
    return () => { stopped = true; clearInterval(t); window.removeEventListener(HEALTH_EVENT, load); };
  }, [enabled]);
  return badge;
}

const when = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// onOpen(group, view) opens a group on the Library page.
export function AttentionList({ onOpen, compact = false, onHealth }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => fetch('/api/admin/library-health').then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(d => { setData(d); setError(''); }).catch(e => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    window.addEventListener(HEALTH_EVENT, load);
    return () => { clearInterval(t); window.removeEventListener(HEALTH_EVENT, load); };
  }, [load]);
  useEffect(() => { onHealth?.(error ? null : data); }, [data, error, onHealth]);
  if (error) return <div className="health-box"><small style={{ color: 'color-mix(in srgb, var(--td-red) 70%, white)' }}>Library health is unavailable: {error}</small></div>;
  if (!data) return <div className="health-box"><small style={{ color: 'var(--text-muted)' }}>Checking the library…</small></div>;
  const n = data.needsYou, i = data.info;
  const needs = [
    ['Books stuck for a match', n.stuck, 'Omnibus checked these and needs you to choose the Comic Vine issue or resolve a conflict.', () => onOpen('metadata', 'intervention')],
    ['Damaged files', n.damaged, 'Some pages cannot be read. Replace the file, or use Convert anyway to keep the readable pages.', () => onOpen('metadata', 'damaged')],
    ['Unsafe archive paths', n.unsafe, 'A page name inside the archive cannot be used safely. Omnibus fixes folder names on its own; these need a new copy.', () => onOpen('metadata', 'unsafe')],
    ['Duplicate copies', n.duplicates, 'The same Comic Vine issue appears in more than one file. Choose which copy to keep.', () => onOpen('duplicates')],
    ['Failed downloads', n.failedDownloads, 'Downloads or packs that failed. Retry or remove them in the Download Manager.', () => navigate('/downloads?tab=queue')],
    ['Downloads held', n.heldDownloads || 0, 'Downloaded files that could not be added: a damaged file (Convert anyway or download a new copy) or a match to check.', () => navigate('/downloads?tab=queue')],
    ['User requests', n.requests, 'Readers asked for issues that are missing from their lists.', () => navigate('/admin/requests')],
    ['Series linked to the wrong volume', n.seriesLinks || 0, "A folder's series.json names a different Comic Vine series than the comics in it. Re-link it, or keep it if the link is right.", () => onOpen('series-links')],
  ];
  const fyi = [
    ['No Comic Vine ID yet', i.noCvId, 'Omnibus works through these on its own, mostly overnight.', () => onOpen('metadata', 'unidentified')],
    ['Series without details', i.seriesWithoutDetails, 'Series folders without a series.json.', () => onOpen('series')],
  ];
  const row = ([label, count, help, go]) => (
    <button key={label} type="button" className={`health-row${count ? '' : ' health-row--zero'}`} onClick={go} disabled={!count} title={help}>
      <span className="health-label">{label}</span>
      <span className="health-count">{count.toLocaleString()}</span>
    </button>
  );
  return (
    <div className={`health-box${compact ? ' health-compact' : ''}${data.badge ? ' health-attention' : ''}`}>
      <div className="health-head">
        <h3>{data.badge ? `Needs you · ${data.badge}` : compact ? '✓ No action required' : 'Nothing needs you right now'}</h3>
        <button type="button" className="adm-btn adm-btn-ghost" onClick={load} title="Check again">{compact ? '↻ Check again' : '↻'}</button>
      </div>
      {compact ? <>
        {data.badge > 0 && <div className="health-grid">{needs.filter(x => x[1] > 0).map(row)}</div>}
        <div className="health-grid health-info">{fyi.filter(x => x[1] > 0).map(row)}</div>
        <details className="health-all"><summary>All checks</summary><div className="health-grid">{needs.map(row)}{fyi.map(row)}</div></details>
      </> : <><div className="health-grid">{needs.map(row)}</div><div className="health-sub">For your information</div><div className="health-grid">{fyi.map(row)}</div></>}
      {i.comicVinePausedUntil && <p className="health-note">Comic Vine checks are paused until {when(i.comicVinePausedUntil)} (rate limit). They resume on their own.</p>}
      <style>{`
        .health-box { border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-card); padding: 14px 16px; }
        .health-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .health-head h3 { margin: 0; font-family: 'Boogaloo', cursive; letter-spacing: 0.06em; text-transform: uppercase; font-size: 1.15rem; color: var(--td-yellow, var(--text-primary)); }
        .health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; margin-top: 10px; }
        .health-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-radius: 8px;
          border: 1px solid var(--border-subtle); background: var(--bg-hover, rgba(255,255,255,0.03)); color: var(--text-primary); font: inherit; cursor: pointer; text-align: left; }
        .health-row:hover:not(:disabled) { border-color: var(--td-yellow, var(--color-primary)); }
        .health-row--zero { opacity: 0.5; cursor: default; }
        .health-count { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--td-yellow, var(--color-primary)); }
        .health-row--zero .health-count { color: var(--text-muted); }
        .health-sub { margin-top: 14px; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
        .health-note { margin: 10px 0 0; font-size: 0.82rem; color: var(--text-muted); }
      `}</style>
    </div>
  );
}

const size = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((b || 0) / 1024)) + ' KB';
const folder = p => String(p || '').split(/[\\/]/).slice(-2, -1)[0] || '';

// Duplicate copies (checker v2, claude/LIBRARY_HEALTH.md). The server lists
// only books that really are the same comic; files whose name says they are
// another comic are identified again on their own and, if that fails, wait in
// Manual intervention. Each group shows the comic, its copies, and the copy
// Omnibus would keep with the reason. Keeping a copy moves the others to the
// holding folder (not deleted) and carries reading progress over.
const SHOW_STEP = 40;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function DuplicatesPanel({ onOpen }) {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [choice, setChoice] = useState({});
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(SHOW_STEP);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [asking, setAsking] = useState('');   // group whose "Not duplicates" question is open
  const load = useCallback(() => fetch('/api/admin/library-health/duplicates').then(r => r.json())
    .then(d => { if (d.error) throw new Error(d.error); setData(d); })
    .catch(e => setNotice('Could not load duplicates: ' + e.message)), []);
  useEffect(() => { load(); }, [load]);
  const running = !!data?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const { job } = await fetch('/api/admin/library-health/duplicates/job').then(r => r.json());
        setData(d => ({ ...d, job }));
        if (!job?.running) { clearInterval(t); await load(); healthChanged(); }
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const keepGroup = async g => {
    const keepId = choice[g.cvIssueId] || g.suggestId;
    const n = g.books.length - 1;
    if (!(await confirm({ message: `Keep this copy and move ${plural(n, 'other copy', 'other copies')} to the holding folder?\n\nNothing is deleted; reading progress moves to the copy you keep.`, title: 'Keep this copy?', confirmLabel: 'Keep this copy' }))) return;
    setBusy(g.cvIssueId); setNotice('');
    try {
      const r = await fetch(`/api/admin/library-health/duplicates/${encodeURIComponent(g.cvIssueId)}/keep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepId }) });
      const d = await r.json().catch(() => ({}));
      setNotice(r.ok ? `${g.title}: kept one copy, moved ${plural(d.moved, 'copy', 'copies')} to ${d.holding}.` : (d.error || 'HTTP ' + r.status));
    } finally { setBusy(''); await load(); healthChanged(); }
  };
  // Not duplicates (2026-10-26): both tags right (a Director's Cut or variant with no
  // Comic Vine entry of its own) hides the group; one copy tagged wrong is identified again.
  const notDuplicates = async g => {
    setBusy(g.cvIssueId); setAsking('');
    try { await fetch(`/api/admin/library-health/duplicates/${encodeURIComponent(g.cvIssueId)}/keep-all`, { method: 'POST' }); }
    finally { setBusy(''); await load(); healthChanged(); }
  };
  const wrongCopy = async (g, b) => {
    setBusy(g.cvIssueId); setAsking(''); setNotice('');
    try {
      const r = await fetch(`/api/admin/library-health/duplicates/${encodeURIComponent(g.cvIssueId)}/wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: b.id }) });
      const d = await r.json().catch(() => ({}));
      setNotice(!r.ok ? (d.error || 'HTTP ' + r.status)
        : `${b.filename}: being identified again${d.started ? '' : ' when the current job finishes'}. If Omnibus cannot match it, it appears in Manual intervention.`);
    } finally { setBusy(''); await load(); healthChanged(); }
  };
  const applyAll = async () => {
    const n = data?.counts?.duplicate || 0;
    if (!(await confirm({ message: `Keep the recommended copy in ${plural(n, 'comic')}?\n\nThe other copies move to the holding folder (not deleted) and reading progress moves with you. Groups marked "Needs a look" are left alone.`, title: 'Keep the recommended copies?', confirmLabel: 'Keep recommended' }))) return;
    setNotice('');
    const r = await fetch('/api/admin/library-health/duplicates/keep-best', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setNotice(d.error || 'Could not start: HTTP ' + r.status);
    setData(x => ({ ...x, job: d.job || x?.job }));
  };

  if (!data) return <p style={{ color: 'var(--text-muted)' }}>{notice || 'Loading…'}</p>;
  const { groups = [], counts = {}, mistagged = 0, reidentifying = 0, job } = data;
  const list = groups.filter(g => filter === 'all' || g.kind === filter);
  const jobLine = job && (job.kind === 'keep'
    ? `Keeping recommended copies: ${job.done} of ${job.total} · ${plural(job.moved, 'copy', 'copies')} moved to the holding folder${job.forgotten ? ` · ${job.forgotten} already gone from disk` : ''}${job.failed ? ` · ${job.failed} failed` : ''}`
    : `Identifying files again: ${job.done} of ${job.total} · ${job.fixed} fixed · ${job.needHelp} sent to Manual intervention${job.failed ? ` · ${job.failed} failed` : ''}`);
  return (
    <div className="dup2">
      <p className="dup2-lead">
        {groups.length ? <><b>{plural(groups.length, 'comic')}</b> {groups.length === 1 ? 'has' : 'have'} more than one copy{counts.look ? <>; {counts.look} {counts.look === 1 ? 'needs' : 'need'} a look</> : null}.</> : 'No duplicate copies.'}
        {mistagged > 0 && <> <span className="dup2-aside">{plural(mistagged, 'other file')} {mistagged === 1 ? 'is' : 'are'} tagged as the wrong comic; {reidentifying ? 'Omnibus is identifying them again' : 'they were sent to be identified again'}. Any it cannot match appear in {onOpen ? <a href="#" onClick={e => { e.preventDefault(); onOpen('metadata', 'intervention'); }}>Manual intervention</a> : 'Manual intervention'}.</span></>}
      </p>
      {groups.length > 0 && <div className="dup2-bar">
        <div className="dup2-chips">
          {[['all', 'All', groups.length], ['duplicate', 'Ready', counts.duplicate || 0], ['look', 'Needs a look', counts.look || 0]].map(([k, label, n]) => (
            <button key={k} type="button" className={`dup-chip${filter === k ? ' on' : ''}`} onClick={() => { setFilter(k); setShown(SHOW_STEP); }}>{label} <b>{n}</b></button>))}
        </div>
        <button className="adm-btn" disabled={running || !counts.duplicate} onClick={applyAll}>Keep recommended copy in {plural(counts.duplicate || 0, 'comic')}</button>
        {running && <button className="adm-btn adm-btn-ghost" onClick={() => fetch('/api/admin/library-health/duplicates/job/stop', { method: 'POST' })}>Stop</button>}
      </div>}
      {job && <p className="dup-job">{running ? '⏳ ' : '✓ '}{jobLine}{job.waitingUntil ? ` · waiting for the Comic Vine hourly limit until ${when(job.waitingUntil)}` : ''}{running && job.current ? ` · now: ${job.current}` : ''}</p>}
      {job?.errors?.length > 0 && !running && <details className="dup-job"><summary>{plural(job.errors.length, 'problem')}</summary>{job.errors.map((e, i) => <div key={i}>{e.file}: {e.error}</div>)}</details>}
      {notice && <p className="dup2-notice">{notice}</p>}
      {list.slice(0, shown).map(g => {
        const keepId = choice[g.cvIssueId] || g.suggestId;
        const custom = keepId !== g.suggestId;
        return (
          <div key={g.cvIssueId} className={`dup2-card${g.kind === 'look' ? ' look' : ''}`}>
            <div className="dup2-head">
              <span className="dup2-title">{g.title}</span>
              {g.kind === 'look' && <span className="dup2-flag">Needs a look</span>}
              <a href={`https://comicvine.gamespot.com/issue/4000-${g.cvIssueId}/`} target="_blank" rel="noreferrer">Comic Vine ↗</a>
            </div>
            {g.kind === 'look' && g.reason && <p className="dup2-why">{g.reason}. Keep one copy only if they are the same comic; otherwise choose Not duplicates and say which one is matched wrong.</p>}
            {g.books.map(b => {
              const keep = b.id === keepId;
              return (
                <label key={b.id} className={`dup2-copy${keep ? ' keep' : ''}`}>
                  <input type="radio" name={'keep-' + g.cvIssueId} checked={keep} onChange={() => setChoice(c => ({ ...c, [g.cvIssueId]: b.id }))} />
                  <span className={`dup2-mark ${keep ? 'keep' : 'move'}`}>{keep ? 'Keep' : 'Move out'}</span>
                  <span className="dup2-file"><span className="dup2-folder">{folder(b.path)} /</span> {b.filename}</span>
                  <span className="dup2-facts">
                    {size(b.file_size)}{b.pages ? ` · ${b.pages} pages` : ''}{b.has_progress ? ' · you have read this copy' : ''}
                    {b.ownFolder ? ' · in its own series folder' : ''}{b.check?.partial ? ' · partial copy' : ''}
                  </span>
                </label>
              );
            })}
            <p className="dup2-reason">{custom ? 'Your choice.' : <>Recommended: {g.keepReason}.</>} {g.books.some(b => b.has_progress && b.id !== keepId) && !g.books.find(b => b.id === keepId)?.has_progress ? 'Reading progress moves to the kept copy.' : ''}</p>
            <div className="dup2-actions">
              <button className="adm-btn" disabled={!!busy || running} onClick={() => keepGroup(g)}>
                {busy === g.cvIssueId ? 'Working…' : custom ? 'Keep my choice' : 'Keep recommended'}</button>
              <button className="adm-btn adm-btn-ghost" disabled={!!busy || running} onClick={() => setAsking(a => (a === g.cvIssueId ? '' : g.cvIssueId))} title="Different comics or editions">Not duplicates…</button>
            </div>
            {asking === g.cvIssueId && <div className="dup2-ask">
              <p>They share one Comic Vine match. Which one is matched wrong?</p>
              {g.books.map(b => (
                <button key={b.id} className="adm-btn adm-btn-ghost dup2-ask-file" disabled={!!busy || running} onClick={() => wrongCopy(g, b)}>
                  <span className="dup2-folder">{folder(b.path)} /</span> {b.filename}</button>))}
              <button className="adm-btn adm-btn-ghost dup2-ask-file" disabled={!!busy || running} onClick={() => notDuplicates(g)}>
                Both are right <span className="dup2-folder">(a Director's Cut or variant without its own Comic Vine entry): stop listing them</span></button>
              <button className="le-link dup2-ask-cancel" onClick={() => setAsking('')}>Cancel</button>
            </div>}
          </div>
        );
      })}
      {list.length > shown && <button className="adm-btn adm-btn-ghost" onClick={() => setShown(n => n + SHOW_STEP)}>Show {Math.min(SHOW_STEP, list.length - shown)} more of {list.length - shown}</button>}
      <style>{`
        .dup2-lead { color: var(--text-primary); margin: 4px 0 10px; line-height: 1.5; }
        .dup2-aside { color: var(--text-muted); font-size: 0.88rem; }
        .dup2-lead a { color: var(--td-yellow, var(--color-primary)); }
        .dup2-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
        .dup2-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-right: auto; }
        .dup-chip { background: var(--bg-hover, rgba(255,255,255,0.03)); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 5px 12px; color: var(--text-primary); font: inherit; font-size: 0.85rem; cursor: pointer; }
        .dup-chip.on { border-color: var(--td-yellow, var(--color-primary)); color: var(--td-yellow, var(--color-primary)); }
        .dup-job { color: var(--text-muted); font-size: 0.85rem; margin: 6px 0 12px; }
        .dup2-notice { color: var(--td-yellow, var(--color-primary)); font-size: 0.9rem; }
        .dup2-card { border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
        .dup2-card.look { border-color: color-mix(in srgb, var(--td-yellow) 55%, transparent); }
        .dup2-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
        .dup2-title { font-weight: 700; color: var(--text-primary); font-size: 1rem; }
        .dup2-flag { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #f5c518; border: 1px solid #f5c518; border-radius: 4px; padding: 1px 6px; }
        .dup2-head a { margin-left: auto; font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; }
        .dup2-why { color: var(--text-muted); font-size: 0.85rem; margin: -2px 0 8px; }
        .dup2-copy { display: grid; grid-template-columns: auto auto 1fr; column-gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
        .dup2-copy.keep { background: rgba(76,170,96,0.08); }
        .dup2-copy input { margin: 0; }
        .dup2-mark { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; min-width: 66px; }
        .dup2-mark.keep { color: #4caa60; } .dup2-mark.move { color: var(--text-muted); }
        .dup2-file { color: var(--text-primary); font-size: 0.9rem; word-break: break-word; }
        .dup2-folder { color: var(--text-muted); }
        .dup2-facts { grid-column: 3; color: var(--text-muted); font-size: 0.78rem; }
        .dup2-reason { color: var(--text-muted); font-size: 0.82rem; margin: 6px 0 0; }
        .dup2-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
        .dup2-ask { margin-top: 10px; padding: 10px 12px; border-radius: 6px; background: var(--bg-hover, rgba(255,255,255,0.03)); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
        .dup2-ask p { margin: 0 0 2px; color: var(--text-primary); font-size: 0.88rem; }
        .dup2-ask-file { text-align: left; font-size: 0.85rem; white-space: normal; }
        .dup2-ask-cancel { background: none; border: 0; color: var(--text-muted); font: inherit; font-size: 0.8rem; cursor: pointer; padding: 2px 0; }
      `}</style>
    </div>
  );
}

// Series page, Manage menu: identify every file in the folder again from its
// filename and folder, ignoring the tags inside the files. For a series whose
// files were all tagged from a wrong series.json. Runs as the Library page's
// cleanup job; progress shows here and on the Library page.
export function ReidentifySeriesButton({ seriesId, onDone }) {
  const confirm = useConfirm();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const mine = job && job.kind === 'retag';
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(() => fetch('/api/admin/library-health/duplicates/job').then(r => r.ok ? r.json() : null).then(d => {
      const j = d?.job; if (!j) return;
      setJob(j);
      if (!j.running) { healthChanged(); onDone?.(); }
    }).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [job?.running]);
  const start = async () => {
    if (!(await confirm({ message: 'Identify every file in this series again from its filename and folder? The tags inside the files are ignored and rewritten. Files that cannot be matched go to Manual intervention.', title: 'Identify again?', confirmLabel: 'Identify again' }))) return;
    setError('');
    try {
      const r = await fetch(`/api/admin/library-health/series/${encodeURIComponent(seriesId)}/reidentify`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); if (d.job) setJob(d.job); return; }
      setJob(d.job);
    } catch (e) { setError(e.message); }
  };
  const status = mine && (job.running
    ? `${job.done}/${job.total}${job.waitingUntil ? ` · waiting for Comic Vine until ${when(job.waitingUntil)}` : job.current ? ` · ${job.current}` : ''}`
    : `Done: ${job.fixed} retagged, ${job.confirmed} already right, ${job.needHelp} need you${job.failed ? `, ${job.failed} failed` : ''}`);
  return <>
    <button className="adm-btn adm-btn-ghost" disabled={!!job?.running} onClick={start}
      title="Identify every file in this folder again from its filename and folder, ignoring the tags inside the files">
      {job?.running ? '⏳ Re-identifying…' : '⟲ Re-identify all issues'}</button>
    {(status || error) && <div style={{ fontSize: 12, opacity: 0.8, padding: '2px 4px' }}>{error || status}</div>}
  </>;
}

// Series linked to the wrong Comic Vine volume (2026-11-13, backend/seriesLinkCheck.js).
// Each card: the folder, what its series.json says, what its comics are. Re-link rebuilds
// series.json from the files' volume (the existing series-page re-link; a backup of the old file is
// kept); "Link is right" keeps it.
export function SeriesLinksPanel() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(() => fetch('/api/admin/library-health/series-links').then(r => r.json())
    .then(d => { if (d.error) throw new Error(d.error); setData(d); })
    .catch(e => setNotice('Could not load: ' + e.message)), []);
  useEffect(() => { load(); }, [load]);

  const relink = async it => {
    const to = it.proposed.name ? `${it.proposed.name} (Comic Vine ${it.proposed.volumeId})` : `Comic Vine volume ${it.proposed.volumeId}`;
    if (!(await confirm({ title: 'Re-link this folder?', confirmLabel: 'Re-link',
      message: `Rebuild ${it.folder}'s series.json from ${to}?\n\nIt is fetched again from Comic Vine and enriched (description, genres), as on the series page. A backup of the current file is kept.` }))) return;
    setBusy(it.seriesId); setNotice('');
    try {
      const r = await fetch(`/api/series/${encodeURIComponent(it.seriesId)}/create-json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volumeId: it.proposed.volumeId }) });
      const d = await r.json().catch(() => ({}));
      setNotice(r.ok && d.success ? `${it.folder}: re-linked to ${d.name || to}.`
        : r.status === 429 && d.retryAt ? `${it.folder}: Comic Vine's hourly limit is used up. Try again after ${when(d.retryAt)}.`
        : `${it.folder}: ${d.error || 'HTTP ' + r.status}`);
    } finally { setBusy(''); await load(); healthChanged(); }
  };
  const keep = async it => {
    setBusy(it.seriesId);
    try { await fetch(`/api/admin/library-health/series-links/${encodeURIComponent(it.seriesId)}/dismiss`, { method: 'POST' }); }
    finally { setBusy(''); await load(); healthChanged(); }
  };
  const runNow = async () => {
    const r = await fetch('/api/admin/library-health/series-links/run', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    setNotice(r.ok ? 'Checking the remaining folders now (Metron answers most of them). Results appear here as they come in; refresh in a few minutes.' : (d.error || 'HTTP ' + r.status));
  };

  if (!data) return <p style={{ color: 'var(--text-muted)' }}>{notice || 'Loading…'}</p>;
  const { items = [], progress = {} } = data;
  const c = progress.counts || {};
  const looked = (c.ok || 0) + (c.mixed || 0) + (c.mismatch || 0) + (c.unknown || 0);
  return (
    <div className="links-panel">
      <div className="lp-head">
        <span><b>{items.length ? plural(items.length, 'folder') + ' to check' : 'No wrong links found'}</b>
          <span className="lp-muted" title={`Checked every hour: Metron first, then Comic Vine (keeping some for your clicks). ${looked} looked up${c.mixed ? `; ${c.mixed} hold more than one series` : ''}.`}>
            {progress.notYetRead > 0 ? ` · ${progress.notYetRead.toLocaleString()} folders not read yet` : ' · all folders read'}</span></span>
        <button className="adm-btn adm-btn-ghost" onClick={runNow}>Check more now</button>
      </div>
      {notice && <p className="lp-notice">{notice}</p>}
      <div className="lp-cards">
        {items.map(it => {
          const files = it.groups[0] || {};
          const others = it.groups.slice(1).reduce((n, g) => n + g.books, 0);
          return (
            <div key={it.seriesId} className="lp-card">
              <div className="lp-folder" title={it.path}>{it.folder}</div>
              <div className="lp-compare">
                <figure className="lp-side lp-wrong">
                  <div className="lp-cover">{it.current.image ? <img src={it.current.image} alt="" loading="lazy" onError={e => { e.target.style.display = 'none'; }} /> : null}<span className="lp-tag">✕ series.json</span></div>
                  <figcaption><b>{it.current.name || '—'}</b>{it.current.year ? ` (${it.current.year})` : ''}<small>{it.current.totalIssues != null ? plural(it.current.totalIssues, 'issue') : ''}</small></figcaption>
                </figure>
                <div className="lp-arrow" aria-hidden="true">→</div>
                <figure className="lp-side lp-right">
                  <div className="lp-cover"><img src={`/api/series/${encodeURIComponent(it.seriesId)}/thumbnail`} alt="" loading="lazy" onError={e => { e.target.style.display = 'none'; }} /><span className="lp-tag">✓ the comics</span></div>
                  <figcaption><b>{it.proposed.name || files.name || 'Comic Vine ' + it.proposed.volumeId}</b><small>{plural(files.books || 0, 'file')}{others ? ` · ${others} other` : ''}</small></figcaption>
                </figure>
              </div>
              <div className="lp-actions">
                <button className="adm-btn" disabled={!!busy || !it.proposed.volumeId} onClick={() => relink(it)}>{busy === it.seriesId ? 'Working…' : 'Re-link'}</button>
                <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => keep(it)} title="The series.json is right">Keep</button>
                <button className="lp-open" onClick={() => navigate(`/series/${encodeURIComponent(it.seriesId)}`)}>Open ›</button>
              </div>
            </div>
          );
        })}
      </div>
      <style>{`
        .links-panel .lp-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .links-panel .lp-muted { color: var(--text-muted); font-size: 0.85rem; font-weight: 400; cursor: help; }
        .links-panel .lp-notice { color: var(--td-yellow, var(--color-primary)); font-size: 0.9rem; margin: 0 0 10px; }
        .links-panel .lp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
        .links-panel .lp-card { border: 1px solid var(--border-subtle); border-radius: 10px; padding: 12px; background: var(--bg-card); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
        .links-panel .lp-folder { font-size: 0.8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .links-panel .lp-compare { display: grid; grid-template-columns: minmax(0, 120px) auto minmax(0, 120px); justify-content: start; align-items: start; gap: 10px; }
        .links-panel .lp-side { margin: 0; min-width: 0; }
        .links-panel .lp-cover { position: relative; aspect-ratio: 2 / 3; border-radius: 6px; overflow: hidden; background: color-mix(in srgb, var(--bg-card) 70%, black); }
        .links-panel .lp-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .links-panel .lp-wrong .lp-cover { opacity: 0.55; outline: 2px solid color-mix(in srgb, var(--td-red, #e55) 70%, transparent); }
        .links-panel .lp-right .lp-cover { outline: 2px solid var(--td-yellow, var(--color-primary)); }
        .links-panel .lp-tag { position: absolute; left: 6px; bottom: 6px; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.75); color: #fff; }
        .links-panel figcaption { font-size: 0.82rem; line-height: 1.3; margin-top: 6px; overflow-wrap: anywhere; }
        .links-panel figcaption small { display: block; color: var(--text-muted); font-size: 0.75rem; }
        .links-panel .lp-arrow { margin-top: 70px; font-size: 1.4rem; color: var(--td-yellow, var(--color-primary)); }
        .links-panel .lp-actions { display: flex; gap: 8px; align-items: center; }
        .links-panel .lp-open { margin-left: auto; background: none; border: 0; color: var(--text-muted); cursor: pointer; font: inherit; font-size: 0.85rem; }
      `}</style>
    </div>
  );
}
