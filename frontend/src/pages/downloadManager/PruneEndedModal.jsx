import Modal from '../../components/Modal';
import React, { useState, useEffect } from 'react';
import { authHeader } from '../../App';

// ─── Styles ───────────────────────────────────────────────────────
// ── Prune ended series (admin) ─────────────────────────────────────
// Lists ended monitored series; ticked by default unless something is still
// wanted or it is the annual of an ongoing series. Removing only drops the
// download tracking (as Remove does); files and the library stay. A series
// can be brought back with + Add Series.
export function PruneEndedModal({ onClose, onDone }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    fetch('/api/monitor/prune/candidates', { headers: authHeader() }).then(r => r.json()).then(d => {
      if (d.error) throw new Error(d.error);
      setData(d); setSel(new Set(d.candidates.filter(c => c.suggested).map(c => c.id)));
    }).catch(e => setError(e.message));
  }, []);
  const rows = (data?.candidates || []).filter(c => !q || `${c.name} ${c.year} ${c.publisher || ''}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = id => setSel(s0 => { const s1 = new Set(s0); s1.has(id) ? s1.delete(id) : s1.add(id); return s1; });
  const chosen = (data?.candidates || []).filter(c => sel.has(c.id));
  const annuals = chosen.reduce((t, c) => t + (c.annuals || 0), 0);
  const run = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/monitor/prune', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ ids: [...sel] }) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Failed (${r.status})`);
      onDone(d);
    } catch (e) { setError(e.message); setBusy(false); setConfirm(false); }
  };
  const cell = { padding: '5px 8px', borderTop: '1px solid color-mix(in srgb, var(--om-base) 95%, white)', fontSize: 13, color: 'var(--om-text)' };
  return (
    <Modal title="✂ Prune ended series" onClose={onClose} width={760} closeOnBackdrop={false}>
      <div className="adm-modal-content">
        <div className="a-text2 a-fs-13" style={{ padding: '12px 20px', borderBottom: '1px solid var(--adm-g3)', lineHeight: 1.45 }}>
          Removes ended series from the download manager: their issue tracking and linked annual series. <b className="a-text">Files and the library are not touched</b>;
          the series stays in your library and on its series page. Bring one back any time with + Add Series.
          Unticked by default: series with wanted issues, and annuals of a series that is still ongoing.
        </div>
        {!data ? <div className="a-text2" style={{ padding: 20 }}>{error || 'Loading…'}</div> : (
          <>
            <div className="a-flex a-gap-10 a-ai-c" style={{ padding: '10px 20px' }}>
              <input className="form-input a-grow" placeholder="Filter by name…" value={q} onChange={e => setQ(e.target.value)} />
              <button className="btn btn-ghost a-fs-12" onClick={() => setSel(new Set(data.candidates.filter(c => c.suggested).map(c => c.id)))}>Suggested</button>
              <button className="btn btn-ghost a-fs-12" onClick={() => setSel(new Set())}>None</button>
            </div>
            <div className="a-grow" style={{ overflowY: 'auto', padding: '0 20px' }}>
              <table className="a-w100" style={{ borderCollapse: 'collapse' }}>
                <thead><tr className="a-muted a-fs-12 a-ta-l">
                  <th style={{ padding: '4px 8px', width: 28 }} /><th style={{ padding: '4px 8px' }}>Series</th>
                  <th style={{ padding: '4px 8px' }}>Owned / tracked</th><th style={{ padding: '4px 8px' }}>Note</th>
                </tr></thead>
                <tbody>
                  {rows.map(c => (
                    <tr key={c.id} onClick={() => toggle(c.id)} className="a-ptr" style={{ opacity: sel.has(c.id) ? 1 : 0.6 }}>
                      <td style={cell}><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} /></td>
                      <td style={cell}>{c.name} <span className="a-muted">({c.year || '?'}){c.special ? ' · special' : ''}{c.annuals ? ` · +${c.annuals} annual${c.annuals > 1 ? 's' : ''}` : ''}</span></td>
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>{c.processed} / {c.issues - c.skipped}</td>
                      <td style={{ ...cell, color: c.keep_reasons.length ? '#e0a050' : 'color-mix(in srgb, var(--om-text) 50%, var(--om-base))' }}>{c.keep_reasons.join('; ') || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="a-flex a-gap-10 a-ai-c" style={{ padding: '12px 20px', borderTop: '1px solid var(--adm-g3)' }}>
              <span className="a-text2 a-fs-13 a-grow">
                {chosen.length} of {data.candidates.length} ended series selected{annuals ? ` (+${annuals} linked annual series)` : ''} · {data.total_monitored} monitored in total
              </span>
              {error && <span className="a-err a-fs-13">{error}</span>}
              {!confirm
                ? <button className="btn btn-primary" disabled={!chosen.length || busy} onClick={() => setConfirm(true)}>Remove {chosen.length} from download manager</button>
                : <>
                    <span className="a-text a-fs-13">Sure? This can't be undone (re-add to bring one back).</span>
                    <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
                    <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Removing…' : 'Yes, remove'}</button>
                  </>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
