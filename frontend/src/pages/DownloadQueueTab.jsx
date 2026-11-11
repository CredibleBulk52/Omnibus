// Download Manager → Queue tab.
// Shows everything in flight: running downloads (GetComics, SABnzbd,
// qBittorrent) with live progress, GetComics jobs waiting for a slot, files
// being post-processed (issues and whole-series packs, with admin Resume), issues waiting out a retry delay, and failed issues.
// Also shows the download limits; admins can change them and manage the queue.
// Data comes from GET /api/downloads/queue (polled by the parent) plus the
// download progress stream for live byte counts.
import React, { useState, useEffect } from 'react';
import { useConfirm } from '../components/Confirm';

const C = {
  card: 'var(--adm-g1)', border: 'color-mix(in srgb, var(--om-base) 95%, white)', text: 'var(--om-text)', dim: 'var(--adm-muted)', faint: 'var(--adm-muted)',
  gold: 'var(--td-yellow)', green: '#4caa60', red: '#cc5050', teal: '#4caaaa', orange: '#e8a070',
};
const SOURCE = {
  getcomics:   { label: 'GetComics',   color: 'var(--td-yellow)' },
  sabnzbd:     { label: 'SABnzbd',     color: '#6aa8e8' },
  qbittorrent: { label: 'qBittorrent', color: '#4caaaa' },
};

