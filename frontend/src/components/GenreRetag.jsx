import React, { useCallback, useEffect, useState } from 'react';
import '../genreRetag.css';
import { AiInfo } from './AiInfo';

// ─── Library › Genres (2026-11-03) ──────────────────────────────────────────
// Retags series genres with the AI from the current list (backend/genres.js), using what
// each series.json already holds. "Retag 30" is a sample to review first; "Retag all" does
// every series still on an older list, so it can be stopped and started again.
const API = '/api/admin/genres/retag';
const cents = c => (c >= 1 ? `$${c.toFixed(2)}` : `${Math.round(c * 10000) / 100}¢`);   // c in dollars
// The server's cost per series: the last retag's saved costs, or the model's list prices.
const estimate = (n, e) => { const c = n * (e?.perSeries || 0); return !c ? 'cost unknown' : c < 0.01 ? 'under 1¢' : `about ${cents(Math.ceil(c * 100) / 100)}`; };
const list = g => (g && g.length ? g.join(', ') : '—');
const MODEL_NAME = { sonnet: 'Sonnet 5.5' };
const STATUS = { written: '', no_answer: 'No answer, unchanged', unreadable: 'series.json unreadable', unusual: 'Unusual series.json', write_failed: 'Not saved' };

export default function GenreRetag() {
  const [st, setSt] = useState(null);
  const [error, setError] = useState('');
  const [showGenres, setShowGenres] = useState(false);
  const [model, setModel] = useState('');   // another model than the Enricher's, for a test or the full run (2026-11-04)
  const load = useCallback(async () => {
    try {
      const r = await fetch(API);
      if (!r.ok) throw new Error();
      setSt(await r.json());
    } catch { setError('Could not load the genre status.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!st?.running) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [st?.running, load]);
  const post = async (url, body) => {
    setError('');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Request failed');
      setSt(d);
    } catch (e) { setError(e.message); }
  };
  if (!st) return <div className="gr">{error || 'Loading…'}</div>;
  const finished = !st.running && st.finishedAt;
  return (
    <div className="gr">
      <p className="gr-help">
        The Genre filter uses {st.genres.length} genres (list {st.version}).{' '}
        <button type="button" className="gr-link" onClick={() => setShowGenres(v => !v)}>{showGenres ? 'Hide the list' : 'Show the list'}</button>{' '}
        Retagging asks the AI for up to 4 genres per series from each series.json; nothing else changes.
      </p>
      {showGenres && <ul className="gr-genres">{st.genres.map(g => <li key={g.name}><strong>{g.name}</strong> {g.definition}</li>)}</ul>}
      <p className="gr-pending">{st.pending ? `${st.pending.toLocaleString()} series not yet tagged from this list.` : 'Every series is tagged from this list.'}</p>
      <div className="gr-row">
        <button type="button" className="adm-btn" disabled={st.running || !st.pending} onClick={() => post(API, { test: true, model: model || undefined })}>Retag 30 (test)</button>
        <button type="button" className="adm-btn" disabled={st.running || !st.lastTest} title="The same series as the last test, to compare answers"
          onClick={() => post(API, { test: true, again: true, model: model || undefined })}>Test the same {st.lastTest || ''} again</button>
        {st.testModels?.length > 0 && <label className="gr-model">Model
          <select value={model} onChange={e => setModel(e.target.value)} disabled={st.running}>
            <option value="">the Enricher’s model</option>
            {st.testModels.map(m => <option key={m} value={m}>{MODEL_NAME[m] || m}</option>)}
          </select>
        </label>}
        <button type="button" className="adm-btn" disabled={st.running || !st.pending} onClick={() => post(API, { model: model || undefined })}>
          Retag all {st.pending ? st.pending.toLocaleString() : ''} ({estimate(st.pending, (model && st.estimates?.[model]) || st.estimate)})
        </button>
        {st.running && <button type="button" className="adm-btn" onClick={() => post(`${API}/stop`)}>Stop</button>}
      </div>
      {(st.running || finished) && (
        <p className="gr-status" role="status">
          {st.running ? 'Retagging… ' : st.stopped ? 'Stopped: ' : st.error ? 'Ended early: ' : 'Done: '}
          {st.test && (st.again || st.model) ? `(test${st.again ? ', same series' : ''}${st.model ? `, ${st.model}` : ''}) ` : !st.test && st.model ? `(${st.model}) ` : ''}
          {st.written.toLocaleString()} of {st.total.toLocaleString()} series written
          {st.changed !== st.written ? ` (${st.changed.toLocaleString()} changed)` : ''}
          {st.noAnswer ? ` · ${st.noAnswer} without an answer` : ''}
          {st.failed ? ` · ${st.failed} not saved` : ''}
          {st.cost ? ` · ${cents(st.cost)}` : ''}
          {st.error ? ` · ${st.error}` : ''}
          <AiInfo run={st.runId} />
        </p>
      )}
      {st.problem && <p className="gr-error">Last problem: {st.problem}</p>}
      {error && <p className="gr-error">{error}</p>}
      {st.test && st.results.length > 0 && (
        <table className="gr-table">
          <thead><tr><th>Series</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {st.results.map(r => (
              <tr key={r.id}>
                <td><a href={`/series/${r.id}`}>{r.name}</a></td>
                <td>{list(r.before)}</td>
                <td>{r.status === 'written' ? list(r.after) : <em>{STATUS[r.status] || r.status}</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
