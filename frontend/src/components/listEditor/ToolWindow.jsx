// ─── ToolWindow ───────────────────────────────────────────────────
// The editor's Tools menu (claude/ADMIN_REORG.md step 3, 2b). Each tool
// shows what it would change first; nothing changes until Apply.
//   rematch  (events, runs): Re-match to library — the shared matcher's
//            proposals, ticked; hand matches are never touched. Applies at once
//            (matches save at once in the editor, as in the issue window).
//   rebuild  (runs): Rebuild from Comic Vine — the Auto-resolve plan; Apply
//            replaces the run's automatic issues (hand-matched ones stay).
//   annotate (events): Write tier notes with AI — the proposed notes go into
//            the draft; Save keeps them.
import React, { useState, useEffect, useMemo } from 'react';
import { coverUrl } from './IssueWindow';
import { AiInfo } from '../AiInfo';

const getJson = async (url, opts) => {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
};
const postJson = (url, body) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;
const HOW = { cv: 'Comic Vine id', series: 'same series folder', comicinfo: 'ComicInfo series, number and year', continued: 'numbering continued in a later folder' };
const howText = p => (p.how === 'name' ? (p.dist ? `series name and number; volume year off by ${p.dist}` : 'series name, number and year') : HOW[p.how] || p.how);

// A cover; hovering it shows a large copy beside it (onPeek), so the art can be checked.
function Cover({ id, onPeek }) {
  const peek = e => onPeek && id && onPeek({ id, rect: e.currentTarget.getBoundingClientRect() });
  return <span className={`le-tw-cover${id ? '' : ' none'}`} onMouseEnter={peek} onMouseLeave={() => onPeek && onPeek(null)}>
    {id ? <img src={coverUrl(id)} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : 'none'}</span>;
}
function Peek({ peek }) {
  if (!peek) return null;
  const W = 300, H = 450, r = peek.rect;
  const left = r.right + 14 + W < window.innerWidth ? r.right + 14 : Math.max(8, r.left - 14 - W);
  const top = Math.max(8, Math.min(r.top + r.height / 2 - H / 2, window.innerHeight - H - 8));
  return <img className="le-tw-peek" src={coverUrl(peek.id)} alt="" style={{ left, top, width: W, height: H }} />;
}
const Title = ({ b }) => (b && b.title ? <span className="le-tw-title"> “{b.title}”</span> : null);
// The filename, when the comic sits in a folder named for another series (minis and annuals in a parent folder).
const File = ({ b }) => (b && b.filed && b.file ? <span className="le-tw-file"> · {b.file.replace(/\.(cbz|cbr|cb7|zip|rar)$/i, '')}</span> : null);
function Ticks({ all, on, set }) {
  return <span className="le-tw-ticks">
    <button className="le-link" onClick={() => set(new Set(all))}>All</button>
    <button className="le-link" onClick={() => set(new Set())}>None</button>
    <span className="le-muted">{on.size} of {all.length} ticked</span>
  </span>;
}

