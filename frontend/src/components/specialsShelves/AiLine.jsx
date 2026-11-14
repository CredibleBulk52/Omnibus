import React from 'react';
import { CONF_LABEL } from './shared';

// One line under an event: what the Shelf Sorter thinks. Detail on hover.
export default function AiLine({ e, busy, onUse }) {
  const a = e.ai, h = a.home;
  const changes = a.stale ? [] : a.members;       // the advice that would still change something
  const homeOpen = !a.stale && h.open && h.verdict === 'change';
  const text = h.verdict === 'change' && h.seriesId === e.home ? <>AI agrees</>
    : h.verdict === 'change' ? (homeOpen ? <>AI suggests <b>{h.name}</b></> : <>AI suggested {h.name}</>)
    : h.verdict === 'none' ? <>AI: no series in your library should hold this shelf</>
    : <>AI agrees</>;
  const rm = changes.filter(m => m.action === 'remove').length, kv = changes.length - rm;
  const more = [rm && `take off ${rm}`, kv && `keep ${kv} visible`].filter(Boolean).join(', ');
  const detail = [h.why, ...a.members.map(m => `${m.name}: ${m.action === 'remove' ? 'take off' : 'keep visible'} (${m.confidence}) ${m.why}`),
    a.stale ? 'Asked before this event or its shelf changed.' : '', a.undone ? 'Its changes here were undone, so they are only advice now.' : '', a.model ? `Model: ${a.model}` : ''].filter(Boolean).join('\n');
  const differs = homeOpen || h.verdict === 'none';
  return (
    <div className={`gp-airow${differs ? ' gp-ai-differs' : ''}`} title={detail}>
      <span><span className="gp-star">✦</span> {text}{more ? ` · ${more}` : ''}{a.stale ? ' · out of date' : ''}</span>
      <small className={`gp-conf gp-conf-${h.confidence}`}>{CONF_LABEL[h.confidence] || h.confidence}</small>
      {homeOpen || changes.length ? <button type="button" className="gp-link" disabled={busy} onClick={onUse}>Use the AI's advice</button> : null}
    </div>
  );
}
