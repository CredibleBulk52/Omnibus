import React, { useState } from 'react';
import { call, enc } from '../seriesShelf/api';
import { CONF_LABEL } from './shared';

// Library › Specials shelves › Minis & one-shots (stage B, backend/shelfSorterSeries.js): the AI's
// suggested homes for minis and one-shots on no shelf, as two covers each: ✓ Shelve or Not this one
// (both can be undone). "Shelved by the AI" lists what it put on shelves, with ✕ to take one off.
const MINIS_SHOWN = 60;
const rethinkText = r => r.verdict === 'own' ? 'a series of its own' : r.verdict === 'landmark' ? 'a standalone to leave off shelves'
  : r.verdict === 'none' ? 'no home in your library fits' : r.homeName ? `belongs on ${r.homeName}'s shelf` : 'it does not belong here';
export default function MinisPanel({ data, busy, act }) {
  const [sub, setSub] = useState('suggested');
  const [all, setAll] = useState(false);
  if (!data) return <p className="gp-muted">Loading…</p>;
  const list = sub === 'suggested' ? data.suggested : data.shelved;
  const shown = all ? list : list.slice(0, MINIS_SHOWN);
  const c = data.counts || {};
  const cover = id => <img src={`/api/series/${enc(id)}/thumbnail`} alt="" loading="lazy" onError={ev => { ev.target.style.visibility = 'hidden'; }} />;
  const shelve = x => act(`m:${x.seriesId}`, () => call('POST', '/api/grouping/ai/apply', { seriesIds: [x.seriesId] }), r => r?.applied
    ? { text: `Put ${x.name} on ${x.homeName}'s shelf.`, run: () => call('POST', `/api/grouping/ai/runs/${enc(r.runId)}/undo`) } : null);
  const decline = x => act(`m:${x.seriesId}`, () => call('POST', `/api/grouping/series/${enc(x.seriesId)}/decline`), r => ({
    text: `${x.name} stays where it is.`, run: () => call('POST', `/api/grouping/series/${enc(x.seriesId)}/undecline`, { previous: r?.previous ?? null }) }));
  const takeOff = x => act(`m:${x.seriesId}`, () => call('DELETE', `/api/series/${enc(x.seriesId)}/shelf/${enc(x.homeId)}`), () => ({
    text: `Took ${x.name} off ${x.homeName}'s shelf.`, run: () => call('POST', '/api/grouping/restore', { items: [{ seriesId: x.seriesId, homeId: x.homeId }] }) }));
  const keep = x => act(`m:${x.seriesId}`, () => call('POST', `/api/grouping/series/${enc(x.seriesId)}/keep`), r => ({
    text: `${x.name} stays on ${x.homeName}'s shelf.`, run: () => call('POST', `/api/grouping/series/${enc(x.seriesId)}/keep`, { undo: true, previous: r?.previous ?? null }) }));
  return (
    <div className="gp-minis">
      <div className="gp-subtabs">
        {[['suggested', 'Suggested', data.suggested.length], ['shelved', 'Shelved by the AI', data.shelved.length]].map(([k, label, n]) => (
          <button key={k} type="button" aria-pressed={sub === k} onClick={() => { setSub(k); setAll(false); }}>{label} <b>{n}</b>{k === 'shelved' && c.rethink ? <small className="gp-conf gp-conf-unsure"> {c.rethink} to recheck</small> : null}</button>))}
        <span className="gp-muted" title={`Series left alone, and series not asked about yet (✦ Ask the AI asks about them).${c.ongoing ? ` ${c.ongoing} of the own series are ongoings Metron knows, kept without asking the AI.` : ''}`}>
          Left alone: {c.own || 0} own series · {c.landmark || 0} landmarks · {c.none || 0} no fitting home{data.toAsk ? ` · ${data.toAsk} not asked yet` : ''}
          {data.waiting ? <span title="New series with only #1 out: a one-issue book can't be told from a one-shot yet. They are asked about once Metron gives their type or a second issue arrives."> · {data.waiting} new, waiting for #2</span> : null}
        </span>
      </div>
      {data.types && data.types.known < data.types.total && (
        <p className="gp-muted gp-types" title={`Metron says whether a series was an ongoing or a planned mini. Ongoings (and cancelled series) are kept as their own series without asking the AI. A batch is looked up every hour.${(data.types.words || []).length ? `\n\nSo far: ${data.types.words.map(w => `${w.word} ${w.count}`).join(', ')}` : ''}`}>
          Series types from Metron: {data.types.known} of {data.types.total}{data.types.running ? ' · looking up…' : <> · <button type="button" className="gp-link" disabled={busy}
            onClick={() => act('types', () => call('POST', '/api/grouping/series/types/run'), () => ({ text: 'Looking up series types on Metron in the background.', run: null }))}>Look up the rest now</button></>}
        </p>)}
      {!list.length && <p className="gp-muted">{sub === 'suggested' ? (data.asked ? 'No suggestions waiting.' : 'Nothing suggested yet: ✦ above checks the minis and one-shots too.') : 'Nothing shelved by the AI yet.'}</p>}
      <div className="gp-mgrid">
        {shown.map(x => (
          <div key={`${x.seriesId}|${x.homeId}`} className="gp-mcard">
            <div className="gp-mpair">
              <figure title={x.name}>{cover(x.seriesId)}<figcaption>{x.name}</figcaption></figure>
              <span className="gp-marrow">→</span>
              <figure className="gp-mhome" title={x.homeName}>{cover(x.homeId)}<figcaption>{x.homeName}</figcaption></figure>
            </div>
            {x.rethink
              ? <div className="gp-airow gp-ai-differs" title={`Asked again, the AI no longer puts it here: ${x.rethink.why || ''}${x.rethink.model ? `\nModel: ${x.rethink.model}` : ''}\nShelved because: ${x.why || ''}`}>
                  <small className={`gp-conf gp-conf-${x.rethink.confidence}`}>{CONF_LABEL[x.rethink.confidence] || x.rethink.confidence}</small>
                  <span>AI now says: {rethinkText(x.rethink)}</span>
                </div>
              : <div className="gp-airow" title={`${x.why || ''}${x.main ? '\nPart of the main story: it goes on the shelf but stays in the series list.' : ''}${x.model ? `\nModel: ${x.model}` : ''}`}>
                  {x.confidence && <small className={`gp-conf gp-conf-${x.confidence}`}>{CONF_LABEL[x.confidence] || x.confidence}</small>}
                  {x.main && <small className="gp-conf">main story</small>}
                  <span>{x.why}{x.stale ? ' · out of date' : ''}{x.undone ? ' · undone before' : ''}{x.outdated ? ' · older model or prompt' : ''}</span>
                </div>}
            <div className="gp-mactions">
              {sub === 'suggested'
                ? <><button className="adm-btn" disabled={busy} onClick={() => shelve(x)}>✓ Shelve</button>
                    <button className="adm-btn adm-btn-ghost" disabled={busy} onClick={() => decline(x)}>Not this one</button></>
                : <><button className="adm-btn adm-btn-ghost" disabled={busy} onClick={() => takeOff(x)}>✕ Take it off</button>
                    {x.rethink && <button className="adm-btn adm-btn-ghost" disabled={busy} onClick={() => keep(x)} title="Keeps it on this shelf. The AI is not asked about it again.">Keep it</button>}</>}
            </div>
          </div>))}
      </div>
      {list.length > MINIS_SHOWN && <button type="button" className="gp-link" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </div>
  );
}
