import React, { useState, useEffect } from 'react';
import { authHeader } from '../App';
import Modal from './Modal';

// Fill missing issues (admin): pick missing issues of this folder's Comic Vine
// volume; the server monitors this folder with the picks wanted, everything
// else skipped, and auto-grabs. Downloads take the normal download flow,
// including post-processing into the folder.
export default function FillMissingModal({ seriesId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(new Set());
  const [showOwned, setShowOwned] = useState(false);
  const [autoRemove, setAutoRemove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    fetch(`/api/series/${seriesId}/fill/preview`, { headers: authHeader() })
      .then(r => r.json().then(d => { if (!r.ok || d.error) throw new Error(d.error || `Failed (${r.status})`); return d; }))
      .then(d => { setData(d); setSel(new Set(d.issues.filter(i => i.state === 'missing' && !i.unreleased).map(i => i.id))); })
      .catch(e => setError(e.message));
  }, [seriesId]);

  const missing = (data?.issues || []).filter(i => i.state === 'missing');
  const rows = (data?.issues || []).filter(i => showOwned || i.state !== 'owned');
  const toggle = id => setSel(s0 => { const s1 = new Set(s0); s1.has(id) ? s1.delete(id) : s1.add(id); return s1; });
  const mon = data?.monitored;
  const elsewhere = mon && !mon.same_folder;
  const willAutoRemove = !mon && autoRemove;

  const run = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/series/${seriesId}/fill`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ issueIds: [...sel], autoRemove }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `Failed (${r.status})`);
      setDone(d);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const cell = { padding: '4px 8px', borderTop: '1px solid var(--border-subtle)', fontSize: 13 };
  const stateLabel = i => i.state === 'owned' ? (i.where ? `Owned · in ${i.where}` : 'Owned')
    : i.state === 'wanted' ? 'Already wanted' : (i.unreleased ? 'Missing · not released yet' : 'Missing');
  const stateColor = i => i.state === 'owned' ? 'var(--text-muted)' : i.state === 'wanted' ? '#8af' : '#e0a050';

  return (
    <Modal title="⬇ Fill missing issues" onClose={() => !busy && onClose()} closeOnBackdrop={!busy} width={720}
      footer={<>
          <button className="adm-btn adm-btn-ghost" disabled={busy} onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
          {data && !done && missing.length > 0 && (
            <button className="adm-btn adm-btn-primary" disabled={busy || !sel.size} onClick={run}>
              {busy ? 'Starting…' : `Fill ${sel.size} issue${sel.size !== 1 ? 's' : ''}`}
            </button>
          )}
      </>}>
      <div className="rl-modal-body">
        {!data ? <div style={{ color: 'var(--text-secondary)' }}>{error || 'Loading issues from Comic Vine…'}</div>
        : done ? (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            <p><b>{done.wanted}</b> issue{done.wanted !== 1 ? 's' : ''} set to wanted. Auto-grab has started; downloads go through the normal download flow and are filed into:</p>
            <p style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{done.directory}</p>
            <p style={{ color: 'var(--text-secondary)' }}>Progress shows in the Download Manager.
              {done.auto_remove ? ' This series leaves the Download Manager on its own once no pick is still wanted (files stay).' : ''}</p>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 10 }}>
              <b style={{ color: 'var(--text-primary)' }}>{data.volume.name} ({data.volume.year || '?'})</b> · Comic Vine: {data.counts.total} issues ·
              {' '}{data.counts.owned} owned · {data.counts.missing} missing{data.counts.wanted ? ` · ${data.counts.wanted} already wanted` : ''}.
              Owned is checked across the whole library by Comic Vine ID. Annuals are not included.
            </div>
            {elsewhere && (
              <div style={{ fontSize: 13, color: '#e0a050', border: '1px solid rgba(224,160,80,0.4)', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
                This volume is already monitored in another folder. Downloads will go there:
                <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', marginTop: 4 }}>{mon.directory}</div>
              </div>
            )}
            {mon && !elsewhere && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>Already monitored here; the picks are added to that entry.</div>
            )}
            {missing.length === 0 ? (
              <div style={{ fontSize: 14, padding: '12px 0' }}>Nothing missing. You own every issue of this volume.</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <button className="adm-btn adm-btn-ghost" style={{ fontSize: 12 }} onClick={() => setSel(new Set(missing.map(i => i.id)))}>All missing</button>
                  <button className="adm-btn adm-btn-ghost" style={{ fontSize: 12 }} onClick={() => setSel(new Set())}>None</button>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showOwned} onChange={e => setShowOwned(e.target.checked)} /> Show owned
                  </label>
                </div>
                <div style={{ overflowY: 'auto', maxHeight: '45vh', border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {rows.map(i => {
                        const pickable = i.state === 'missing';
                        return (
                          <tr key={i.id} onClick={() => pickable && toggle(i.id)} style={{ cursor: pickable ? 'pointer' : 'default', opacity: pickable ? (sel.has(i.id) ? 1 : 0.65) : 0.5 }}>
                            <td style={{ ...cell, width: 26 }}>{pickable && <input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} onClick={e => e.stopPropagation()} />}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap', width: 56 }}>#{i.number}</td>
                            <td style={cell}>{i.title || ''}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--text-muted)', width: 90 }}>{(i.date || '').slice(0, 7)}</td>
                            <td style={{ ...cell, whiteSpace: 'nowrap', color: stateColor(i) }}>{stateLabel(i)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!mon && (
                  <label style={{ display: 'block', fontSize: 13, marginTop: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={autoRemove} onChange={e => setAutoRemove(e.target.checked)} /> Remove from the Download Manager when done
                    <span style={{ color: 'var(--text-muted)' }}> (once no pick is still wanted; ended series only; files stay)</span>
                  </label>
                )}
                {!mon && data.status !== 'ended' && willAutoRemove && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Series status is {data.status}: it is removed only once Comic Vine shows it as ended.
                  </div>
                )}
              </>
            )}
            {error && <div style={{ color: '#f88', fontSize: 13, marginTop: 8 }}>{error}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