const fmtBytes = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`;
const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
function fmtRel(iso) {
  if (!iso) return '';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const txt = abs < 1 ? 'less than a minute' : abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return mins >= 0 ? `in ${txt}` : `${txt} ago`;
}
const issueLabel = (series, num) => `${series || 'Unknown series'}${num != null && num !== '' ? ` #${num}` : ''}`;
// Held because the file names or tags another issue (2026-11-09): admins see the issue it
// was grabbed for and the file's name, and can View its cover, Process anyway or Delete file.
const HELD = /^(IDENTITY_REVIEW_REQUIRED|CV_ISSUE_MISMATCH|ANNUAL_MISMATCH)\b/;

// The held file's first page, fetched with the sign-in (an <img> cannot send it).
function HeldCover({ id, url: coverUrl }) {
  const [src, setSrc] = useState(null), [err, setErr] = useState('');
  useEffect(() => {
    let url = null, live = true;
    fetch(coverUrl || `/api/admin/downloads/issues/${encodeURIComponent(id)}/cover`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.blob(); })
      .then(b => { url = URL.createObjectURL(b); if (live) setSrc(url); })
      .catch(e => { if (live) setErr(e.message); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id, coverUrl]);
  return <div style={{ flexBasis: '100%' }}>
    {err ? <span className="a-fs-11" style={{ color: C.red }}>{err}</span>
      : src ? <img src={src} alt="Cover of the downloaded file" style={{ maxHeight: 240, maxWidth: '100%', border: `1px solid ${C.border}`, borderRadius: 4 }} />
      : <span className="a-faint a-fs-11">Loading cover…</span>}
  </div>;
}

// Pack files not filed (2026-11-10): what a pack left unfiled, by pack. Admins can View a
// file's cover, File it as an issue they choose (as Process anyway), or delete the pack file.
const LEFT_REASON = { unmatched: 'No matching issue', other_series: 'Named like another series', not_on_cv: 'Not on Comic Vine', failed: 'Failed' };
function FileAsIssue({ file, onDone, onCancel, toast }) {
  const [issues, setIssues] = useState(null), [pick, setPick] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  useEffect(() => {
    fetch(`/api/admin/pack-leftovers/${file.id}/issues`).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then(d => setIssues(d.issues || [])).catch(e => setErr(e.message));
  }, [file.id]);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/admin/pack-leftovers/${file.id}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueId: pick }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast(`"${file.name}" filed as ${issues.find(i => String(i.id) === String(pick))?.label || 'the chosen issue'}`, 'success'); onDone();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return <div className="a-flex a-gap-6 a-ai-c a-wrap" style={{ flexBasis: '100%' }}>
    {!issues ? <span className="a-faint a-fs-11">{err || 'Loading issues…'}</span> : !issues.length ? <span className="a-faint a-fs-11">Every issue of this series is already in the library.</span> : <>
      <select className="adm-input" value={pick} onChange={e => setPick(e.target.value)} aria-label="Issue to file it as" style={{ maxWidth: 320 }}>
        <option value="">Choose the issue…</option>
        {issues.map(i => <option key={i.id} value={i.id}>{i.label}{i.status !== 'wanted' ? ` (${i.status})` : ''}</option>)}
      </select>
      <SmallBtn disabled={!pick || busy} onClick={go} title="File it as this issue; its own name is set aside">{busy ? 'Filing…' : 'File'}</SmallBtn>
    </>}
    <SmallBtn onClick={onCancel}>Cancel</SmallBtn>
    {err && issues && <span className="a-fs-11" style={{ color: C.red }}>{err}</span>}
  </div>;
}
function PackLeftovers({ packs, admin, post, toast, reload }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(null), [view, setView] = useState(null), [all, setAll] = useState(() => new Set());
  return packs.map(p => {
    const label = `${p.series_name}${p.series_year ? ` (${p.series_year})` : ''}`;
    const shown = all.has(p.pack_id) ? p.files : p.files.slice(0, 10);
    return <div key={p.pack_id} className="a-mb-8">
      <div className="a-flex a-ai-c a-gap-8 a-mb-4 a-wrap">
        <Chip color={C.orange}>PACK</Chip>
        <span className="a-text2 a-fs-13">{label}</span>
        <span className="a-faint a-fs-11" style={{ overflowWrap: 'anywhere' }}>{p.file} · {p.files.length} file{p.files.length === 1 ? '' : 's'} not filed</span>
        {admin && <span className="a-ml-auto"><SmallBtn danger title="Delete the pack file from disk; files not filed go with it"
          onClick={async () => { if (await confirm({ title: 'Delete the pack?', message: `Delete "${p.file}" from disk? Its ${p.files.length} file${p.files.length === 1 ? '' : 's'} not filed go with it.`, confirmLabel: 'Delete', danger: true })) post(`/api/admin/series-packs/${p.pack_id}/delete-file`, `Pack "${p.file}" deleted`); }}>Delete pack</SmallBtn></span>}
      </div>
      {shown.map(f => (
        <Row key={f.id} accent={C.orange}>
          <span className="a-text2 a-fs-12" style={{ overflowWrap: 'anywhere' }}>{f.name}</span>
          <span className="a-faint a-fs-11" title={f.detail || undefined}>{LEFT_REASON[f.reason] || f.reason}</span>
          {admin && <span className="a-ml-auto a-flex a-gap-6">
            <SmallBtn title="Show the file's cover" onClick={() => setView(v => (v === f.id ? null : f.id))}>{view === f.id ? 'Hide' : 'View'}</SmallBtn>
            <SmallBtn title="Choose the issue this file is, and file it" onClick={() => setOpen(o => (o === f.id ? null : f.id))}>File as issue…</SmallBtn>
          </span>}
          {view === f.id && <HeldCover id={f.id} url={`/api/admin/pack-leftovers/${f.id}/cover`} />}
          {open === f.id && <FileAsIssue file={f} toast={toast} onCancel={() => setOpen(null)} onDone={() => { setOpen(null); reload(); }} />}
        </Row>
      ))}
      {p.files.length > shown.length && <SmallBtn onClick={() => setAll(s => new Set([...s, p.pack_id]))}>Show all {p.files.length}</SmallBtn>}
    </div>;
  });
}

const Section = ({ title, count, hint, children }) => count === 0 ? null : (
  <section className="dm-queue-section" id={`queue-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
    <div className="dm-queue-heading a-flex a-ai-b a-gap-8 a-mb-8">
      <h3 className="a-m0 a-fs-13 a-fw6 a-text a-upper" style={{ letterSpacing: '0.04em' }}>{title}</h3>
      {count != null && <span className="a-fs-11 a-muted">{count}</span>}
      {hint && <span className="a-fs-11 a-faint a-ml-auto">{hint}</span>}
    </div>
    {children}
  </section>
);
const Empty = ({ children }) => (
  <div className="a-faint a-fs-12" style={{ padding: '10px 14px', border: `1px dashed ${C.border}`, borderRadius: 6 }}>{children}</div>
);
const Chip = ({ color, children, solid }) => (
  <span className="dm-queue-chip a-fw7 a-nowrap" style={{ letterSpacing: '0.05em', padding: '2px 7px', borderRadius: 10, color: solid ? 'color-mix(in srgb, var(--om-base) 70%, black)' : color, background: solid ? color : `color-mix(in srgb, ${color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}>{children}</span>
);
const SmallBtn = ({ onClick, children, title, danger, disabled }) => (
  <button onClick={onClick} title={title} disabled={disabled} className="adm-btn dm-queue-action a-nowrap" style={{ background: 'transparent', border: `1px solid ${danger ? '#cc505055' : C.border}`, color: danger ? C.red : 'color-mix(in srgb, var(--om-text) 70%, var(--om-base))', borderRadius: 4, padding: '3px 9px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>{children}</button>
);
const Row = ({ children, accent }) => (
  <div className="dm-queue-row a-flex a-ai-c a-gap-10 a-mb-6 a-wrap" style={{ background: 'var(--adm-g1)', border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent || C.border}`, borderRadius: 6, padding: '9px 12px' }}>
    {children}
  </div>
);

