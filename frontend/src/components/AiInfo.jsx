import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAdmin, useViewAsUser } from '../App';
import { useAppearance } from './appearance';
import '../aiInfo.css';

// ─── AI cost and models, for admins (diagnostics; 2026-11-09) ─────
// <AiInfo request|run|job={id} />: a small ⓘ next to something AI made. It opens the
// details of that piece of work: total cost, models, then each call (what it was for,
// model, input new / cached / written, output and thinking, web searches, time, cost).
// <AiActivity />: the top-bar feed of the latest AI runs, for work nobody is watching.
// Shown to admins only, not while viewing as a user, and not when switched off on the
// Appearance page. Costs are estimates: tokens × the app's price list.

export function useAiInfoOn() {
  const { aiInfo } = useAppearance();
  const asUser = useViewAsUser();
  return isAdmin() && !asUser && aiInfo !== false;
}

export const fmtCost = d => {
  const c = (d || 0) * 100;
  if (c >= 100) return `$${(c / 100).toFixed(2)}`;
  if (c === 0) return '0¢';
  return `${c < 0.01 ? '<0.01' : c < 1 ? c.toFixed(2) : c < 10 ? c.toFixed(1) : Math.round(c)}¢`;
};
const fmtTok = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const fmtMs = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

// The details of one piece of work. query: e.g. "request=…".
export function AiDetails({ query, hideLabel = false }) {
  const [d, setD] = useState(null), [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    fetch(`/api/admin/ai/details?${query}`)
      .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`); return b; })
      .then(setD).catch(e => setErr(e.message));
  }, [query]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="aii-note aii-err">{err}</div>;
  if (!d) return <div className="aii-note">Loading…</div>;
  if (!d.calls.length) return <div className="aii-note">No AI calls recorded for this yet. <button type="button" className="aii-link" onClick={load}>Refresh</button></div>;
  const t = d.totals;
  return (
    <div className="aii-details">
      {d.label && !hideLabel && <div className="aii-label">{d.label}</div>}
      <div className="aii-total"><b>{fmtCost(t.cost)}</b> · {d.models.join(' + ')} · {t.calls} call{t.calls === 1 ? '' : 's'}{t.failed ? <span className="aii-err"> · {t.failed} failed</span> : null} · {fmtMs(d.elapsed_ms || t.ms)}</div>
      <div className="aii-tokens">Input {fmtTok(t.input_new)} new · {fmtTok(t.input_cached)} cached{t.input_written ? ` · ${fmtTok(t.input_written)} written` : ''} · Output {fmtTok(t.output)}{t.thinking ? ` (thinking ~${fmtTok(t.thinking)})` : ''}{t.web_searches ? ` · ${t.web_searches} web search${t.web_searches === 1 ? '' : 'es'}` : ''}</div>
      <div className="aii-table-wrap">
        <table className="aii-table">
          <thead><tr><th>For</th><th>Model</th><th title="New input tokens">In</th><th title="Cached input tokens">Cached</th><th title="Input written to the cache">Written</th><th>Out</th><th>Web</th><th>Time</th><th>Cost</th></tr></thead>
          <tbody>
            {d.calls.map((c, i) => (
              <tr key={i} className={c.ok ? '' : 'aii-failed'} title={c.error || undefined}>
                <td>{c.purpose}</td><td>{c.model}</td><td>{fmtTok(c.input_new)}</td><td>{fmtTok(c.input_cached)}</td><td>{c.input_written ? fmtTok(c.input_written) : '–'}</td>
                <td>{fmtTok(c.output)}{c.thinking ? <small> ({fmtTok(c.thinking)} th.)</small> : null}</td><td>{c.web_searches || '–'}</td><td>{fmtMs(c.ms)}</td><td>{fmtCost(c.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="aii-foot">Estimates: tokens × the app's price list. <button type="button" className="aii-link" onClick={load}>Refresh</button></div>
    </div>
  );
}

// A panel drawn on the page body under its button (inside cards it would be cut off).
function Popover({ anchor, onClose, children, wide }) {
  const panel = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(); if (!r) return;
      const w = Math.min(wide ? 640 : 560, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      const top = r.bottom + 6;
      setPos({ top, left, width: w, maxHeight: Math.max(160, window.innerHeight - top - 8) });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, wide]);
  useEffect(() => {
    const out = e => { if (!panel.current?.contains(e.target) && !anchor.current?.contains(e.target)) onClose(); };
    const esc = e => { if (e.key === 'Escape') { onClose(); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [anchor, onClose]);
  return createPortal(<div className="aii-pop" ref={panel} role="dialog" aria-label="AI cost and models" style={pos || { visibility: 'hidden' }}>{children}</div>, document.body);
}

export function AiInfo({ request, run, job, className = '' }) {
  const on = useAiInfoOn();
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const query = request ? `request=${encodeURIComponent(request)}` : run ? `run=${encodeURIComponent(run)}` : job ? `job=${encodeURIComponent(job)}` : null;
  if (!on || !query) return null;
  return <>
    <button type="button" ref={btn} className={`aii-btn ${className}`} aria-expanded={open} aria-label="AI cost and models"
      title="AI cost and models" onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>ⓘ</button>
    {open && <Popover anchor={btn} onClose={close}><AiDetails query={query} /></Popover>}
  </>;
}

const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

// Top bar: the latest AI runs, refreshed every 5 s while open.
export function AiActivity() {
  const on = useAiInfoOn();
  const [open, setOpen] = useState(false), [runs, setRuns] = useState(null), [err, setErr] = useState(''), [shown, setShown] = useState(null);
  const btn = useRef(null);
  const close = useCallback(() => { setOpen(false); setShown(null); }, []);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const load = () => fetch('/api/admin/ai/recent?limit=20')
      .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`); return b; })
      .then(b => { if (live) { setRuns(b.runs || []); setErr(''); } }).catch(e => live && setErr(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [open]);
  if (!on) return null;
  return <>
    <button type="button" ref={btn} className="aii-activity-btn" aria-expanded={open} aria-label="AI activity" title="AI activity: the latest AI runs, with cost and models"
      onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>AI</button>
    {open && <Popover anchor={btn} onClose={close} wide>
      <div className="aii-activity">
        <div className="aii-activity-head">AI activity <small>last 24 hours · updates every 5 s</small></div>
        {err && <div className="aii-note aii-err">{err}</div>}
        {!runs ? <div className="aii-note">Loading…</div> : !runs.length ? <div className="aii-note">No AI used in the last 24 hours.</div> : (
          <ul className="aii-runs">
            {runs.map(r => (
              <li key={r.key} className={shown === r.key ? 'open' : ''}>
                <button type="button" className="aii-run" onClick={() => setShown(s => (s === r.key ? null : r.key))} aria-expanded={shown === r.key}>
                  <span className="aii-run-label">{r.label || 'AI call'}</span>
                  <span className="aii-run-meta">{fmtCost(r.cost)} · {r.models.join(' + ')} · {r.calls} call{r.calls === 1 ? '' : 's'}{r.failed ? ` · ${r.failed} failed` : ''} · {ago(r.last)}</span>
                </button>
                {shown === r.key && <AiDetails query={`${r.kind}=${encodeURIComponent(r.id)}`} hideLabel />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>}
  </>;
}
