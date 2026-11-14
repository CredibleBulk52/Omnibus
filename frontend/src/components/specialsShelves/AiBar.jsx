import React from 'react';
import { useNavigate } from 'react-router-dom';
import { call, enc } from '../seriesShelf/api';
import { SCOPE_LABEL, SCOPE_HINT, askWhat, MODE_LABEL, setMode } from './shared';

// The Shelf Sorter line of the Specials shelves panel: ✦ Ask the AI (its cost shown first, in the
// pending card), Apply n sure changes, the last ask, the ⋯ menu and the "older model or prompt" hint.
// No AI call runs without the admin's go (2026-11-14, claude/SHELF_SORTER.md).
// mode: 'events' (Events only: event homes only) or 'all' (Events and minis).
export default function AiBar({ aiInfo, busy, asking, act, prepare, pending, setPending, go, mode = 'all' }) {
  const navigate = useNavigate();
  const undoAiRun = id => () => call('POST', `/api/grouping/ai/runs/${enc(id)}/undo`);
  const applyAi = () => act('ai', () => call('POST', '/api/grouping/ai/apply'), r => r?.applied
    ? { text: `Applied ${r.applied} change${r.applied === 1 ? '' : 's'} from the AI.`, run: undoAiRun(r.runId) } : { text: 'Nothing new to apply.', run: null });
  const closeMenu = ev => { const d = ev.currentTarget.closest('details'); if (d) d.open = false; };
  const minis = mode === 'all';
  const kinds = minis ? ['event', 'series'] : ['event'];
  const canAsk = aiInfo.aiAvailable !== false || minis;   // without an AI key only minis get (Omnibus's own) suggestions
  const switchTo = (ev, next) => { closeMenu(ev); act('mode', () => setMode(next), () => ({
    text: next === 'off' ? 'Specials shelves are off: the series page shows one list of every series again. Your shelves are kept.'
      : next === 'events' ? 'Events only: minis and one-shots are left alone from now on. What is already on a shelf stays.'
      : 'Events and minis: ✦ Ask the AI now suggests homes for minis and one-shots too.',
    run: () => setMode(mode) })); };
  return (<>
      <div className="gp-ai">
        {asking
          ? <><span className="gp-ai-progress"><span style={{ width: `${Math.round(100 * aiInfo.running.done / Math.max(1, aiInfo.running.total))}%` }} /></span>
              <span>✦ Asking the AI… {aiInfo.running.done} of {aiInfo.running.total}</span>
              <button type="button" className="gp-link" onClick={() => act('ai', () => call('POST', '/api/grouping/ai/stop'))}>Stop</button></>
          : <>{canAsk ? <button className="adm-btn adm-btn-ghost" disabled={!!busy} onClick={() => prepare(kinds, ['new'], 'Ask the AI')}
              title={aiInfo.aiAvailable === false
                ? 'No AI key is saved for the Shelf Sorter, so Omnibus suggests only its strongest matches for minis and one-shots (same title, published while that series ran). Nothing changes until you Shelve.'
                : minis ? "The AI checks new or changed events against their reading orders, and suggests homes for new minis and one-shots. You see how many AI calls it takes before it starts."
                : "The AI checks new or changed events against their reading orders: is the home right, should a series come off or stay visible. You see how many AI calls it takes before it starts."}>
              {aiInfo.aiAvailable === false ? '✦ Suggest homes' : '✦ Ask the AI'}</button>
              : <span className="gp-muted" title="Settings › AI Models">With an AI key, the Shelf Sorter can give a second opinion on event homes.</span>}
              {canAsk && aiInfo.ready > 0 && <button className="adm-btn" disabled={!!busy} onClick={applyAi} title="Applies the answers the AI is sure of. Undo is offered afterwards.">✓ Apply {aiInfo.ready} sure change{aiInfo.ready === 1 ? '' : 's'}</button>}
              {canAsk && <span className="gp-muted gp-ai-line" title={aiInfo.lastAsk?.error || ''}>
                {aiInfo.lastAsk?.error && !aiInfo.lastAsk.asked ? `Last try failed: ${aiInfo.lastAsk.error}` : aiInfo.asked || aiInfo.askedSeries ? `Asked about ${aiInfo.asked} events and ${aiInfo.askedSeries || 0} series` : 'Not asked yet'}
                {aiInfo.aiAvailable === false ? ' · no AI key: Omnibus suggests its strongest matches' : aiInfo.model ? ` · ${aiInfo.model}` : ''}{aiInfo.auto ? ' · applies sure answers when you ask' : ''}
              </span>}</>}
        <details className="gp-menu gp-ai-menu">
          <summary aria-label="AI options">⋯</summary>
          <div className="gp-menu-items">
            <label className="gp-menu-check" title="When you click ✦ Ask the AI, the answers it is sure of about events and series asked for the first time are applied at once (Undo is in this menu). Asking again never applies anything on its own. The AI never runs without your click.">
              <input type="checkbox" checked={!!aiInfo.auto} disabled={!!busy} onChange={ev => act('ai', () => call('POST', '/api/grouping/ai/auto', { on: ev.target.checked }))} /> Apply sure answers when I ask
            </label>
            {aiInfo.lastApplied && <button type="button" disabled={!!busy} onClick={ev => { closeMenu(ev); act('ai', undoAiRun(aiInfo.lastApplied.id), () => ({ text: 'Undid the AI\'s last changes.', run: null })); }}>
              Undo the AI's last changes ({aiInfo.lastApplied.applied})</button>}
            <button type="button" disabled={!!busy || asking} onClick={ev => { closeMenu(ev); prepare(['event'], ['suggested', 'all'], 'Review the events again'); }}
              title="Ask again about the open suggestions only, or about every event with a shelf. Homes you approved and series you put back are never changed; new advice waits on To check.">Review the events again…</button>
            {minis && <button type="button" disabled={!!busy || asking} onClick={ev => { closeMenu(ev); prepare(['series'], ['suggested', 'all'], 'Review the minis again'); }}
              title="Ask again about the suggestions waiting, or about every mini and one-shot you have not decided (also those the AI shelved). Nothing changes on its own: new advice waits on the Minis tab.">Review the minis again…</button>}
            <button type="button" onClick={ev => { closeMenu(ev); navigate('/settings?tab=ai'); }}>Choose the AI model…</button>
            <span className="gp-menu-head">Specials shelves</span>
            {['events', 'all', 'off'].map(m => (
              <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} disabled={!!busy || mode === m} onClick={ev => switchTo(ev, m)}
                title={m === 'events' ? 'Shelves follow your Timeline events only. Minis and one-shots are left alone: no Minis tab, no Metron lookups, no AI suggestions for them.'
                  : m === 'all' ? 'Also suggests homes for side minis and one-shots (Minis & one-shots tab). Best with an AI key and a Metron token; expect a review queue on a large library.'
                  : 'Shows every series in one list again, without the Series, One-shots and Tie-ins views. Shelves and choices are kept for when you turn them back on.'}>
                {mode === m ? '✓ ' : ''}{MODE_LABEL[m]}</button>))}
          </div>
        </details>
      </div>
      {pending && !asking && (
        <div className="gp-pending" role="dialog" aria-label={pending.title}>
          <span><b>✦ {pending.title}</b>{pending.model ? <span className="gp-muted"> · {pending.model}</span> : null}</span>
          {pending.options.map(o => (
            <button key={o.key} className="adm-btn" disabled={!!busy} onClick={() => go(o)} title={SCOPE_HINT[o.key]}>
              {SCOPE_LABEL[o.key]}: {askWhat(o)} · {o.calls} AI call{o.calls === 1 ? '' : 's'}</button>))}
          <button type="button" className="gp-link" onClick={() => setPending(null)}>Cancel</button>
        </div>)}
      {!pending && !asking && aiInfo.outdated && aiInfo.outdated.events + aiInfo.outdated.series > 0 && (
        <p className="gp-muted gp-outdated" title="Advice still waiting that came from another AI model or an older Shelf Sorter prompt. Nothing is asked again until you click.">
          {aiInfo.outdated.events + aiInfo.outdated.series} suggestion{aiInfo.outdated.events + aiInfo.outdated.series === 1 ? '' : 's'} came from another model or an older prompt
          {' · '}<button type="button" className="gp-link" disabled={!!busy} onClick={() => prepare(['event', 'series'], ['outdated'], 'Ask again')}>Ask again</button>
        </p>)}
  </>);
}
