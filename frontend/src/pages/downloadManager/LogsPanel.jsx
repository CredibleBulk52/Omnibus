import React, { useState, useEffect, useRef } from 'react';

// ─── Logs panel (Download Manager tab) ───────────────────────────
const DM_LOG_LEVEL_COLORS = { error: '#cc5050', warn: '#f5c518', info: '#7aaa88', debug: '#555' };

export function LogsPanel() {
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const [following, setFollowing] = useState(true);
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [copyStatus, setCopyStatus] = useState('');
  const viewport = useRef(null);
  useEffect(() => {
    const es = new EventSource('/api/logs/stream?token=' + encodeURIComponent(localStorage.getItem('omnibus_token') || ''));
    es.onopen = () => setConnection('Live');
    es.onerror = () => setConnection('Reconnecting');
    es.onmessage = e => {
      try { const entry = JSON.parse(e.data); setEntries(prev => [...prev, entry].slice(-500)); } catch {}
    };
    return () => es.close();
  }, []);
  const displayed = entries.filter(e => (filter === 'all' || e.level === filter) && `${e.category} ${e.message}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [entries, following, filter, search]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(displayed.map(e => `${e.ts || ''} ${e.level || ''} [${e.category || ''}] ${e.message || ''}${e.data ? ' ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : ''}`).join('\n')); setCopyStatus('Copied'); }
    catch { setCopyStatus('Could not copy. Select and copy the log text instead.'); }
  };
  return <div className="dm-logs">
    <div className="dm-triage-toolbar">
      <input className="adm-input" aria-label="Filter logs" value={search} onChange={e => setSearch(e.target.value)} placeholder="Category or message…" />
      <select className="adm-input" aria-label="Log level" value={filter} onChange={e => setFilter(e.target.value)}>{['all','error','warn','info','debug'].map(level => <option key={level} value={level}>{level === 'all' ? 'All levels' : level}</option>)}</select>
      <button className="adm-btn" aria-pressed={following} onClick={() => setFollowing(v => !v)}>{following ? 'Pause following' : 'Follow live'}</button>
      <button className="adm-btn" disabled={!displayed.length} onClick={copy}>Copy filtered logs</button>
      <button className="adm-btn" onClick={() => { setEntries([]); setCopyStatus(''); }}>Clear view</button>
    </div>
    <div className="dm-log-summary" role="status">{connection} · {displayed.length} shown · latest 500 entries retained{!following && ' · Following paused; new entries still collected'}{copyStatus && ` · ${copyStatus}`}</div>
    <div ref={viewport} className="dm-log-viewport" tabIndex={0} aria-label="Log entries" onScroll={() => { const el = viewport.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollowing(false); }}>
      {!displayed.length && <div className="adm-empty">{entries.length ? 'No entries match these filters.' : 'Waiting for log entries…'}</div>}
      {displayed.map((entry,i) => <div key={i} className={`dm-log-entry dm-log-${entry.level}`}>
        <time title={entry.ts}>{entry.ts?.slice(11,19)}</time><strong style={{color: DM_LOG_LEVEL_COLORS[entry.level] || 'var(--om-text)'}}>{entry.level?.toUpperCase()}</strong><span className="dm-log-category">{entry.category}</span>
        <span>{entry.message}{entry.data && <span className="a-muted"> {' '}{typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}</span>}</span>
      </div>)}
    </div>
  </div>;
}
