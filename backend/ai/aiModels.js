'use strict';
// ─── AI model routing ─────────────────────────────────────────────
// Every task has its own recommended model (2026-10-23: the two top-level default models were
// retired). A task uses its recommended model unless it is set to a specific one.
// `fallback` is a preference list: the first model whose provider key is saved is used, so any key
// works on a first deploy. The recommendations come from tests and measured costs (project notes:
// FOLLOW_UPS "Tested costs per use", MODEL_AUDIT, LOOKUP_BENCHMARKS). Settings: ai_task_<id> ('' = recommended).
// Tiers (quick / generation) remain only as the two groups on the settings page and in Usage.
// Provider is decided by the model id, so other providers can be added later
// ("openai:gpt-…", "gemini:gemini-…"). Gemini runs only tasks marked gemini: true (lookups and page reading).

const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5', LUNA = 'openai:gpt-6-luna', SOL = 'openai:gpt-6.1-sol';
const TIERS = Object.freeze({
  quick: { key: 'ai_model_quick', label: 'Quick model', fallback: 'claude-haiku-5-5',
    note: 'Fast, inexpensive checks and short answers.' },
  generation: { key: 'ai_model_generation', label: 'Generation model', fallback: 'claude-sonnet-5-5',
    note: 'Writing and research: reading orders, events, Top Shelf runs, long answers.' },
});

