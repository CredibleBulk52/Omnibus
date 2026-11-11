// ─── AiUsage ──────────────────────────────────────────────────────
// Settings → AI Models → Usage (real use only). Compared per job (one description, one event,
// one Comic Book Guy answer — however many calls it took), with what the job
// achieved, Claude and OpenAI side by side. Costs are estimates from list
// prices, saved with each call (GET /api/ai/usage in backend/server.js). Opening a
// task row also lists its recent runs (GET /api/ai/usage/runs, 2026-10-23).
import { useConfirm } from '../components/Confirm';
import React, { useState, useEffect, useCallback } from 'react';

const SOURCE = 'live';   // real use only; test calls are not shown (2026-10-23)
const money = n => (!n ? '$0' : n < 0.001 ? '<$0.001' : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const num = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const secs = ms => (ms ? `${(ms / 1000).toFixed(1)} s` : '—');
const PROBLEM = { error: 'failed', bad_json: 'unreadable reply', truncated: 'cut short', cut_off: 'answer cut off', no_list: 'list missing', unknown: 'series not recognised', no_match: 'no match' };
const COLORS = { anthropic: '#d9a441', openai: '#5fb3a1', gemini: '#7f9cf5' };   // Gemini: web lookups only (2026-10-20)
const cell = { padding: '6px 8px', borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top', fontSize: 13 };
const head = { ...cell, borderTop: 'none', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12, textAlign: 'left' };

function Summary({ s }) {
  if (!s?.jobs) return <span className="a-muted">—</span>;
  return (
    <span>
      <b>{money(s.cost_per_job)}</b>/job · {s.jobs} job{s.jobs === 1 ? '' : 's'}
      {s.good_rate != null && <span style={{ color: s.good_rate >= 95 ? '#6fcf8a' : s.good_rate >= 80 ? '#e8b04a' : 'color-mix(in srgb, var(--td-red) 80%, white)' }}> · {s.good_rate}% good</span>}
      <div className="a-muted a-fs-12">{secs(s.median_ms)} typical · {secs(s.p90_ms)} slowest 10%</div>
    </span>
  );
}
const cents = n => { const c = (n || 0) * 100; return c >= 100 ? `$${(c / 100).toFixed(2)}` : c >= 10 ? `${c.toFixed(1)}¢` : c >= 0.01 ? `${c.toFixed(2)}¢` : c > 0 ? '<0.01¢' : '0¢'; };
const when = ms => { const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

// A task's runs in the chosen period, newest first, 20 at a time. A run is one piece of work
// someone started (a question, an event build); its other tasks are named under it.
function RunList({ task, days, source }) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const more = useCallback(offset => {
    setBusy(true);
    fetch(`/api/ai/usage/runs?task=${encodeURIComponent(task)}&days=${days}&source=${source}&offset=${offset}&limit=20`).then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setRuns(prev => (offset ? [...prev, ...d.runs] : d.runs)); setTotal(d.total); setError(''); })
      .catch(e => setError(e.message)).finally(() => setBusy(false));
  }, [task, days, source]);
  useEffect(() => { more(0); }, [more]);
  if (error) return <p className="form-hint a-err a-m0">{error}</p>;
  if (total == null) return <p className="form-hint a-m0">Loading runs…</p>;
  if (!total) return <p className="form-hint a-m0">No runs in this period.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <div className="a-muted a-fs-12 a-fw6" style={{ margin: '4px 0' }}>Runs ({total})</div>
      <table className="a-w100" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr><th style={head}>When</th><th style={head}>What</th><th style={head}>Model</th><th style={head}>Cost</th><th style={head}>Calls</th><th style={head}>Time</th><th style={head}>Result</th></tr></thead>
        <tbody>{runs.map((r, i) => (
          <tr key={`${r.at}-${i}`}>
            <td style={{ ...cell, whiteSpace: 'nowrap' }}>{when(r.at)}</td>
            <td style={cell}>{r.label || r.detail || '—'}{r.user && <span className="a-muted"> · {r.user}</span>}
              {r.other_tasks?.length > 0 && <div className="a-muted a-fs-12">Also used: {r.other_tasks.join(', ')}</div>}</td>
            <td style={cell}>{r.models.join(', ')}</td>
            <td style={{ ...cell, whiteSpace: 'nowrap' }}>{cents(r.cost)}{r.run_cost > r.cost + 1e-9 && <span className="a-muted"> of {cents(r.run_cost)}</span>}</td>
            <td style={cell}>{r.calls}{r.run_calls > r.calls && <span className="a-muted"> of {r.run_calls}</span>}</td>
            <td style={cell}>{secs(r.ms)}</td>
            <td style={cell} title={r.error || r.detail || ''}>{['ok', 'matched', 'written'].includes(r.outcome) ? <span className="a-ok">{r.failed ? `ok (${r.failed} retried)` : 'ok'}</span> : <span className="a-err">{PROBLEM[r.outcome] || r.outcome}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      {runs.length < total && <button className="adm-btn adm-btn-ghost a-mt-6" disabled={busy} onClick={() => more(runs.length)}>{busy ? 'Loading…' : `Show more (${total - runs.length} left)`}</button>}
    </div>
  );
}

// A short list under an opened model (its tasks) or provider (its models).
function BriefList({ first, rows }) {
  if (!rows?.length) return <p className="form-hint a-m0">Nothing in this period.</p>;
  return (
    <table className="a-w100" style={{ borderCollapse: 'collapse' }}>
      <thead><tr><th style={head}>{first}</th><th style={head}>Jobs</th><th style={head}>Cost</th><th style={head}>Good</th></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.key}><td style={cell}>{r.label}</td><td style={cell}>{r.jobs}</td><td style={cell}>{money(r.cost)}</td>
          <td style={cell}>{r.good_rate != null ? `${r.good_rate}%` : '—'}</td></tr>
      ))}</tbody>
    </table>
  );
}

