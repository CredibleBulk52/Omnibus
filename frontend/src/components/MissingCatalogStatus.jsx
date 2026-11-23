import React, { useEffect, useState } from 'react';

const endpoint = '/api/admin/missing-catalog';

export default function MissingCatalogStatus() {
  const [status, setStatus] = useState(null);
  const [starting, setStarting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer;
    async function poll() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!active) return;
        setStatus(data);
        setError('');
        if (data.running) timer = setTimeout(poll, 2500);
      } catch { if (active) setError('Could not load lookup status.'); }
    }
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  async function start() {
    setStarting(true);
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error();
      setStatus(await response.json());
      setError('');
      setRefresh(n => n + 1);
    } catch { setError('Could not start the lookup.'); }
    finally { setStarting(false); }
  }
  const last = status?.last;
  return <div className="a-flex a-ai-c a-gap-8 a-wrap">
    <button type="button" className="adm-btn" onClick={start} disabled={starting || status?.running}
      title="Scans check cached issue IDs. Nightly and manual runs also check Comic Vine.">
      {starting || status?.running ? 'Checking Comic Vine IDs…' : 'Fill missing Comic Vine IDs'}
    </button>
    <span role="status" className="settings-section-sub">
      {error || (status?.running ? 'Running in background.' : last
        ? `${new Date(last.at).toLocaleString()} · ${last.filled} filled · ${last.remaining} remaining · ${last.ambiguous} ambiguous. ${last.error || ''}`
        : 'Checks missing issues nightly.')}
      {status?.configured === false && ' Add a Comic Vine API key for online lookup.'}
    </span>
  </div>;
}