// ── Limits panel ────────────────────────────────────────────────
function LimitsPanel({ data, admin, onSaved, toast }) {
  const { settings, limiter } = data;
  const [editing, setEditing] = useState(false);
  const [conc, setConc] = useState(settings.concurrency);
  const [gap, setGap] = useState(settings.startGapSec);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) { setConc(settings.concurrency); setGap(settings.startGapSec); } }, [settings, editing]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/downloads/queue/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concurrency: Number(conc), startGapSec: Number(gap) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast(`Download limits saved: ${d.concurrency} at once, ${d.startGapSec} s apart`, 'success');
      setEditing(false); onSaved();
    } catch (e) { toast(`Could not save limits: ${e.message}`, 'error'); }
    setSaving(false);
  };

  const cooling = !!limiter.cooldownUntil;
  const steps = settings.cooldownStepsMin.join(' → ') + ' min';
  const label = { color: C.dim, fontSize: 11 };
  const value = { color: C.text, fontSize: 13, fontWeight: 600 };
  const input = { width: 64, background: 'color-mix(in srgb, var(--om-base) 70%, black)', border: `1px solid ${C.border}`, color: C.text, borderRadius: 4, padding: '4px 6px', fontSize: 13 };

  return (
    <div style={{ background: C.card, border: `1px solid ${cooling ? '#cc505066' : C.border}`, borderRadius: 6, padding: '12px 14px' }}>
      <div className="a-flex a-ai-c a-gap-8 a-mb-10">
        <span className="a-fs-12 a-fw6 a-text">GetComics download limits</span>
        {cooling
          ? <Chip color={C.red}>PAUSED — RATE LIMITED</Chip>
          : <Chip color={C.green}>RUNNING {limiter.running} OF {settings.concurrency}</Chip>}
        {admin && !editing && <span className="a-ml-auto"><SmallBtn onClick={() => setEditing(true)}>Edit</SmallBtn></span>}
      </div>

      {!editing ? (
        <div className="a-grid a-gap-10" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div><div style={label}>Simultaneous downloads</div><div style={value}>{settings.concurrency}</div></div>
          <div><div style={label}>Spacing between starts</div><div style={value}>{settings.startGapSec} s</div></div>
          <div><div style={label}>Cooldown after a rate limit</div><div style={value}>{steps}</div></div>
          <div><div style={label}>Waiting for a slot</div><div style={value}>{limiter.waiting}</div></div>
        </div>
      ) : (
        <div className="a-flex a-gap-16 a-ai-e a-wrap">
          <label><div style={label}>Simultaneous downloads (1–{settings.concurrencyMax})</div>
            <input type="number" min={1} max={settings.concurrencyMax} value={conc} onChange={e => setConc(e.target.value)} style={input} /></label>
          <label><div style={label}>Spacing between starts, seconds (0–{settings.startGapMaxSec})</div>
            <input type="number" min={0} max={settings.startGapMaxSec} value={gap} onChange={e => setGap(e.target.value)} style={input} /></label>
          <div className="a-flex a-gap-6">
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
          {Number(conc) > 5 && (
            <div className="a-w100 a-warn a-fs-11">
              More than 5 at once will likely hit GetComics' rate limit unless your download host plan removes it.
            </div>
          )}
        </div>
      )}

      <div className="a-mt-10 a-fs-11 a-muted" style={{ lineHeight: 1.6 }}>
        {cooling ? (
          <span className="a-err">
            The download host refused a request. New GetComics downloads are paused until {fmtWhen(limiter.cooldownUntil)} ({fmtRel(limiter.cooldownUntil)}), strike {limiter.strikes}.
            Downloads already running continue.
          </span>
        ) : (
          <>The cooldown applies only when the host refuses a request (HTTP 429). Each refusal in a row lengthens it; any successful download resets it.</>
        )}
        {' '}SABnzbd and qBittorrent manage their own limits.
      </div>
    </div>
  );
}

