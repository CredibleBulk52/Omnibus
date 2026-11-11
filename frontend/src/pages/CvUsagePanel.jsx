// Comic Vine usage panel (Comic Vine admin page).
// Shows Omnibus's own Comic Vine requests over the rolling hour, per resource,
// from GET /api/admin/cv-usage. Comic Vine allows 200 requests per resource per
// hour; background jobs stop at the background cap so clicks still work.
// Cross-check against https://comicvine.gamespot.com/api/ while logged in.
import React, { useState, useEffect, useCallback } from 'react';

const fmtClock = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
const fmtIn = (ms) => {
  if (!ms) return '';
  const m = Math.round((ms - Date.now()) / 60000);
  return m <= 0 ? 'now' : `in ${m} min`;
};
const fmtAgo = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export default function CvUsagePanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/cv-usage');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d); setErr(null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const box = { background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '14px 16px', marginBottom: 20 };
  const muted = { color: 'var(--text-muted)', fontSize: '0.78rem' };
  if (!data) return <div style={box}><span style={muted}>{err ? `Comic Vine usage unavailable: ${err}` : 'Loading Comic Vine usage…'}</span></div>;

  const { limits, resources } = data;
  const paused = resources.filter(r => r.pausedUntil);
  const barColor = (r) => r.pausedUntil ? '#cc5050' : r.used >= limits.background ? '#e8a070' : r.used >= limits.perHour * 0.6 ? '#f5c518' : '#4caa60';

  return (
    <div style={box}>
      <div className="a-flex a-ai-b a-gap-10 a-wrap a-mb-10">
        <span className="a-text a-fw6 a-fs-15">Comic Vine usage — current hour</span>
        <span style={muted}>
          {data.totalLastHour} requests · limit {limits.perHour} per resource per hour · background jobs stop at {limits.background}, processing downloads at {limits.arrival ?? limits.interactive},
          clicks at {limits.interactive} · at least {limits.spacingMs / 1000} s between requests ({(limits.bgSpacingMs || limits.spacingMs) / 1000} s for background jobs)
          {data.cache ? ` · ${data.cache.hits} repeat requests answered from cache since the server started (${data.cache.ttlMin} min cache)` : ''}
        </span>
        <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer" style={{ ...muted, marginLeft: 'auto', color: 'var(--color-accent)' }}>
          Compare with Comic Vine's counter ↗
        </a>
      </div>

      {paused.length > 0 && (
        <div className="a-err a-fs-13 a-mb-10">
          Paused after a refusal: {paused.map(p => `${p.resource} until ${fmtClock(p.pausedUntil)} (${p.pauseReason})`).join(' · ')}
        </div>
      )}

      {resources.length === 0 ? (
        <div style={muted}>No Comic Vine requests in the last hour.</div>
      ) : (
        <div className="a-grid a-ai-c" style={{ gridTemplateColumns: 'minmax(90px,140px) 1fr auto', gap: '6px 12px' }}>
          {resources.map(r => (
            <React.Fragment key={r.resource}>
              <span className="a-text a-fs-13 a-mono">{r.resource}</span>
              <div className="a-rel a-ovh" style={{ height: 8, background: 'var(--bg-base)', borderRadius: 4 }}
                   title={`${r.used} of ${limits.perHour}`}>
                <div style={{ width: `${Math.min(100, (r.used / limits.perHour) * 100)}%`, height: '100%', background: barColor(r) }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${(limits.background / limits.perHour) * 100}%`, width: 1, background: 'var(--text-muted)' }}
                     title={`Background jobs stop at ${limits.background}`} />
              </div>
              <span style={{ ...muted, whiteSpace: 'nowrap' }}>
                <b className="a-text">{r.used}</b>/{limits.perHour}
                {' '}· {r.interactive || 0} clicks, {r.arrival || 0} downloads, {r.background || 0} background
                {r.refused ? ` · ${r.refused} refused` : ''}
                {r.nextFreeAt ? ` · resets to 0 ${fmtIn(r.nextFreeAt)} (${fmtClock(r.nextFreeAt)})` : ''}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      <button onClick={() => setOpen(o => !o)} className="a-mt-12 a-ptr a-fs-13" style={{ background: 'none', border: 'none', color: 'var(--color-accent)', padding: 0 }}>
        {open ? '▾ Hide details' : '▸ What used it, recent requests'}
      </button>

      {open && (
        <div className="a-grid a-gap-16 a-mt-10" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <div>
            <div style={{ ...muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>By job, last hour</div>
            {data.callers.length === 0 ? <div style={muted}>None.</div> : data.callers.map((c, i) => (
              <div key={i} className="a-flex a-gap-8 a-fs-12" style={{ padding: '2px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="a-text a-ta-r" style={{ minWidth: 28 }}>{c.n}</span>
                <span className="a-mono a-text2">{c.resource}</span>
                <span style={{ color: c.lane === 'interactive' ? '#6aa8e8' : 'var(--text-muted)' }}>{c.lane === 'interactive' ? 'click' : 'bg'}</span>
                <span className="a-text2 a-ovh a-ellip a-nowrap" title={c.caller}>{c.caller}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{ ...muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Most recent requests</div>
            {data.recent.length === 0 ? <div style={muted}>None.</div> : data.recent.map((r, i) => (
              <div key={i} className="a-flex a-gap-8 a-fs-12" style={{ padding: '2px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="a-muted" style={{ minWidth: 52 }}>{fmtAgo(r.ts)}</span>
                <span className="a-mono a-text2" style={{ minWidth: 70 }}>{r.resource}</span>
                <span style={{ color: r.status === '200' ? '#4caa60' : r.status === 'pending' ? 'var(--text-muted)' : 'color-mix(in srgb, var(--td-red) 70%, white)', minWidth: 52 }}>{r.status}</span>
                <span className="a-text2 a-ovh a-ellip a-nowrap" title={r.caller}>{r.caller}</span>
              </div>
            ))}
            {data.refusals.length > 0 && (
              <div className="a-mt-10 a-fs-12 a-err">
                Refusals (last 2 h): {data.refusals.map(f => `${f.resource} ${fmtAgo(f.ts)}`).join(' · ')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