function Rematch({ kind, id, onApplied, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [on, setOn] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [peek, setPeek] = useState(null);
  useEffect(() => {
    let live = true;
    // Automatic matches the matcher is sure of start ticked; hand matches never do (you decide).
    getJson(`/api/editor/${kind}/${id}/rematch`).then(d => { if (!live) return; setData(d); setOn(new Set(d.proposals.filter(p => p.strong && !p.manual).map(p => p.id))); })
      .catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [kind, id]);
  const apply = async () => {
    setBusy(true); setErr('');
    try {
      const d = await postJson(`/api/editor/${kind}/${id}/rematch`, { items: data.proposals.filter(p => on.has(p.id)).map(p => ({ id: p.id, book_id: p.proposed.book_id })) });
      onApplied(d); onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const toggle = pid => setOn(s => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  const P = data ? data.proposals : [];
  const auto = P.filter(p => !p.manual), hand = P.filter(p => p.manual), look = data ? data.handCheck || [] : [];
  const row = p => (
    <label key={p.id} className={`le-tw-row${on.has(p.id) ? ' on' : ''}`}>
      <input type="checkbox" checked={on.has(p.id)} onChange={() => toggle(p.id)} />
      <span className="le-tw-pair">{p.cvOnly ? <Cover id={p.proposed.book_id} onPeek={setPeek} />
        : <><Cover id={p.current && p.current.book_id} onPeek={setPeek} /><span className="le-tw-arrow">→</span><Cover id={p.proposed.book_id} onPeek={setPeek} /></>}</span>
      <span className="le-tw-text">
        <span className="le-tw-issue">{p.issue}{!p.strong && <em className="le-tw-weak">less certain</em>}</span>
        {p.cvOnly ? <span>Match stays: {p.proposed.label}<Title b={p.proposed} /><File b={p.proposed} /> <span className="le-muted">· {howText(p)}</span></span> : <>
          <span className="le-muted" title={p.current && p.current.file ? p.current.file : ''}>{p.manual ? 'Your match' : 'Now'}: {p.current ? <>{p.current.label}<Title b={p.current} /><File b={p.current} /></> : 'not matched'}</span>
          <span title={p.proposed.file || ''}>{p.manual ? 'Matcher' : 'New'}: {p.proposed.label}<Title b={p.proposed} /><File b={p.proposed} /> <span className="le-muted">· {howText(p)}</span></span></>}
        {p.note && <span className="le-tw-note">{p.cvOnly ? `Only its Comic Vine id changes: ${p.note}.` : `Because ${p.note}${p.cvFix ? '; its Comic Vine id will be corrected too' : ''}.`}</span>}
      </span>
    </label>);
  const found = [auto.length && plural(auto.length, 'change'), hand.length && plural(hand.length, 'hand match', 'hand matches') + ' to check', look.length && `${look.length} more worth a look`].filter(Boolean);
  return <>
    <div className="le-tw-sum">
      {!data ? (err ? null : <span className="le-muted">Checking every issue against the library…</span>)
        : <span>Checked {plural(data.checked, 'issue')}{data.manual ? ` (${plural(data.manual, 'hand match', 'hand matches')})` : ''} · <b>{found.length ? found.join(' · ') : 'nothing to change'}</b>
          {data.none ? <span className="le-muted"> · {data.none} still not in the library</span> : null}</span>}
    </div>
    {err && <div className="le-notice error">{err}</div>}
    {(P.length > 0 || look.length > 0) && <div className="le-tw-list">
      {auto.map(row)}
      {hand.length > 0 && <div className="le-tw-sec"><b>Your hand matches</b> The matcher picks a different comic for these. They start unticked: tick the ones you got wrong. They stay hand matches.</div>}
      {hand.map(row)}
      {look.length > 0 && <div className="le-tw-sec"><b>Worth a look</b> Hand matches whose number or volume year looks off, with no better comic in the library. Fix them from the issue's cover in the editor if they are wrong.</div>}
      {look.map(c => (
        <div key={'l' + c.id} className="le-tw-row look">
          <span className="le-tw-pair">{c.current ? <Cover id={c.current.book_id} onPeek={setPeek} /> : <Cover id={null} />}</span>
          <span className="le-tw-text">
            <span className="le-tw-issue">{c.issue}</span>
            {c.current && <span className="le-muted" title={c.current.file || ''}>Your match: {c.current.label}<Title b={c.current} /><File b={c.current} /></span>}
            <span className="le-tw-note">Because {c.reason}.</span>
          </span>
        </div>))}
    </div>}
    <Peek peek={peek} />
    <div className="le-tw-foot">
      {P.length > 0 && <Ticks all={P.map(p => p.id)} on={on} set={setOn} />}
      <span className="le-spacer" />
      <button className="le-link" onClick={onClose}>{P.length ? 'Cancel' : 'Close'}</button>
      {P.length > 0 && <button className="btn btn-primary" disabled={!on.size || busy} onClick={apply}>{busy ? 'Applying…' : `Apply ${plural(on.size, 'change')}`}</button>}
    </div>
  </>;
}

function Rebuild({ id, dirty, onDone, onClose }) {
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [vol, setVol] = useState(null);          // null = the stored volume; '' = search again; digits = that volume
  const [typing, setTyping] = useState(false);
  const [draftVol, setDraftVol] = useState('');
  useEffect(() => {
    if (dirty) return undefined;
    let live = true;
    setPlan(null); setErr('');
    getJson(`/api/editor/run/${id}/rebuild${vol == null ? '' : `?volume=${encodeURIComponent(vol)}`}`).then(d => live && setPlan(d)).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [id, vol, dirty]);
  const apply = async () => {
    setBusy(true); setErr('');
    try { const d = await postJson(`/api/editor/run/${id}/rebuild`, { volume: plan.cvVolumeId }); onDone(d); onClose(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  if (dirty) return <>
    <div className="le-tw-sum">Save or discard your changes first: rebuilding replaces the run's issue list.</div>
    <div className="le-tw-foot"><span className="le-spacer" /><button className="le-link" onClick={onClose}>Close</button></div>
  </>;
  const src = plan && plan.volume ? { stored: 'stored', library: 'from your library folder', title: 'found by title', series: 'found by series name' }[plan.volume.source] : '';
  const issues = plan && plan.issues ? plan.issues : [];
  const added = issues.filter(i => i.isNew).length, owned = issues.filter(i => i.book_id).length;
  return <>
    <div className="le-tw-sum">
      {!plan ? (err ? null : <span className="le-muted">Asking Comic Vine…</span>)
        : plan.skipped ? <span>Comic Vine found no matching volume{plan.reason && plan.reason !== 'no matching volume' ? ` (${plan.reason})` : ''}. Enter a volume ID to use one.</span>
        : <span>Comic Vine volume <b>{plan.volume && plan.volume.name ? `${plan.volume.name}${plan.volume.start_year ? ` (${plan.volume.start_year})` : ''}` : ''}</b> · ID {plan.cvVolumeId} <span className="le-muted">· {src}</span></span>}
      {plan && <span className="le-tw-vol">
        {typing ? <form onSubmit={e => { e.preventDefault(); setTyping(false); setVol(draftVol.replace(/\D/g, '')); }}>
          <input className="le-input" value={draftVol} onChange={e => setDraftVol(e.target.value)} placeholder="Volume ID" autoFocus aria-label="Comic Vine volume ID" />
          <button className="btn btn-secondary" type="submit" disabled={!draftVol.replace(/\D/g, '')}>Preview</button>
        </form> : <>
          {vol !== '' && <button className="le-link" onClick={() => setVol('')} title="Ignore the stored volume and search Comic Vine with the run's title, parent series and issue range">Find the volume again</button>}
          <button className="le-link" onClick={() => { setDraftVol(''); setTyping(true); }}>Use another volume…</button>
        </>}
      </span>}
    </div>
    {err && <div className="le-notice error">{err}</div>}
    {plan && !plan.skipped && <div className="le-tw-list">
      <div className="le-tw-line"><b>{plural(issues.length + (plan.kept || 0), 'issue')}</b> after rebuilding: {issues.length} from Comic Vine ({plan.inRange} of {plan.total} in the volume match the issue range){plan.kept ? `, ${plan.kept} hand-matched kept` : ''}. {owned} of the Comic Vine issues are in your library.</div>
      <div className="le-tw-nums">
        {issues.map(i => <span key={i.cv_issue_id} className={`le-tw-num${i.book_id ? ' own' : ''}${i.isNew ? ' new' : ''}`} title={`${i.series_name} #${i.issue_number}${i.issue_title ? ` — ${i.issue_title}` : ''}${i.book_id ? ' · in your library' : ''}${i.isNew ? ' · new' : ''}`}>#{i.issue_number}</span>)}
      </div>
      <div className="le-tw-line le-muted">{added ? `${plural(added, 'issue')} new to this run (outlined). ` : 'No new issues. '}Filled: in your library.</div>
      {plan.removed && plan.removed.length > 0 && <div className="le-tw-line"><b>{plural(plan.removed.length, 'issue')} will be removed:</b> {plan.removed.map(r => r.issue).join(', ')}</div>}
      {plan.handMatched && plan.handMatched.length > 0 && <div className="le-tw-line le-muted">Hand-matched issues stay: {plan.handMatched.map(r => r.issue).join(', ')}{plan.merged ? ` (${plural(plan.merged, 'issue')} with the same number take this volume's Comic Vine issue and keep their file)` : ''}</div>}
    </div>}
    <div className="le-tw-foot">
      <span className="le-spacer" />
      <button className="le-link" onClick={onClose}>Cancel</button>
      {plan && !plan.skipped && <button className="btn btn-primary" disabled={busy} onClick={apply}>{busy ? 'Rebuilding…' : 'Rebuild'}</button>}
    </div>
  </>;
}

function Annotate({ id, rows, onNotes, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [on, setOn] = useState(new Set());
  const byId = useMemo(() => new Map(rows.filter(r => r.type !== 'section' && r.id != null).map(r => [String(r.id), r])), [rows]);
  useEffect(() => {
    let live = true;
    postJson(`/api/events/${id}/reannotate`, { preview: true }).then(d => {
      if (!live) return;
      const list = (d.annotations || []).filter(a => a.tier_note && byId.has(String(a.id)) && a.tier_note !== (byId.get(String(a.id)).note || ''));
      setData({ list, blank: (d.annotations || []).filter(a => !a.tier_note).length + (d.stats?.noMaterial || 0), dropped: d.stats?.mismatched || 0,
        cents: d.stats?.cents ?? null, model: d.stats?.model || null, ai_request: d.ai_request || null });
      setOn(new Set(list.map(a => String(a.id))));
    }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [id]);   // fetch once; rows only label the result
  const toggle = k => setOn(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const L = data ? data.list : [];
  return <>
    <div className="le-tw-sum">
      {!data ? (err ? null : <span className="le-muted">Writing notes from the solicits and tier reasons (under a minute)…</span>)
        : <span><b>{L.length ? plural(L.length, 'new note') : 'No new notes'}</b>{data.blank ? <span className="le-muted"> · {data.blank} left as they are (nothing to write from)</span> : null}{data.dropped ? <span className="le-muted"> · {data.dropped} dropped (reply didn’t match its issue)</span> : null}{data.cents != null ? <span className="le-muted" title="Estimate from the app's price table"> · ≈ {data.cents < 1 ? '<1' : Math.round(data.cents)}¢{data.model ? ` · ${data.model}` : ''}</span> : null}<AiInfo request={data.ai_request} /></span>}
    </div>
    {err && <div className="le-notice error">{err}</div>}
    {L.length > 0 && <div className="le-tw-list">
      {L.map(a => { const r = byId.get(String(a.id)); const k = String(a.id); return (
        <label key={k} className={`le-tw-row${on.has(k) ? ' on' : ''}`}>
          <input type="checkbox" checked={on.has(k)} onChange={() => toggle(k)} />
          <span className="le-tw-text">
            <span className="le-tw-issue">{r.label} <span className="le-muted">· {r.tier}</span></span>
            {r.note && <span className="le-muted le-tw-old">{r.note}</span>}
            <span>{a.tier_note}</span>
          </span>
        </label>); })}
    </div>}
    <div className="le-tw-foot">
      {L.length > 0 && <Ticks all={L.map(a => String(a.id))} on={on} set={setOn} />}
      {L.length > 0 && <button className="le-link" onClick={() => setOn(new Set(L.filter(a => !byId.get(String(a.id)).note).map(a => String(a.id))))}>Only empty notes</button>}
      <span className="le-spacer" />
      <button className="le-link" onClick={onClose}>{L.length ? 'Cancel' : 'Close'}</button>
      {L.length > 0 && <button className="btn btn-primary" disabled={!on.size} title="The notes go into your draft; Save keeps them."
        onClick={() => { const m = {}; for (const a of L) if (on.has(String(a.id))) m[a.id] = a.tier_note; onNotes(m); onClose(); }}>Put {plural(on.size, 'note')} in the draft</button>}
    </div>
  </>;
}

const TITLES = { rematch: 'Re-match to library', rebuild: 'Rebuild from Comic Vine', annotate: 'Write tier notes with AI' };
export default function ToolWindow({ tool, kind, id, rows, dirty, onClose, onRematched, onRebuilt, onNotes }) {
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return (
    <div className="le-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="le-dialog le-tw" role="dialog" aria-label={TITLES[tool]}>
        <div className="le-dialog-head"><b>{TITLES[tool]}</b><button className="le-x" onClick={onClose} aria-label="Close">×</button></div>
        {tool === 'rematch' && <Rematch kind={kind} id={id} onApplied={onRematched} onClose={onClose} />}
        {tool === 'rebuild' && <Rebuild id={id} dirty={dirty} onDone={onRebuilt} onClose={onClose} />}
        {tool === 'annotate' && <Annotate id={id} rows={rows} onNotes={onNotes} onClose={onClose} />}
      </div>
    </div>
  );
}

export const toolWindowCss = `
  .le-tw { width: min(940px, 94vw); max-height: 90vh; }
  .le-tw-sum { padding: 2px 16px 12px; font-size: 0.88rem; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
  .le-tw-vol { display: inline-flex; gap: 12px; align-items: center; }
  .le-tw-vol form { display: inline-flex; gap: 6px; }
  .le-tw-vol .le-input { width: 110px; }
  .le-tw-list { overflow-y: auto; border-top: 1px solid var(--border-subtle); min-height: 0; flex: 1; }
  .le-tw-row { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); cursor: pointer; font-size: 0.86rem; }
  .le-tw-row:hover { background: var(--bg-hover); }
  .le-tw-row input { flex: none; }
  .le-tw-row:not(.on) .le-tw-text { opacity: 0.6; }
  .le-tw-pair { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .le-tw-arrow { color: var(--text-muted); }
  .le-tw-cover { width: 72px; height: 108px; border-radius: 3px; box-shadow: 0 3px 10px rgba(0,0,0,0.35); cursor: zoom-in; overflow: hidden; background: var(--bg-surface, #222); display: grid; place-items: center; flex: none; }
  .le-tw-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .le-tw-cover.none { cursor: default; box-shadow: none; border: 1px dashed var(--border-subtle); background: transparent; color: var(--text-muted); font-size: 0.62rem; }
  .le-tw-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .le-tw-text .le-muted { font-size: 0.8rem; }
  .le-tw-issue { font-weight: 600; }
  .le-tw-weak { font-style: normal; font-weight: 400; font-size: 0.72rem; margin-left: 8px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border-subtle); color: var(--text-muted); }
  .le-tw-note { font-size: 0.8rem; color: var(--td-yellow, #f5c518); }
  .le-tw-old { text-decoration: line-through; }
  .le-tw-line { padding: 10px 16px 0; font-size: 0.86rem; }
  .le-tw-nums { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 16px 0; }
  .le-tw-num { font-size: 0.76rem; padding: 2px 7px; border-radius: 4px; background: var(--bg-surface, #222); color: var(--text-muted); border: 1px solid transparent; }
  .le-tw-num.own { background: color-mix(in srgb, var(--td-yellow) 16%, transparent); color: var(--text-primary); }
  .le-tw-num.new { border-color: var(--td-yellow, #f5c518); }
  .le-tw-list > .le-tw-line:last-child { padding-bottom: 12px; }
  .le-tw-foot { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-top: 1px solid var(--border-subtle); }
  .le-tw-peek { position: fixed; z-index: 80; object-fit: contain; border-radius: 6px; background: #111; box-shadow: 0 18px 50px rgba(0,0,0,0.65); pointer-events: none; }
  .le-tw-title { font-style: italic; }
  .le-tw-sec { padding: 14px 16px 8px; font-size: 0.82rem; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface, rgba(255,255,255,0.02)); }
  .le-tw-sec b { display: block; color: var(--text-primary); font-size: 0.86rem; margin-bottom: 2px; }
  .le-tw-row.look { cursor: default; padding-left: 46px; }
  .le-tw-file { font-size: 0.78rem; color: var(--text-muted); font-style: italic; }
  .le-tw-ticks { display: inline-flex; gap: 10px; align-items: baseline; font-size: 0.82rem; }
`;