const TASKS = Object.freeze([
  { id: 'enricher', tier: 'quick', fallback: [HAIKU, LUNA], label: 'Enricher', where: 'Series descriptions and genres (Enrich / Create series.json, background enrichment).' },
  { id: 'annual_validator', tier: 'quick', fallback: [HAIKU, LUNA], label: 'Annual Validator', where: 'Decides which annual volumes belong to a series when annuals are linked.' },
  { id: 'annual_match', tier: 'quick', fallback: [HAIKU, LUNA], label: 'Annual Match Picker', where: 'Chooses the Comic Vine issue for an annual file the matching rules could not place (metadata checks).' },
  { id: 'topshelf_categories', tier: 'quick', fallback: [HAIKU, LUNA], label: 'Top Shelf – Category Check', where: 'Checks Top Shelf runs on the web for adapted to screen, award winning and critically acclaimed; you review the changes before they apply.', needs: ['web_search'], gemini: true },
  { id: 'event_notes', tier: 'quick', fallback: [HAIKU, LUNA], label: 'Event Tier Notes', where: 'Writes the reader-facing tier notes for event issues (Write tier notes with AI) from the generator\'s tier reasons, the issues\' solicits and saved synopses; no web search.' },
  { id: 'quick_answer', tier: 'quick', fallback: [LUNA, HAIKU], label: 'Quick Answers', where: 'Comic Book Guy\'s first stop for every question: answers it, points to a saved reading order, or passes it on (new reading orders, deep answers and recaps).', needs: ['tools'] },
  { id: 'topshelf', tier: 'generation', fallback: [OPUS, SOL], label: 'Top Shelf – Run Generator', where: 'Generates Top Shelf runs (uses web search).', needs: ['web_search'] },
  { id: 'timeline', tier: 'generation', fallback: [SONNET, SOL], label: 'Timeline – Crossover Event Generator', where: 'Generates event reading orders (reads guide pages; searches only when Omnibus finds none).', needs: ['web_search'] },
  { id: 'reading_list', tier: 'generation', fallback: [SOL, SONNET], label: 'Reading List Generator', where: 'Comic Book Guy: builds new reading orders when nothing saved covers the question, and edits on a reading list page (can web search).', needs: ['tools', 'web_search'] },
  { id: 'long_answer', tier: 'generation', fallback: [SOL, SONNET], label: 'Long Answers', where: 'Comic Book Guy: questions the first stop passes on because they need depth, and every recap ("Previously on…"), written from the summaries the two Recap tasks gather (can web search).', needs: ['tools', 'web_search'] },
  // Lookups (2026-10-20, docs/AI_MODELS.md "Lookups"). Each job has its own default: a preference
  // list, of which the first model whose provider key is saved is used, so a first deploy works
  // with whatever keys the admin enters. Ids kept from earlier versions so saved choices carry over.
  // Web Search: finds pages and returns notes and sources, for Comic Book Guy's web_lookup tool
  // (whichever model runs Quick Answers) and as step 1 of recap lookups. Gemini first: Google's
  // search, free up to 5,000 searches a month; 3.8 Flash found more trustworthy pages than
  // Flash-Lite for about 0.1¢ more (lookup comparison 2026-10-20).
  { id: 'web_lookup', tier: 'quick', label: 'Web Search', fallback: ['gemini:gemini-3.8-flash', 'claude-haiku-5-5', 'openai:gpt-6-luna'], where: 'Searches the web and returns notes with sources: Comic Book Guy\'s one lookup per question, and the first step of a recap lookup (finding pages about the issue).', needs: ['web_search'], gemini: true },
  // Recap – Summary Writer: reads the pages Web Search found (Omnibus downloads them) and writes the
  // issue summary with a confidence rating; searches itself only when none of the pages could be read.
  // Also writes story-arc summaries. Haiku first: its ratings were honest in the 2026-10-20 comparison.
  { id: 'recap_web', tier: 'quick', label: 'Recap – Summary Writer', fallback: ['claude-haiku-5-5', 'openai:gpt-6-luna'], where: 'Reads the pages Web Search found and writes a short summary of what happened in an issue or story arc, with how sure it is. Each summary is stored, so an issue is paid for once.', needs: ['web_search'], gemini: true },
  // Recap – Page Reader: reads the comic's own pages when the web was not good enough. Gemini 3.8 Flash
  // first (2026-10-20, three issues the user has read: as accurate as Sol or more, about half the cost
  // until Google's January 2027 price rise; recheck then), then Sol, then Sonnet. In the Lookups group.

  { id: 'recap_reader', tier: 'quick', label: 'Recap – Page Reader', fallback: ['gemini:gemini-3.8-flash', 'openai:gpt-6.1-sol', 'claude-sonnet-5-5'], where: 'Reads an issue\'s own pages when the web summary was not good enough, only for the last few issues of a recap. Needs a model that reads comic pages well (tested: Gemini 3.8 Flash and Sol; Haiku and Luna misread them).', needs: ['images'], gemini: true },
]);
const TASK_IDS = new Set(TASKS.map(t => t.id));
const taskKey = id => `ai_task_${id}`;
// Trial split: send a share of a task's jobs to another model so both appear in
// Usage under the same conditions. Stored as JSON { model, share } (0 < share < 1).
const trialKey = id => `ai_trial_${id}`;
const TRIAL_SHARES = [0.1, 0.25, 0.5];

// hasProvider(provider): whether that provider's key is saved (server.js); used to pick a task's
// default from its preference list. Without it every provider counts as available.
function createModelRouting(getSetting, { hasProvider = () => true } = {}) {
  const read = key => { const v = getSetting(key); return typeof v === 'string' ? v.trim() : ''; };
  const topLevel = tier => TIERS[tier].fallback;   // the old top-level settings are no longer read
  // A task's own default: the first model in its list whose provider is connected (else the first).
  const listOf = task => (Array.isArray(task.fallback) ? task.fallback : task.fallback ? [task.fallback] : []);
  const defaultFor = task => { const list = listOf(task); return list.find(m => hasProvider(providerOfModel(m))) || list[0] || null; };
  const NAME = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' };
  const defaultReason = task => {
    const list = listOf(task);
    if (list.length < 2) return null;
    const pick = defaultFor(task), i = list.indexOf(pick);
    if (!hasProvider(providerOfModel(pick))) return `no ${[...new Set(list.map(m => NAME[providerOfModel(m)]))].join(', ')} key saved`;
    return i === 0 ? null : `no ${[...new Set(list.slice(0, i).map(m => NAME[providerOfModel(m)]))].join(' or ')} key saved`;   // said only when it falls back
  };
  function modelFor(taskOrTier) {
    if (TIERS[taskOrTier]) return topLevel(taskOrTier);
    const task = TASKS.find(t => t.id === taskOrTier);
    if (!task) throw new Error(`Unknown AI task: ${taskOrTier}`);
    return read(taskKey(task.id)) || defaultFor(task) || topLevel(task.tier);
  }
  function trialFor(taskId) {
    try {
      const t = JSON.parse(read(trialKey(taskId)) || 'null');
      return t && t.model && t.share > 0 && t.share < 1 ? { model: String(t.model), share: Number(t.share) } : null;
    } catch { return null; }
  }
  // The model for one job: the task's model, or its trial model for a share of jobs.
  function pick(taskId, random = Math.random) {
    const base = modelFor(taskId), trial = TIERS[taskId] ? null : trialFor(taskId);
    return trial && trial.model !== base && random() < trial.share ? trial.model : base;
  }
  function snapshot() {
    return {
      tasks: TASKS.map(t => ({ ...t, pinned: read(taskKey(t.id)) || '', effective: modelFor(t.id), trial: trialFor(t.id),
        default: defaultFor(t), default_reason: defaultReason(t) })),
    };
  }
  return { modelFor, pick, trialFor, snapshot };
}