function SideTable({ title, rows, first, note, compact, runs = null }) {
  const [open, setOpen] = useState(null);
  const expands = !!runs;   // only task rows open (to their runs)
  if (!rows?.length) return null;
  const g = rows.some(r => r.gemini?.jobs);   // the Google column appears once Gemini has run a job
  return (
    <div className="settings-card a-mt-12" style={{ overflowX: 'auto' }}>
      <div className="settings-card-title">{title}</div>
      {note && <p className="form-hint a-mt-0">{note}</p>}
      <table className="a-w100" style={{ borderCollapse: 'collapse', minWidth: 600 }}>
        <thead><tr><th style={head}>{first}</th><th style={head}>Claude</th><th style={head}>OpenAI</th>{g && <th style={head}>Google</th>}</tr></thead>
        <tbody>{rows.map(r => (
          <React.Fragment key={r.key}>
            <tr style={expands ? { cursor: 'pointer' } : undefined} onClick={expands ? () => setOpen(o => (o === r.key ? null : r.key)) : undefined}>
              <td style={cell}>{!expands ? r.label : compact ? <button className="adm-btn adm-btn-ghost" aria-expanded={open === r.key} onClick={e => { e.stopPropagation(); setOpen(o => o === r.key ? null : r.key); }}>{open === r.key ? '▾' : '▸'} {r.label}</button> : <>{open === r.key ? '▾' : '▸'} {r.label}</>}</td>
              <td style={cell}><Summary s={r.anthropic} /></td><td style={cell}><Summary s={r.openai} /></td>{g && <td style={cell}><Summary s={r.gemini} /></td>}
            </tr>
            {open === r.key && runs && (
              <tr><td colSpan={g ? 4 : 3} style={{ ...cell, borderTop: 'none', paddingTop: 0 }}><RunList task={r.key} days={runs.days} source={runs.source} /></td></tr>
            )}
          </React.Fragment>
        ))}</tbody>
      </table>
    </div>
  );
}