// ── Schedule line ───────────────────────────────────────────────
function ScheduleLine({ data }) {
  const { scan, nextWeeklyRetry, settings } = data;
  return (
    <div className="a-flex a-gap-16 a-wrap a-fs-11 a-muted a-mt-10">
      {scan.running ? (
        <span className="a-accent">
          Wanted scan running — {scan.current ? `searching ${issueLabel(scan.current.seriesName, scan.current.issueNumber)}` : 'starting'} ({scan.done}/{scan.total || '…'})
        </span>
      ) : (
        <span>Next wanted scan: <b className="a-text2">{fmtWhen(scan.nextRun)}</b> ({fmtRel(scan.nextRun)})</span>
      )}
      <span>Next retry of failed issues: <b className="a-text2">{fmtWhen(nextWeeklyRetry)}</b> (every 2 days, up to {settings.failedRetryMaxWeeks} retries per issue)</span>
      {scan.lastRun && <span>Last scan: {fmtWhen(scan.lastRun)}</span>}
    </div>
  );
}

// ── Active download card (same look as the progress toast) ──────
function ActiveCard({ dl, admin, onCancel }) {
  const src = SOURCE[dl.source] || { label: dl.source, color: C.gold };
  const pct = dl.totalBytes > 0 ? Math.min(100, Math.round((dl.bytesReceived / dl.totalBytes) * 100)) : null;
  const statusText = {
    downloading: '↓ Downloading', complete: '✓ Complete', error: '✕ Error', cancelled: 'Cancelled',
    preparing: 'Preparing link', sent: `Sent to ${src.label}, not started`,
  }[dl.status] || dl.status;
  const color = dl.status === 'error' ? C.red : dl.status === 'complete' ? C.green : (dl.status === 'sent' || dl.status === 'preparing') ? C.dim : C.gold;
  const live = dl.status === 'downloading';
  return (
    <div className="dm-queue-active a-mb-6" style={{ background: 'var(--adm-g1)', border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, borderRadius: 6, padding: '10px 14px' }}>
      <div className="a-flex a-ai-c a-gap-8 a-mb-6 a-wrap">
        <span className="a-fs-11 a-fw7" style={{ color }}>{dl.cancelling ? 'Cancelling…' : statusText}</span>
        <Chip color={src.color}>{src.label.toUpperCase()}</Chip>
        <span className="dm-queue-download-title a-text2">{dl.kind === 'pack' ? `${dl.seriesName || 'Unknown series'} · whole-series pack` : issueLabel(dl.seriesName, dl.issueNumber)}</span>
        {admin && dl.source === 'getcomics' && live && !dl.cancelling && (
          <SmallBtn danger title={dl.kind === 'pack' ? 'Stop this pack download; the partial file is deleted' : 'Stop this download; the issue goes back to wanted'} onClick={() => onCancel(dl)}>Cancel download</SmallBtn>
        )}
      </div>
      {dl.filename && (
        <div className="a-text2 a-fs-11 a-mb-6 a-ovh a-ellip a-nowrap" title={dl.filename}>{dl.filename}</div>
      )}
      {dl.status === 'error' && <div className="a-err a-fs-10">{dl.error}</div>}
      {dl.stalledSince && live && (() => {
        const h = Math.max(0, (Date.now() - dl.stalledSince) / 3600000);
        const left = Math.max(0, (dl.stallLimitHours || 48) - h);
        return (
          <div className="a-warn a-fs-11 a-mb-6">
            Stalled — no download progress for {h < 1 ? 'under an hour' : `${Math.floor(h)} h`}.
            {' '}{left > 0 ? `Removed and retried from another source in ${Math.ceil(left)} h if it doesn't move.` : 'Being removed and retried from another source.'}
          </div>
        );
      })()}
      {(live || dl.status === 'complete') && (
        <>
          <div className="dm-queue-progress a-ovh a-mb-4" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} style={{ background: 'var(--adm-g0)', borderRadius: 3, height: 8 }}>
            <div style={{
              height: '100%', borderRadius: 3, transition: 'width 0.3s ease',
              background: dl.status === 'complete' ? C.green : C.gold,
              width: pct !== null ? `${pct}%` : '100%',
              animation: pct === null && dl.status !== 'complete' ? 'indeterminate 1.5s ease infinite' : 'none',
            }} />
          </div>
          <div className="a-faint a-fs-10 a-flex a-jc-b">
            <span>{fmtBytes(dl.bytesReceived)}{dl.totalBytes > 0 ? ` / ${fmtBytes(dl.totalBytes)}` : ''}</span>
            {pct !== null && <span>{pct}%</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main tab ────────────────────────────────────────────────────
export default function DownloadQueueTab({ data, error, reload, admin, toast }) {
  // Live byte counts from the progress stream, merged over the polled snapshot.
  const [live, setLive] = useState({});
  useEffect(() => {
    const es = new EventSource('/api/downloads/progress/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'snapshot') {
          const m = {}; (msg.downloads || []).forEach(d => { m[d.id] = d; }); setLive(m);
        } else if (msg.type === 'download') {
          const dl = msg.download;
          setLive(prev => {
            const next = { ...prev };
            if (dl.status === 'removed') delete next[dl.id]; else next[dl.id] = { ...prev[dl.id], ...dl };
            return next;
          });
        }
      } catch {}
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);
  // Re-render each 30 s so "in 12 min" text stays current between polls.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 30000); return () => clearInterval(t); }, []);

  const confirm = useConfirm();
  const [viewing, setViewing] = useState(() => new Set());
  const toggleView = id => setViewing(v => { const n = new Set(v); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const post = async (url, okMsg) => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (okMsg) toast(okMsg, 'success');
    } catch (e) { toast(e.message, 'error'); }
    reload();
  };

  if (!data) {
    return <Empty>{error ? `Could not load the queue: ${error}` : 'Loading queue…'}{error && <button className="adm-btn" onClick={reload}>Retry</button>}</Empty>;
  }

  const active = data.active.map(a => {
    const l = live[a.id];
    return l ? { ...a, bytesReceived: l.bytesReceived, totalBytes: l.totalBytes, status: l.status || a.status, error: l.error || a.error, cancelling: l.cancelling || a.cancelling,
                 stalledSince: l.stalledSince !== undefined ? l.stalledSince : a.stalledSince, stallLimitHours: l.stallLimitHours || a.stallLimitHours } : a;
  });
  const order = { downloading: 0, complete: 1, error: 2, cancelled: 3, preparing: 4, sent: 5 };
  active.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  const recent = active.filter(d => ['complete', 'error', 'cancelled'].includes(d.status));
  const inFlight = active.filter(d => !['complete', 'error', 'cancelled'].includes(d.status));
  const processingCount = data.processing.length + (data.processingPacks || []).length + (data.failedPacks || []).length;
  const summaries = [['In progress', inFlight.length, 'downloading'], ['Queued', data.queued.length, 'queued'], ['Processing', processingCount, 'post-processing'], ['Retry delay', data.waiting.length, 'waiting-to-retry'], ['Failed issues', data.failedTotal, 'failed']];
  return (
    <div className="dm-queue">
      {error && <div className="dm-queue-warning" role="alert">Queue update failed: {error}. Showing the last available snapshot. <button className="adm-btn" onClick={reload}>Retry</button></div>}
      <nav className="dm-queue-overview" aria-label="Queue sections">
        {summaries.map(([label, count, target]) => count === 0 ? <div key={target} className="dm-queue-zero"><strong>0</strong><span>{label}</span></div> : <a key={target} href={`#queue-${target}`} onClick={e => { e.preventDefault(); document.getElementById(`queue-${target}`)?.scrollIntoView({block:'start'}); }} className={target === 'failed' && count > 0 ? 'has-failures' : ''}><strong>{count}</strong><span>{label}</span></a>)}
      </nav>
      <details className="dm-queue-settings" open={data.limiter.cooldownUntil ? true : undefined}>
        <summary>Download limits & schedule {data.limiter.cooldownUntil && <span className="a-err"> · GetComics rate limited</span>}</summary>
        <LimitsPanel data={data} admin={admin} onSaved={reload} toast={toast} />
        <ScheduleLine data={data} />
      </details>

      {summaries.every(([,count]) => !count) && !(data.packLeftovers || []).length && !recent.some(d => d.status === 'error') && <div className="dm-queue-clear" role="status"><strong>Queue is clear</strong><span>No downloads, processing jobs, or retries need attention.</span></div>}
      <Section title="Downloading" count={inFlight.length} hint="Updates live">
        {inFlight.length
          ? inFlight.map(dl => <ActiveCard key={dl.id} dl={dl} admin={admin}
              onCancel={(d) => post(`/api/downloads/${encodeURIComponent(d.id)}/cancel`, `Cancelling ${d.kind === 'pack' ? `${d.seriesName || 'the'} pack` : issueLabel(d.seriesName, d.issueNumber)}`)} />)
          : <Empty>Nothing is downloading right now.</Empty>}
      </Section>

      {recent.length > 0 && <details className="dm-queue-recent" open={recent.some(d => d.status === 'error') ? true : undefined}><summary>Recent transfers · {recent.length}{recent.some(d => d.status === 'error') && <span className="a-err"> · Transfer failed</span>}</summary><p className="a-muted">Transfer completion is separate from library processing below.</p>{recent.map(dl => <ActiveCard key={dl.id} dl={dl} admin={false} />)}</details>}
      <Section title="Queued" count={data.queued.length} hint="GetComics downloads waiting for a free slot">
        {data.queued.length ? data.queued.map(q => (
          <Row key={q.jobId} accent={C.gold}>
            <Chip color={C.gold} solid={q.position === 1}>{q.position === 1 ? 'NEXT' : `QUEUED #${q.position}`}</Chip>
            <span className="a-text2 a-fs-13">{issueLabel(q.seriesName, q.issueNumber)}</span>
            <span className="a-faint a-fs-11">{q.host} · queued {fmtRel(q.queuedAt)}</span>
            {admin && (
              <span className="a-ml-auto a-flex a-gap-6">
                {q.position > 1 && <SmallBtn title="Download this one next" onClick={() => post(`/api/downloads/queue/${q.jobId}/top`)}>Move to next</SmallBtn>}
                <SmallBtn danger title="Take it out of the queue. The issue goes back to wanted and is tried again at the next scan."
                  onClick={() => post(`/api/downloads/queue/${q.jobId}/remove`, `${issueLabel(q.seriesName, q.issueNumber)} removed from the queue`)}>✕ Remove</SmallBtn>
              </span>
            )}
          </Row>
        )) : <Empty>No downloads waiting for a slot.</Empty>}
      </Section>

      {(
        <Section title="Post-processing" count={data.processing.length + (data.processingPacks || []).length + (data.failedPacks || []).length}
          hint="Downloaded; being renamed, tagged and moved">
          {processingCount === 0 && <Empty>No files being processed.</Empty>}
          {data.metadataHold > 0 && (
            <div className="a-warn a-fs-12 a-mb-6">
              Interrupted metadata work is holding the library. Items here resume on their own once it is recovered.
            </div>
          )}
          {(data.processingPacks || []).map(p => (
            <Row key={`pack-${p.id}`} accent={C.green}>
              <Chip color={p.retry_after ? C.orange : C.green}>PACK · {p.retry_after ? 'WAITING' : p.status.toUpperCase()}</Chip>
              <span className="a-text2 a-fs-13">{p.series_name || 'Unknown series'} (whole series)</span>
              {p.retry_after && <span className="a-faint a-fs-11">{p.fail_reason || 'Comic Vine hourly limit'} · resumes {fmtRel(p.retry_after)}</span>}
              {admin && (p.status === 'processing' || p.retry_after) && (
                <span className="a-ml-auto">
                  <SmallBtn title="Start this pack's processing again (use if it is stuck after a restart)"
                    onClick={() => post(`/api/admin/series-packs/${p.id}/reprocess`, `${p.series_name} pack queued again`)}>↻ Resume</SmallBtn>
                </span>
              )}
              {p.file && <span className="a-faint a-fs-11" style={{ flexBasis: '100%' }}>{p.file}</span>}
            </Row>
          ))}
          {(data.failedPacks || []).map(p => (
            <Row key={`fpack-${p.id}`} accent={C.red}>
              <Chip color={C.red}>PACK · FAILED</Chip>
              <span className="a-text2 a-fs-13">{p.series_name || 'Unknown series'} (whole series)</span>
              <span className="a-faint a-fs-11">{p.failed_at ? fmtRel(p.failed_at) : ''}</span>
              {admin && (
                <span className="a-ml-auto">
                  <SmallBtn title="Process the downloaded pack again without downloading it"
                    onClick={() => post(`/api/admin/series-packs/${p.id}/reprocess`, `${p.series_name} pack queued again`)}>↻ Resume</SmallBtn>
                </span>
              )}
              {p.fail_reason && <span className="a-fs-11" style={{ color: '#a07070', flexBasis: '100%' }}>
                {p.fail_reason === 'LIBRARY_RECOVERY_REQUIRED' ? 'Held by interrupted metadata work; resumes on its own once recovered' : p.fail_reason}
              </span>}
            </Row>
          ))}
          {data.processing.map(p => {
            const held = HELD.test(p.last_fail_reason || '');
            const label = issueLabel(p.series_name, p.issue_number);
            return (
            <Row key={p.id} accent={held ? C.orange : C.green}>
              <Chip color={held ? C.orange : C.green}>{held ? 'HELD' : p.status.toUpperCase()}</Chip>
              <span className="a-text2 a-fs-13">{held ? issueLabel(`${p.series_name}${p.series_year ? ` (${p.series_year})` : ''}`, p.issue_number) : label}</span>
              {p.retry_after && !held && <span className="a-faint a-fs-11">next try {fmtRel(p.retry_after)}</span>}
              {admin && (
                <span className="a-ml-auto a-flex a-gap-6">
                  {/^ARCHIVE_DAMAGED/.test(p.last_fail_reason || '') && (
                    <SmallBtn title="Add it anyway, leaving out the pages that cannot be read"
                      onClick={() => post(`/api/admin/downloads/issues/${p.id}/convert-anyway`, `${label}: converting with the readable pages`)}>Convert anyway</SmallBtn>
                  )}
                  {held && <>
                    <SmallBtn title="Show the file's cover" onClick={() => toggleView(p.id)}>{viewing.has(p.id) ? 'Hide' : 'View'}</SmallBtn>
                    <SmallBtn title="File it as this issue"
                      onClick={async () => { if (await confirm({ title: 'Process anyway?', message: `File "${p.file || 'this download'}" as ${label}? Its own name and tags are set aside.`, confirmLabel: 'Process anyway' })) post(`/api/admin/downloads/issues/${p.id}/process-anyway`, `${label}: processing anyway`); }}>Process anyway</SmallBtn>
                    <SmallBtn danger title="Delete the downloaded file; the issue goes back to wanted"
                      onClick={async () => { if (await confirm({ title: 'Delete the file?', message: `Delete "${p.file || 'this download'}" from disk? ${label} goes back to wanted.`, confirmLabel: 'Delete', danger: true })) post(`/api/admin/downloads/issues/${p.id}/delete-file`, `${label}: file deleted, back to wanted`); }}>Delete file</SmallBtn>
                  </>}
                  <SmallBtn title="Run post-processing for this issue now"
                    onClick={() => post(`/api/admin/downloads/issues/${p.id}/resume`, `${label} resumed`)}>↻ Resume</SmallBtn>
                </span>
              )}
              {held
                ? <span className="a-faint a-fs-11" style={{ flexBasis: '100%', overflowWrap: 'anywhere' }} title={p.last_fail_reason}>File: {p.file || 'unknown'}</span>
                : p.last_fail_reason && <span className="a-faint a-fs-11" style={{ flexBasis: '100%' }}>{p.last_fail_reason}</span>}
              {held && viewing.has(p.id) && <HeldCover id={p.id} />}
            </Row>
            );
          })}
        </Section>
      )}

      <Section title="Pack files not filed" count={(data.packLeftovers || []).reduce((n, p) => n + p.files.length, 0)}
        hint="Left in a pack: no matching issue, named like another series, or failed">
        <PackLeftovers packs={data.packLeftovers || []} admin={admin} post={post} toast={toast} reload={reload} />
      </Section>

      <Section title="Waiting to retry" count={data.waiting.length} hint="Held back by a retry delay, then picked up by the next scan">
        {data.waiting.length ? data.waiting.map(w => (
          <Row key={w.id} accent={C.orange}>
            <Chip color={C.orange}>RETRY {fmtRel(w.retry_after).toUpperCase()}</Chip>
            <span className="a-text2 a-fs-13">{issueLabel(w.series_name, w.issue_number)}</span>
            {w.last_fail_reason && <span className="a-faint a-fs-11" style={{ flexBasis: '100%' }}>{w.last_fail_reason}</span>}
          </Row>
        )) : <Empty>No issues are waiting out a retry delay.</Empty>}
      </Section>

      <Section title="Failed" count={data.failedTotal} hint={data.failedTotal > data.failed.length ? `Newest ${data.failed.length} shown` : 'Newest first'}>
        {data.failed.length ? data.failed.map(f => (
          <Row key={f.id} accent={C.red}>
            <Chip color={C.red}>FAILED</Chip>
            <span className="a-text2 a-fs-13">{issueLabel(f.series_name, f.issue_number)}</span>
            <span className="a-faint a-fs-11">
              {f.failed_at ? fmtRel(f.failed_at) : 'date unknown'} · {f.fail_count || 0} source{f.fail_count === 1 ? '' : 's'} tried ·
              retries {f.weekly_retries}/{data.settings.failedRetryMaxWeeks}
            </span>
            {admin && (
              <span className="a-ml-auto">
                <SmallBtn title="Clear its failed sources and set it back to wanted"
                  onClick={() => post(`/api/monitor/series/${f.series_id}/issues/${f.id}/reset`, `${issueLabel(f.series_name, f.issue_number)} reset to wanted`)}>Reset to wanted</SmallBtn>
              </span>
            )}
            {f.last_fail_reason && <span className="a-fs-11" style={{ color: '#a07070', flexBasis: '100%' }}>{f.last_fail_reason}</span>}
          </Row>
        )) : <Empty>No failed issues.</Empty>}
      </Section>
    </div>
  );
}
