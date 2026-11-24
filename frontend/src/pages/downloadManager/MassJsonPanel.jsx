import Modal from '../../components/Modal';
import React, { useState, useEffect } from 'react';

// ─── Mass JSON Panel ──────────────────────────────────────────────
export function MassJsonPanel({ onClose }) {
  const [state, setState]     = useState(null);
  const [running, setRunning] = useState(false);
  const logRef = React.useRef(null);

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/monitor/mass-json/status');
      const d = await r.json();
      setState(d);
      if (d.running) setRunning(true);
      else setRunning(false);
    } catch {}
  };

  useEffect(() => {
    loadStatus();
    const iv = setInterval(loadStatus, 1500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.log]);

  const start = async () => {
    setRunning(true);
    await fetch('/api/monitor/mass-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  };

  const pct = state && state.queued > 0 ? Math.round((state.done / state.queued) * 100) : 0;

  return (
    <Modal title="Create Missing series.json" onClose={onClose} width={620}>
      <div className="adm-modal-content">
<div style={{ padding: '14px 18px', borderBottom: '1px solid color-mix(in srgb, var(--om-base) 95%, white)' }}>
          <div className="a-muted a-fs-12 a-mb-12">
            Creates <code className="a-accent">series.json</code> for every monitored series that is missing one. Existing files are left alone — they're refreshed automatically each week.
          </div>

          <button
            className="adm-btn adm-btn-primary" style={{ opacity: running ? 0.6 : 1 }}
            onClick={start}
            disabled={running}
          >
            {running ? '⟳ Running…' : '▶ Start'}
          </button>
        </div>

        {/* Progress */}
        {state && (
          <div className="a-fs-12" style={{ padding: '10px 18px', borderBottom: '1px solid var(--adm-g1)' }}>
            {state.running && (
              <>
                <div className="a-flex a-jc-b a-mb-4">
                  <span className="a-accent">
                    {state.currentSeries || '…'} — {state.done}/{state.queued}
                  </span>
                  <span className="a-faint">{pct}%</span>
                </div>
                <div className="a-ovh a-mb-8" style={{ height: 3, background: 'var(--adm-g1)', borderRadius: 2 }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--td-yellow)', transition: 'width 0.4s' }} />
                </div>
              </>
            )}
            <div className="a-flex a-gap-16 a-wrap">
              <span className="a-ok">✓ {state.created} created</span>
              {state.enriched > 0 && <span className="a-info">✦ {state.enriched} enriched</span>}
              <span className="a-faint">{state.skipped} skipped</span>
              {state.errors > 0 && <span className="a-err">✗ {state.errors} errors</span>}
              {state.lastRun && !state.running && (
                <span className="a-dim a-ml-auto">
                  Last run: {new Date(state.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Log */}
        <div ref={logRef} className="a-grow a-mono a-fs-11 a-faint" style={{ overflowY: 'auto', padding: '8px 18px', background: 'var(--adm-g0)', minHeight: 140 }}>
          {state?.log?.length > 0
            ? state.log.map((line, i) => (
                <div key={i} style={{ color: line.startsWith('✓') ? '#4caa60' : line.startsWith('✗') ? 'color-mix(in srgb, var(--td-red) 75%, white)' : line.startsWith('SKIP') ? 'color-mix(in srgb, var(--om-base) 80%, white)' : 'color-mix(in srgb, var(--om-text) 40%, var(--om-base))' }}>
                  {line}
                </div>
              ))
            : <div className="a-dim">No output yet — click Start to begin.</div>
          }
        </div>
      </div>
    </Modal>
  );
}