function Trend({ daily }) {
  if (!daily?.length) return null;
  const g = daily.some(d => d.gemini > 0);
  const max = Math.max(...daily.map(d => Math.max(d.anthropic, d.openai, d.gemini || 0)), 0.0001);
  const W = 640, H = 120, pad = 18, slot = (W - pad) / daily.length, bar = Math.max(2, Math.min(14, slot / (g ? 3 : 2) - 2));
  return (
    <div className="settings-card a-mt-12">
      <div className="settings-card-title">Cost per day</div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="a-w100" style={{ maxWidth: W, height: 'auto' }} role="img" aria-label="Estimated cost per day, Claude and OpenAI">
        {daily.map((d, i) => {
          const x = pad + i * slot + slot / 2;
          const h = v => Math.max(v > 0 ? 1 : 0, (v / max) * H);
          return (
            <g key={d.day}>
              <rect x={x - bar - 1} y={H - h(d.anthropic)} width={bar} height={h(d.anthropic)} fill={COLORS.anthropic}><title>{`${d.day} Claude ${money(d.anthropic)}`}</title></rect>
              <rect x={x + 1} y={H - h(d.openai)} width={bar} height={h(d.openai)} fill={COLORS.openai}><title>{`${d.day} OpenAI ${money(d.openai)}`}</title></rect>
              {g && <rect x={x + bar + 3} y={H - h(d.gemini || 0)} width={bar} height={h(d.gemini || 0)} fill={COLORS.gemini}><title>{`${d.day} Google ${money(d.gemini || 0)}`}</title></rect>}
              {(daily.length <= 14 || i % Math.ceil(daily.length / 14) === 0) && <text x={x} y={H + 14} fontSize="10" textAnchor="middle" fill="currentColor" opacity="0.6">{d.day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="form-hint a-m0">
        <span className="a-warn">■</span> Claude · <span className="a-ok">■</span> OpenAI{g && <> · <span className="a-info">■</span> Google</>} · highest day {money(max)}
      </div>
    </div>
  );
}

export default function AiUsage({ compact = false }) {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(0);            // 0 = since reset
  const [openProvider, setOpenProvider] = useState(null);
  const [openModel, setOpenModel] = useState(null);
  const [report, setReport] = useState('task');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    fetch(`/api/ai/usage?days=${days}&source=${SOURCE}`).then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); setData(d); setError(''); })
      .catch(e => setError(e.message));
  }, [days]);
  useEffect(() => { load(); }, [load]);
  const reset = async () => {
    if (!(await confirm({ message: 'Start usage counts fresh from now? Earlier records stay in the database but are no longer counted here.', title: 'Start counts fresh?', confirmLabel: 'Start fresh' }))) return;
    await fetch('/api/ai/usage/reset', { method: 'POST' }); load();
  };
  const card = (id, title, s, color) => (
    <div className="settings-card a-grow a-m0" style={{ minWidth: 220 }}>
      <div className="settings-card-title" style={{ color }}>{title}</div>
      {s?.jobs ? <><div className="a-fs-22 a-fw7">{money(s.cost)}</div><Summary s={s} />
        {data.providerModels?.[id]?.length > 0 && <div className="a-mt-6">
          <button className="adm-btn adm-btn-ghost" aria-expanded={openProvider === id} onClick={() => setOpenProvider(o => (o === id ? null : id))}>{openProvider === id ? '▾' : '▸'} Models ({data.providerModels[id].length})</button>
          {openProvider === id && <BriefList first="Model" rows={data.providerModels[id]} />}
        </div>}</> : <span className="form-hint">No jobs in this period.</span>}
    </div>
  );
  return (
    <div className="settings-section a-mt-24">
      <div className="settings-section-header a-flex a-ai-c a-gap-10 a-wrap">
        <div className="a-grow" style={{ minWidth: 220 }}>
          <h2 className="settings-section-title">Usage</h2>
          <div className="settings-section-sub">
            Compared per job (a description, an event, one answer), with how often the job came out right. Counting since {data?.since ? new Date(data.since).toLocaleString() : '…'}. Costs are estimates from list prices.
          </div>
        </div>
        <select aria-label="Usage period" className="form-input" style={{ width: 'auto' }} value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={0}>Since reset</option><option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
        </select>
        {compact && <select aria-label="Usage report" className="form-input" style={{ width: 'auto' }} value={report} onChange={e => setReport(e.target.value)}><option value="task">By task</option><option value="provider">By provider</option><option value="tier">By model category</option><option value="model">By model</option><option value="daily">Daily cost</option></select>}
        <button className="adm-btn adm-btn-ghost" onClick={load}>Refresh</button>
        <button className="adm-btn adm-btn-ghost" onClick={reset}>Reset counts</button>
      </div>
      {error && <p className="form-hint a-err">{error}</p>}
      {data && (
        <>
          {compact && <div className="ai-usage-summary"><div><span>Estimated cost</span><b>{money(data.total?.cost)}</b></div><div><span>Jobs</span><b>{num(data.total?.jobs)}</b></div><div><span>Usable results</span><b>{data.total?.good_rate != null ? `${data.total.good_rate}%` : '—'}</b></div></div>}
          {(!compact || report === 'provider') && <div className="a-flex a-gap-12 a-wrap" style={{ margin: '8px 0' }}>
            {card('anthropic', 'Claude', data.anthropic, COLORS.anthropic)}
            {card('openai', 'OpenAI', data.openai, COLORS.openai)}
            {data.gemini?.jobs > 0 && card('gemini', 'Google', data.gemini, COLORS.gemini)}
          </div>}
          {data.trials?.length > 0 && <p className="form-hint">Trial splits running: {data.trials.map(t => `${t.label} → ${Math.round(t.trial.share * 100)}% to ${t.trial.model.replace(/^openai:/, 'OpenAI ').replace(/^gemini:/, 'Google ')}`).join('; ')}.</p>}
          {!data.total?.jobs && <p className="form-hint">No AI jobs counted yet for this period.</p>}
          {(!compact || report === 'task') && <SideTable compact={compact} title="By task" first="Task" rows={data.byTask} runs={{ days, source: SOURCE }} note="Open a task for its recent runs. Good = a usable result." />}
          {(!compact || report === 'tier') && <SideTable compact={compact} title="By model category" first="Category" rows={data.byTier} />}
          {(!compact || report === 'daily') && <Trend daily={data.daily} />}
          {(!compact || report === 'model') && data.byModel?.length > 0 && (
            <div className="settings-card a-mt-12" style={{ overflowX: 'auto' }}>
              <div className="settings-card-title">By model</div>
              <table className="a-w100" style={{ borderCollapse: 'collapse', minWidth: 480 }}>
                <thead><tr><th style={head}>Model</th><th style={head}>Type</th><th style={head}>Usage</th></tr></thead>
                <tbody>{data.byModel.map(r => (
                  <React.Fragment key={r.key}>
                    <tr className="a-ptr" onClick={() => setOpenModel(o => (o === r.key ? null : r.key))}>
                      <td style={cell}><button className="adm-btn adm-btn-ghost" aria-expanded={openModel === r.key} onClick={e => { e.stopPropagation(); setOpenModel(o => (o === r.key ? null : r.key)); }}>{openModel === r.key ? '▾' : '▸'} {r.label}</button></td>
                      <td style={cell}>{{ fast: 'Fast', balanced: 'Balanced', deep: 'Most capable', premium: 'Premium' }[r.class] || ''}</td>
                      <td style={cell}><Summary s={r.all} /></td></tr>
                    {openModel === r.key && <tr><td colSpan={3} style={{ ...cell, borderTop: 'none', paddingTop: 0 }}><BriefList first="Task" rows={r.tasks} /></td></tr>}
                  </React.Fragment>
                ))}</tbody>
              </table>
            </div>
          )}
          {data.connectionTests?.count > 0 && <p className="form-hint a-mt-8">Not counted above: {data.connectionTests.count} connection test{data.connectionTests.count === 1 ? '' : 's'}{data.connectionTests.failed ? ` (${data.connectionTests.failed} failed)` : ''}.</p>}
        </>
      )}
    </div>
  );
}
