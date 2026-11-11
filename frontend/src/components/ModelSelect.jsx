// ─── ModelSelect ──────────────────────────────────────────────────
// Model menu for Settings → AI Models. Lists current models of every connected
// provider (GET /api/ai/models → backend/modelCatalog):
// grouped by family, newest of each family unless showOlder, short labels with
// list prices per million tokens, and the chosen model's note underneath.
// A saved model that is no longer offered stays selected and is flagged.
import React, { useState, useEffect } from 'react';

let cache = null, pending = null;
function loadModels(refresh) {
  if (cache && !refresh) return Promise.resolve(cache);
  if (pending && !refresh) return pending;
  pending = fetch(`/api/ai/models${refresh ? '?refresh=1' : ''}`).then(r => r.json())
    .then(d => { cache = d; pending = null; return d; })
    .catch(() => { pending = null; return { models: [], source: 'error' }; });
  return pending;
}
export function refreshModels() { return loadModels(true); }
const money = n => (n == null ? '?' : n < 1 ? `$${n.toFixed(2)}` : `$${n}`);
// Every provider is shown the same way: grouped by what the model is for, each
// line "Provider · Model — $in / $out". Claude Haiku / OpenAI Luna, Nano, Mini
// are Fast; Sonnet / Sol, Terra are Balanced; Opus / Astra are Most capable.
const CLASSES = [
  ['fast', 'Fast & inexpensive'], ['balanced', 'Balanced'], ['deep', 'Most capable'], ['premium', 'Premium'],
];
const classOf = m => m.provider === 'openai'
  ? (['luna', 'nano', 'mini'].includes(m.tier) ? 'fast' : m.tier === 'astra' ? 'deep' : 'balanced')
  : m.provider === 'gemini' ? (m.tier === 'pro' ? 'balanced' : 'fast')
  : ({ haiku: 'fast', sonnet: 'balanced', opus: 'deep', fable: 'premium' }[m.family] || 'balanced');
const PROVIDER = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Google' };
const short = m => m.name.replace(/^Claude\s+/i, '');
const display = m => `${PROVIDER[m.provider] || 'Claude'} · ${short(m)}`;
const price = m => (m.input == null ? 'price not listed' : `${money(m.input)} / ${money(m.output)}`);
const label = (m, recommend) => `${display(m)} — ${price(m)}${recommend && m.recommended === recommend ? '  ★ recommended' : ''}`;

export function useModels() {
  const [data, setData] = useState(cache);
  useEffect(() => { let alive = true; loadModels().then(d => alive && setData(d)); return () => { alive = false; }; }, []);
  return data;
}
export function modelName(id) { const m = cache?.models?.find(x => x.id === id); return m ? display(m) : id; }

// lookup: the task may use Gemini (aiModels gemini: true: lookups and page reading); elsewhere Gemini is not offered.
export default function ModelSelect({ value, onChange, inheritLabel, showOlder = false, recommend = null, claudeOnly = false, lookup = false, compact = false, ariaLabel }) {
  const data = useModels();
  const all = (data?.models || []).filter(m => (!claudeOnly || m.provider === 'anthropic' || (lookup && m.provider === 'gemini')) && (lookup || m.provider !== 'gemini'));
  const selected = all.find(m => m.id === value);
  const shown = all.filter(m => showOlder || m.newest || m.id === value);
  const groups = CLASSES.map(([key, title]) => [title, shown.filter(m => classOf(m) === key)
    .sort((a, b) => ((a.input ?? 99) - (b.input ?? 99)) || (a.provider || '').localeCompare(b.provider || '') || (parseFloat(b.version) - parseFloat(a.version)))])
    .filter(([, list]) => list.length);
  return (
    <>
      <select aria-label={ariaLabel} className="form-input" value={value || ''} onChange={e => onChange(e.target.value)}>
        {inheritLabel && <option value="">{inheritLabel}</option>}
        {value && !selected && <option value={value}>{value} — retired or unavailable, choose another</option>}
        {groups.map(([title, list]) => (
          <optgroup key={title} label={title}>
            {list.map(m => <option key={m.id} value={m.id}>{compact ? `${display(m)}${recommend && m.recommended === recommend ? ' ★' : ''}` : label(m, recommend)}</option>)}
          </optgroup>
        ))}
      </select>
      {selected && compact && <details className="ai-model-info"><summary>Model information{recommend && selected.recommended === recommend ? ' · Recommended' : ''}</summary><p className="form-hint">{price(selected)} per million tokens (input / output). {selected.note}</p></details>}
      {selected && compact && selected.retires && <p className="form-hint" style={{ color: '#e8b04a' }}>May retire from {selected.retires}.</p>}
      {selected && !compact && (
        <p className="form-hint" style={{ marginTop: 4 }}>
          {display(selected)} — {price(selected)} per million tokens (input / output): {selected.note}{selected.retires ? ` · Anthropic may retire it from ${selected.retires}.` : ''}
        </p>
      )}
      {value && !selected && all.length > 0 && (
        <p className="form-hint" style={{ marginTop: 4, color: '#e8b04a' }}>
          {claudeOnly && /^openai:/.test(value) ? 'This task needs a Claude model (web search or Comic Book Guy tools).' : !lookup && /^gemini:/.test(value) ? 'Gemini runs only lookups and page reading. Choose another model.' : 'This model is retired, retiring soon, or its provider is not connected. Choose a current one.'}
        </p>
      )}
      {Object.entries(data?.sources || {}).filter(([, v]) => v.source === 'fallback').map(([p, v]) => (
        <p key={p} className="form-hint" style={{ color: '#e8b04a' }}>
          Couldn't load the {p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : 'Anthropic'} model list{v.error ? ` (${v.error})` : ''}; showing its current defaults.
        </p>
      ))}
    </>
  );
}
