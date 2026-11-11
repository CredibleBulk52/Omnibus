// ─── AiModelsSettings ─────────────────────────────────────────────
// Settings → AI Models: provider keys (Anthropic, OpenAI, Google Gemini for web lookups) and the
// task models. Each task uses its recommended model (picked by the keys saved) unless it is set to
// a specific one; the two top-level default models were retired 2026-10-23. Keys and task models
// are saved separately. Claude and OpenAI run every task (OpenAI through backend/ai/openaiAdapter.js);
// Usage & results compares them. See docs/AI_MODELS.md.
import React, { useState, useEffect } from 'react';
import ModelSelect, { useModels, modelName, refreshModels } from '../components/ModelSelect';
import AiUsage from './AiUsage';
import './aiSettings.css';

const post = body => fetch('/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`); return d; });
const isOpenAI = id => /^openai:/.test(id || '');
const KEY_FIELD = { anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key' };
const KEY_HINT = { anthropic: 'console.anthropic.com → API Keys', openai: 'platform.openai.com → API keys', gemini: 'aistudio.google.com → API keys (billing on)' };

export default function AiModelsSettings({ compact = false, children }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);       // { tasks: {id: model|''}, trials, keys: {provider: text} }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState({ keys: false, tasks: false });
  const [saving, setSaving] = useState('');       // '' | 'keys' | 'tasks' | 'all'
  const [tests, setTests] = useState({});
  const [showOlder, setShowOlder] = useState(false);
  const [trialOpen, setTrialOpen] = useState(() => new Set());
  const models = useModels();
  // Recent cost per use for each task (Usage, last 30 days), shown on its row.
  const [perTask, setPerTask] = useState({});
  useEffect(() => {
    fetch('/api/ai/usage?days=30').then(r => r.json()).then(d => setPerTask(Object.fromEntries((d.byTask || []).map(r => [r.key, r.all])))).catch(() => {});
  }, []);
  const cents = n => { const c = n * 100; return c < 0.1 ? '<0.1¢' : c < 10 ? `${c.toFixed(1)}¢` : `${Math.round(c)}¢`; };
  const useLine = id => { const u = perTask[id]; return u && u.jobs ? `about ${cents(u.cost_per_job)} each · ${u.jobs} in 30 days${u.thinking_share != null ? ` · thinking ~${Math.round(u.thinking_share)}% of output` : ''}` : ''; };
  const nameOf = id => (models ? modelName(id) : id);

  const reset = d => {
    setData(d);
    setDraft({ tasks: Object.fromEntries(d.tasks.map(t => [t.id, t.pinned])),
      trials: Object.fromEntries(d.tasks.map(t => [t.id, t.trial || null])), keys: {} });
  };
  useEffect(() => { fetch('/api/ai/settings').then(r => r.json()).then(reset).catch(e => setError(e.message)); }, []);

  if (!draft) return <div className="settings-card">{error ? <p className="form-hint" style={{ color: 'color-mix(in srgb, var(--td-red) 80%, white)' }}>{error}</p> : 'Loading…'}</div>;

  // A task needs Claude only if it uses something the OpenAI connection lacks.
  const openaiFeatures = data.providers.find(p => p.id === 'openai')?.features || [];
  const needsClaude = t => (t.needs || []).some(n => !openaiFeatures.includes(n));
  const change = patch => { setDraft(d => ({ ...d, ...patch })); setSaved(s => ({ keys: 'keys' in patch ? false : s.keys, tasks: 'tasks' in patch || 'trials' in patch ? false : s.tasks })); };
  const setTask = (id, v) => change({ tasks: { ...draft.tasks, [id]: v } });
  const setTrial = (id, v) => change({ trials: { ...draft.trials, [id]: v } });
  // Two saves (user 2026-10-23): API keys, and task models (with trials). what: 'keys' | 'tasks' | 'all'.
  const save = async what => {
    setSaving(what); setError('');
    try {
      const body = {};
      if (what !== 'keys') Object.assign(body, { tasks: draft.tasks, trials: draft.trials });
      if (what !== 'tasks') for (const [p, v] of Object.entries(draft.keys)) if (v?.trim()) body[KEY_FIELD[p]] = v.trim();
      const d = await post(body);
      const newKeys = what !== 'tasks' ? Object.keys(draft.keys).filter(p => draft.keys[p]?.trim()) : [];
      const fresh = { ...data, ...d, providers: data.providers.map(p => newKeys.includes(p.id) ? { ...p, keySet: true } : p) };
      // Keep unsaved edits of the other part.
      setData(fresh);
      setDraft(dr => ({ ...dr, ...(what !== 'keys' ? { tasks: Object.fromEntries(fresh.tasks.map(t => [t.id, t.pinned])), trials: Object.fromEntries(fresh.tasks.map(t => [t.id, t.trial || null])) } : {}),
        ...(what !== 'tasks' ? { keys: {} } : {}) }));
      if (newKeys.length) refreshModels();
      setSaved(s => ({ keys: what !== 'tasks' ? true : s.keys, tasks: what !== 'keys' ? true : s.tasks }));
    } catch (e) { setError(e.message); }
    setSaving('');
  };
  const testModel = p => p === 'openai'
    ? ((models?.models || []).find(m => m.provider === 'openai' && m.newest && m.tier === 'luna')?.id || 'openai:gpt-6-luna')
    : p === 'gemini'
      ? ((models?.models || []).find(m => m.provider === 'gemini' && m.newest && m.tier === 'flash-lite')?.id || 'gemini:gemini-3.5-flash-lite')
      : 'claude-haiku-5-5';
  const runTest = async p => {
    setTests(t => ({ ...t, [p]: { busy: true } }));
    try {
      const d = await fetch(`/api/settings/test/anthropic?model=${encodeURIComponent(testModel(p))}`).then(r => r.json());
      setTests(t => ({ ...t, [p]: d }));
    } catch (e) { setTests(t => ({ ...t, [p]: { ok: false, error: e.message } })); }
  };
  const pinnedCount = Object.values(draft.tasks).filter(Boolean).length;

  // Comic Book Guy's three models talk to readers; the rest run in the background.
  const USER_FACING = new Set(['quick_answer', 'reading_list', 'long_answer']);
  // Lookups (Web Search, Summary Writer, Page Reader): one group, each with its own key-based default.
  const RECAP = new Set(['web_lookup', 'recap_web', 'recap_reader']);
  const groupOf = t => (RECAP.has(t.id) ? 'recap' : USER_FACING.has(t.id) ? 'user' : 'bg');
  const GROUPS = {
    quick: { user: { title: 'Reader-facing · First stop', note: 'Takes every question: answers it, points to a saved reading order, or passes it on.' },
      bg: { title: 'Background tasks', note: 'Behind-the-scenes checks; readers never see these directly.' } },
    generation: { user: { title: 'Reader-facing · Deep answers, recaps and reading lists', note: 'Gets the questions the first stop passes on, and writes every recap.' },
      bg: { title: 'Background tasks', note: 'Builds Top Shelf runs and Timeline events for admins.' } },
  };
  const ROLE = { quick_answer: 'Gatekeeper', reading_list: 'Builds new reading orders', long_answer: 'In-depth answers and recaps' };
  const RECAP_GROUP = { title: 'Lookups', note: 'Web Search finds pages and notes (Comic Book Guy\'s lookups, and the first step of a recap lookup); Summary Writer reads the pages it found and writes each issue summary; Page Reader reads the comic\'s own pages when the web was not good enough. Summaries are stored, so each issue is paid for once.' };
  const tierBlock = tier => (
    <div className={compact ? `settings-card ai-tier ai-tier-${tier}` : 'settings-card'} key={tier}>
      {compact ? <h3 className="ai-tier-title">{tier === 'quick' ? 'Quick Tasks' : 'Generator Tasks'}</h3> : <div className="settings-card-title">{tier === 'quick' ? 'Quick tasks' : 'Generator tasks'}</div>}
      {['user', 'recap', 'bg'].map(grp => {
        const user = grp !== 'bg';
        const list = data.tasks.filter(t => t.tier === tier && groupOf(t) === grp);
        if (!list.length) return null;
        const g = grp === 'recap' ? RECAP_GROUP : GROUPS[tier][grp];
        return (
      <div key={grp} className={compact ? 'ai-task-subgroup' : undefined} style={compact ? undefined : { marginTop: grp === 'user' ? 4 : 18, paddingTop: grp === 'user' ? 0 : 12, borderTop: grp === 'user' ? 'none' : '1px solid var(--border, rgba(127,127,127,0.25))' }}>
        {compact ? <div className="ai-subgroup-heading"><h4>{{ user: 'Reader-facing', recap: 'Lookups', bg: 'Admin Tools' }[grp]}</h4><details className="ai-heading-help"><summary aria-label={`About ${tier === 'quick' ? 'Quick Tasks' : 'Generator Tasks'} ${{ user: 'Reader-facing', recap: 'Lookups', bg: 'Admin Tools' }[grp]}`}>i</summary><p>{g.note}</p></details></div> : <><div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{g.title}</div><p className="form-hint" style={{ marginTop: 2, marginBottom: 10 }}>{g.note}</p></>}
      {list.map(t => {
        // Each task's recommended model is picked by which provider keys are saved (t.default, t.default_reason).
        const followsOpenAI = !draft.tasks[t.id] && isOpenAI(t.default);
        return (
          <TaskRow key={t.id} compact={compact} label={t.label}
            status={`${draft.tasks[t.id] ? 'Override' : 'Recommended'} · ${nameOf(draft.tasks[t.id] || t.default)}${draft.trials[t.id]?.model ? ` · Trial ${Math.round(draft.trials[t.id].share * 100)}%: ${nameOf(draft.trials[t.id].model)}` : ''}${needsClaude(t) ? ' · Claude only' : ''}${useLine(t.id) ? ` · ${useLine(t.id)}` : ''}`}>

            <label className="form-label">{t.label}{ROLE[t.id] ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> — {ROLE[t.id]}</span> : null}{needsClaude(t) ? ' · Claude only' : ''}</label>
            <ModelSelect compact={compact} ariaLabel={`${t.label} model`} value={draft.tasks[t.id] || ''} onChange={v => setTask(t.id, v)} showOlder={showOlder} claudeOnly={needsClaude(t)} lookup={!!t.gemini}
              inheritLabel={`Recommended (${nameOf(t.default)}${t.default_reason ? ` · ${t.default_reason}` : ''})`} />
            <p className="form-hint">{t.where}{useLine(t.id) ? ` Recent use: ${useLine(t.id)}.` : ''}</p>
            {!(draft.trials[t.id]?.model || trialOpen.has(t.id)) ? (
              <button type="button" className="adm-btn adm-btn-ghost" style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                onClick={() => setTrialOpen(s => new Set([...s, t.id]))}>+ Trial split (send some jobs to another model)</button>
            ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              <span className="form-hint" style={{ margin: 0 }}>Trial split:</span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <ModelSelect compact={compact} ariaLabel={`${t.label} trial model`} value={draft.trials[t.id]?.model || ''} showOlder={showOlder} claudeOnly={needsClaude(t)} lookup={!!t.gemini} inheritLabel="None — every job uses the model above"
                  onChange={v => setTrial(t.id, v ? { model: v, share: draft.trials[t.id]?.share || 0.25 } : null)} />
              </div>
              {draft.trials[t.id]?.model && (
                <select aria-label={`${t.label} trial share`} className="form-input" style={{ width: 'auto' }} value={draft.trials[t.id].share} onChange={e => setTrial(t.id, { ...draft.trials[t.id], share: Number(e.target.value) })}>
                  {[0.1, 0.25, 0.5].map(v => <option key={v} value={v}>{Math.round(v * 100)}% of jobs</option>)}
                </select>
              )}
            </div>
            )}
            {needsClaude(t) && followsOpenAI && <p className="form-hint" style={{ color: '#e8b04a' }}>Needs a Claude model: choose one here, or saving will be refused.</p>}
          </TaskRow>
        );
      })}
      </div>
        );
      })}
    </div>
  );

  const providers = (
        <div className="settings-card">
          {!compact && <div className="settings-card-title">Providers</div>}
          {data.providers.map(p => (
            <div key={p.id} style={{ marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label className="form-label">{p.label} API key</label>
                <input className="form-input" type="password" autoComplete="off"
                  placeholder={p.keySet ? `${p.label.split(' ')[0]} key saved — type a new ${p.label.split(' ')[0]} key to change it` : KEY_HINT[p.id]}
                  value={draft.keys[p.id] ?? ''} onChange={e => change({ keys: { ...draft.keys, [p.id]: e.target.value } })} />
                {p.fromEnv && <p className="form-hint">Using the key from the server environment until one is saved here.</p>}
                {p.id === 'gemini' && <p className="form-hint">Gemini is used only for web lookups with Google Search: used by default for Web Search and Recap – Page Reader once its key is saved, and can be chosen for Recap – Summary Writer and Top Shelf – Category Check. Its prices double on January 1, 2027. Searches are free up to 5,000 a month; turn on billing so Google does not use your content.</p>}
                {p.id === 'openai' && <p className="form-hint">OpenAI models can run every task, including web search (Timeline) and Comic Book Guy's library tools. Compare them with Claude in Usage &amp; results below.</p>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="adm-btn" style={{ fontSize: '0.8rem' }} onClick={() => runTest(p.id)} disabled={tests[p.id]?.busy || (!p.keySet && !draft.keys[p.id])}>
                  {tests[p.id]?.busy ? 'Testing…' : `Test ${p.label.split(' ')[0]}`}
                </button>
                {tests[p.id] && !tests[p.id].busy && <span className="form-hint" style={{ margin: 0, color: tests[p.id].ok ? '#6fcf8a' : 'color-mix(in srgb, var(--td-red) 80%, white)' }}>{tests[p.id].ok ? `Connected · ${tests[p.id].version}` : tests[p.id].error}</span>}
                {!p.keySet && draft.keys[p.id] && <span className="form-hint" style={{ margin: 0 }}>Save first, then test.</span>}
              </div>
            </div>
          ))}
        </div>
  );
  const status = what => (saved[what] ? 'Saved' : '');
  if (compact) return (
    <div className="ai-settings-refined">
      {error && <p role="alert" className="ai-error">{error}</p>}
      {notice && <p role="status" className="ai-warning">{notice}</p>}
      <div className="ai-heading"><div><h3>Providers &amp; API keys</h3><p className="form-hint">{data.providers.map(p => `${p.label}: ${p.keySet || p.fromEnv ? 'key configured' : 'key missing'}`).join(' · ')}</p></div></div>
      {providers}
      <div className="ai-save"><span role="status">{status('keys')}</span><button className="adm-btn adm-btn-primary" disabled={!!saving || !Object.values(draft.keys).some(v => v?.trim())} onClick={() => save('keys')}>{saving === 'keys' ? 'Saving…' : 'Save API keys'}</button></div>
      <details className="ai-disclosure"><summary><strong>Task models</strong><span>{pinnedCount} overrides · {Object.values(draft.trials).filter(t => t?.model).length} active trials</span></summary>
        <div className="ai-heading"><p className="form-hint">Each task uses its recommended model unless you choose another.</p>
          <label className="ai-check"><input type="checkbox" checked={showOlder} onChange={e => setShowOlder(e.target.checked)} /> Show older models</label></div>
        <div className="ai-task-groups">{tierBlock('quick')}{tierBlock('generation')}</div>
        <div className="ai-save">
          <button className="adm-btn" disabled={!pinnedCount} onClick={() => { setNotice(''); change({ tasks: Object.fromEntries(Object.keys(draft.tasks).map(k => [k, ''])) }); }}>Reset every task to its recommended model</button>
          <span role="status">{status('tasks')}</span><button className="adm-btn adm-btn-primary" disabled={!!saving} onClick={() => save('tasks')}>{saving === 'tasks' ? 'Saving…' : 'Save task models'}</button>
        </div>
      </details>
      {children}
      <details className="ai-disclosure"><summary><strong>Usage &amp; results</strong><span>All AI jobs</span></summary><AiUsage compact /></details>
    </div>
  );
  return (
    <div className="ai-models-settings">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <p className="form-hint" style={{ margin: 0, flex: 1, minWidth: 240 }}>
          Each task uses its recommended model (picked by the provider keys saved) unless you choose a specific model for it.
          Menus show the newest models of each connected provider with list prices (input / output per million tokens). Models Anthropic has retired or will retire within 90 days are not offered.
        </p>
        <label className="form-hint" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showOlder} onChange={e => setShowOlder(e.target.checked)} /> Show older models
        </label>
        <button className="adm-btn adm-btn-primary" onClick={() => save('all')} disabled={!!saving}>{saved.keys && saved.tasks ? '✓ Saved' : saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
      {error && <p className="form-hint" style={{ color: 'color-mix(in srgb, var(--td-red) 80%, white)' }}>{error}</p>}
      {notice && <p className="form-hint" style={{ color: '#e8b04a' }}>{notice}</p>}

      <div className="settings-two-col">
        {providers}

        <div className="settings-card">
          <div className="settings-card-title">Task models</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="adm-btn adm-btn-ghost" style={{ fontSize: '0.8rem' }} disabled={!pinnedCount}
              onClick={() => { setNotice(''); change({ tasks: Object.fromEntries(Object.keys(draft.tasks).map(k => [k, ''])) }); }}>
              Reset every task to its recommended model
            </button>
            <span className="form-hint" style={{ margin: 0 }}>{pinnedCount ? `${pinnedCount} task${pinnedCount === 1 ? '' : 's'} set to a specific model` : 'Every task uses its recommended model.'}</span>
          </div>
        </div>
      </div>

      <div className="settings-two-col" style={{ marginTop: 16 }}>
        {tierBlock('quick')}
        {tierBlock('generation')}
      </div>

      <AiUsage />
    </div>
  );
}

function TaskRow({ compact, label, status, children }) {
  return compact ? <details className="ai-task"><summary><strong>{label}</strong><span>{status}</span></summary><div className="ai-task-body">{children}</div></details> : <div className="form-group">{children}</div>;
}