// One-time move from the older settings (validation/event models and the
// assistant's two models). Returns the rows to write; nothing if already done.
function migrationRows(getSetting) {
  const has = key => { const v = getSetting(key); return typeof v === 'string' && v.trim() !== ''; };
  if (has(RETIRE_MARKER) || has(TIERS.quick.key) || has(TIERS.generation.key)) return [];
  const v = key => (getSetting(key) || '').trim();
  const quick = v('anthropic_validation_model') || TIERS.quick.fallback;
  const generation = v('anthropic_event_model') || TIERS.generation.fallback;
  const rows = [[TIERS.quick.key, quick], [TIERS.generation.key, generation]];
  const qa = v('assistant_model'), list = v('assistant_list_model');
  if (qa && qa !== quick) rows.push([taskKey('quick_answer'), qa]);
  if (list && list !== generation) rows.push([taskKey('reading_list'), list], [taskKey('long_answer'), list]);
  return rows;
}

// Retiring the top-level models (2026-10-23), once: a task that followed one and whose new
// recommended model differs is set to the model it was using, so nothing changes; then the two
// settings are removed. Returns { rows: [[key, value]], remove: [keys] }.
const RETIRE_MARKER = 'ai_tiers_retired_2026_10';
const OLD_OWN_DEFAULT = new Set(['web_lookup', 'recap_web', 'recap_reader']);   // tasks that had their own defaults before
function retireTierRows(getSetting, opts = {}) {
  const v = key => { const x = getSetting(key); return typeof x === 'string' ? x.trim() : ''; };
  if (v(RETIRE_MARKER)) return { rows: [], remove: [] };
  const routing = createModelRouting(getSetting, opts);
  const rows = [];
  for (const t of TASKS) {
    if (v(taskKey(t.id)) || OLD_OWN_DEFAULT.has(t.id)) continue;
    const old = v(TIERS[t.tier].key) || TIERS[t.tier].fallback, now = routing.modelFor(t.id);
    if (old !== now) rows.push([taskKey(t.id), old]);
  }
  rows.push([RETIRE_MARKER, 'done']);
  return { rows, remove: [TIERS.quick.key, TIERS.generation.key] };
}

// Accepts { tasks: { id: modelId | '' }, trials }; returns rows to write. (quick/generation are no longer settings.)
function settingsRows(body = {}) {
  const rows = [];
  const clean = value => {
    if (value == null) return null;
    const s = String(value).trim();
    if (s.length > 200 || /[\s"'<>]/.test(s)) throw new Error('Invalid model id');
    return s;
  };
  for (const [id, value] of Object.entries(body.tasks || {})) {
    if (!TASK_IDS.has(id)) throw new Error(`Unknown AI task: ${id}`);
    rows.push([taskKey(id), clean(value) || '']);
  }
  for (const [id, value] of Object.entries(body.trials || {})) {
    if (!TASK_IDS.has(id)) throw new Error(`Unknown AI task: ${id}`);
    const model = value && clean(value.model), share = Number(value?.share);
    if (!model) { rows.push([trialKey(id), '']); continue; }
    if (!TRIAL_SHARES.includes(share)) throw new Error('Trial share must be 10%, 25% or 50%');
    rows.push([trialKey(id), JSON.stringify({ model, share })]);
  }
  return rows;
}

// One-time move to the current models (October 2026): Quick → Haiku 5.5 and
// Generation → Sonnet 5.5 when they are older Haiku/Sonnet versions, and any
// task pinned to a model that is retired or retiring soon → its family's 5.5.
const UPGRADE_MARKER = 'ai_models_upgrade_2026_10';
function upgradeRows(getSetting, catalog, now = Date.now()) {
  if ((getSetting(UPGRADE_MARKER) || '') === 'done') return [];
  const rows = [], v = key => (getSetting(key) || '').trim();
  const older = (id, family, target) => { const p = catalog.parse(id); return p && p.family === family && (parseFloat(p.version) || 0) < target; };
  const quick = v(TIERS.quick.key), generation = v(TIERS.generation.key);
  if (quick && (older(quick, 'haiku', 5.5) || catalog.replacementFor(quick, now))) rows.push([TIERS.quick.key, catalog.replacementFor(quick, now) && !older(quick, 'haiku', 5.5) ? catalog.replacementFor(quick, now) : 'claude-haiku-5-5']);
  if (generation && (older(generation, 'sonnet', 5.5) || catalog.replacementFor(generation, now))) rows.push([TIERS.generation.key, catalog.replacementFor(generation, now) && !older(generation, 'sonnet', 5.5) ? catalog.replacementFor(generation, now) : 'claude-sonnet-5-5']);
  for (const t of TASKS) {
    const pinned = v(taskKey(t.id)), next = pinned && catalog.replacementFor(pinned, now);
    if (next) rows.push([taskKey(t.id), next]);
  }
  rows.push([UPGRADE_MARKER, 'done']);
  return rows;
}

// What each provider can do in Omnibus. Claude and OpenAI run every task (OpenAI through
// ai/openaiAdapter.js); Gemini only lookups and page reading (ai/geminiAdapter.js, tasks with gemini: true).
const PROVIDER_FEATURES = { anthropic: ['tools', 'web_search', 'images'], openai: ['tools', 'web_search', 'images'], gemini: ['web_search', 'images'] };
const LOOKUP_ONLY = new Set(['gemini']);
const providerOfModel = model => (/^([a-z][a-z0-9_-]*):/.exec(String(model || '')) || [])[1] || 'anthropic';
const supports = (model, needs = []) => needs.every(n => (PROVIDER_FEATURES[providerOfModel(model)] || []).includes(n));

// Tasks whose resolved model cannot do what they need (e.g. an OpenAI model
// on Timeline, which needs web search). getSetting may be a proposed state.
function routingProblems(getSetting, opts) {
  const routing = createModelRouting(getSetting, opts);
  const problems = [];
  for (const t of TASKS) {
    const models = [routing.modelFor(t.id), routing.trialFor(t.id)?.model].filter(Boolean);
    for (const model of models) {
      const lookupOnly = LOOKUP_ONLY.has(providerOfModel(model)) && !t.gemini;
      if (lookupOnly || (t.needs?.length && !supports(model, t.needs))) {
        problems.push({ id: t.id, label: t.label, model, needs: t.needs || [], reason: lookupOnly ? 'lookup_only' : 'needs' });
        break;
      }
    }
  }
  return problems;
}

module.exports = { TIERS, TASKS, taskKey, trialKey, TRIAL_SHARES, createModelRouting, migrationRows, retireTierRows, settingsRows, upgradeRows, routingProblems, supports, providerOfModel, PROVIDER_FEATURES, LOOKUP_ONLY };
