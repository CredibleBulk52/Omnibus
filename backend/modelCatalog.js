// ─── modelCatalog.js ──────────────────────────────────────────────
// Prices and plain-language notes for Claude models, for the Settings model
// menus and the assistant's cost estimates. The menus list the models the
// API key can actually use (GET /v1/models); this table adds price and notes,
// matched by family + version parsed from the model's name or id.
// List prices in USD per million tokens (platform.claude.com pricing, Oct 2026).
'use strict';

const PRICES = {
  'haiku 5.5':  { in: 0.10, out: 0.50 }, 'haiku 4.5': { in: 1, out: 5 },  'haiku 3.5': { in: 0.80, out: 4 },
  'sonnet 5.5': { in: 2, out: 10 },      'sonnet 5':  { in: 2, out: 10 }, 'sonnet 4.6': { in: 3, out: 15 },
  'sonnet 4.5': { in: 3, out: 15 },      'sonnet 4':  { in: 3, out: 15 },
  'opus 5.5':   { in: 4, out: 20 },      'opus 5':    { in: 5, out: 25 }, 'opus 4.8': { in: 5, out: 25 },
  'opus 4.7':   { in: 5, out: 25 },      'opus 4.6':  { in: 5, out: 25 }, 'opus 4.5': { in: 5, out: 25 },
  'opus 4.1':   { in: 15, out: 75 },     'opus 4':    { in: 15, out: 75 },
  'fable 5.1':  { in: 10, out: 50 },     'fable 5':   { in: 10, out: 50 },
};
const FAMILY_DEFAULT = { haiku: { in: 1, out: 5 }, sonnet: { in: 3, out: 15 }, opus: { in: 5, out: 25 }, fable: { in: 10, out: 50 }, mythos: { in: 25, out: 125 } };
const NOTES = {
  haiku:  'fast and inexpensive; lookups, validation, simple chat',
  sonnet: 'balanced; good conversation, reading orders, web search',
  opus:   'deepest knowledge and reasoning; slower, costs about twice Sonnet',
  fable:  'premium model for long agent work; far more than Omnibus needs',
};

// "Claude Sonnet 5.5" / "claude-sonnet-5-5-2026…" / "claude-3-5-haiku…" → { family, version }
function parse(idOrName = '') {
  const s = String(idOrName).toLowerCase();
  const fam = (s.match(/haiku|sonnet|opus|fable|mythos/) || [])[0];
  if (!fam) return null;
  let v = null, m;
  if ((m = s.match(new RegExp(`(\\d{1,2})[.-](\\d)[\\s-]+${fam}`)))) v = `${m[1]}.${m[2]}`;   // old "claude-3-5-haiku"
  else if ((m = s.match(new RegExp(`(\\d{1,2})[\\s-]+${fam}`)))) v = m[1];                   // old "claude-3-opus"
  else if ((m = s.match(new RegExp(`${fam}[\\s-]+(\\d{1,2})(?:[.-](\\d)(?!\\d))?(?![\\d])`)))) v = m[2] != null ? `${m[1]}.${m[2]}` : m[1];
  return { family: fam, version: v };
}

function price(idOrName) {
  // OpenAI ids ("openai:gpt-6-luna") use the OpenAI table below; Gemini ids ("gemini:gemini-3.8-flash") the Gemini table.
  if (/^openai:/.test(String(idOrName || ''))) return OPENAI_PRICES[String(idOrName).slice(7)] || { in: 2, out: 10 };
  if (/^gemini:/.test(String(idOrName || ''))) return geminiPrice(String(idOrName).slice(7));
  const p = parse(idOrName);
  if (!p) return { in: 3, out: 15 };
  return PRICES[`${p.family} ${p.version}`] || FAMILY_DEFAULT[p.family];
}

function describe(model) {
  const p = parse(model.display_name || model.id) || parse(model.id);
  const pr = price(model.display_name || model.id);
  const legacy = pr.in >= 15;
  return {
    id: model.id,
    name: model.display_name || model.id,
    family: p?.family || 'other',
    version: p?.version || '',
    input: pr.in, output: pr.out,
    note: legacy ? 'older generation; costs more than newer, better models' : (NOTES[p?.family] || ''),
    created_at: model.created_at || null,
  };
}

// Cheapest first; within a price, newest first. Models with a newer
// same-family model at the same price or less are flagged as superseded.
function sortModels(list) {
  const verNum = v => parseFloat(v || '0') || 0;
  for (const m of list) {
    const newer = list.filter(o => o.family === m.family && verNum(o.version) > verNum(m.version) && o.input <= m.input)
      .sort((a, b) => verNum(b.version) - verNum(a.version))[0];
    if (newer) m.note = `older; ${newer.name} is newer and costs the same or less`;
  }
  return list.sort((a, b) => (a.input - b.input) || (a.output - b.output) || (verNum(b.version) - verNum(a.version)) || a.name.localeCompare(b.name));
}

// Used when the models API can't be reached: the ids already in use here.
const FALLBACK = [
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
];

// Anthropic retirement dates (platform.claude.com model deprecations page,
// checked October 12, 2026). 'retired' = no longer served; a date = earliest
// or announced retirement. Update this table when Anthropic announces changes.
const RETIREMENT = {
  'opus 4': 'retired', 'sonnet 4': 'retired', 'opus 4.1': 'retired',
  'haiku 4.5': '2026-10-15', 'sonnet 4.5': '2026-11-30', 'opus 4.5': '2026-11-24',
  'opus 4.6': '2027-02-05', 'sonnet 4.6': '2027-02-17', 'opus 4.7': '2027-04-16', 'opus 4.8': '2027-05-28',
};
const IMMINENT_DAYS = 90;
// Not offered in menus: Mythos is a restricted research model.
const HIDDEN_FAMILIES = new Set(['mythos']);
const FAMILY_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

function retirement(model, now = Date.now()) {
  const p = parse(model?.name || model?.id || model) || {};
  const when = RETIREMENT[`${p.family} ${p.version}`];
  if (!when) return null;
  if (when === 'retired') return { retired: true, imminent: true, date: null };
  const days = Math.floor((Date.parse(when + 'T00:00:00Z') - now) / 86400000);
  return { retired: days <= 0, imminent: days <= IMMINENT_DAYS, date: when, days };
}

// Menus: Claude 4 or later, one id per family+version (most recently created),
// nothing retired or retiring within 90 days. Each model is marked newest in
// its family; the newest Haiku and Sonnet are the recommended Quick and
// Generation models. The page shows only the newest per family unless the
// person asks for older ones.
function currentModels(described, now = Date.now()) {
  const num = v => parseFloat(v || '0') || 0;
  const best = new Map();
  for (const m of described) {
    if (!FAMILY_ORDER.includes(m.family) || HIDDEN_FAMILIES.has(m.family) || num(m.version) < 4) continue;
    if (retirement(m, now)?.imminent) continue;
    const key = `${m.family} ${m.version}`, prev = best.get(key);
    const newer = !prev || String(m.created_at || '') > String(prev.created_at || '') || (String(m.created_at || '') === String(prev.created_at || '') && m.id.length < prev.id.length);
    if (newer) best.set(key, m);
  }
  const list = [...best.values()];
  for (const fam of FAMILY_ORDER) {
    const top = list.filter(m => m.family === fam).sort((a, b) => num(b.version) - num(a.version))[0];
    if (top) top.newest = true;
    if (top && fam === 'haiku') top.recommended = 'quick';
    if (top && fam === 'sonnet') top.recommended = 'generation';
  }
  for (const m of list) {
    const r = retirement(m, now);
    if (r?.date) m.retires = r.date;
  }
  return sortModels(list).sort((a, b) => (FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)) || (num(b.version) - num(a.version)));
}

// Same-family replacement for a model that is retired or retiring soon.
const REPLACEMENT = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
function replacementFor(id, now = Date.now()) {
  const p = parse(id);
  if (!p || !retirement(id, now)?.imminent) return null;
  return REPLACEMENT[p.family] || null;
}

// ─── OpenAI ───────────────────────────────────────────────────────
// Ids come from GET /v1/models with the OpenAI key; menus get the "openai:"
// prefix. Text models only (gpt-5.4 and later; no audio, realtime, image,
// specialised or dated snapshots). The newest major version shows by default.
// List prices (USD per million tokens), developers.openai.com, October 2026.
const OPENAI_PRICES = {
  'gpt-6-astra': { in: 10, out: 50 }, 'gpt-6.1-sol': { in: 2, out: 10 }, 'gpt-6-luna': { in: 0.10, out: 0.50 },
  'gpt-5.6-sol': { in: 5, out: 30 }, 'gpt-5.6-terra': { in: 2, out: 12 }, 'gpt-5.6-luna': { in: 0.20, out: 1.20 },
  'gpt-5.5': { in: 5, out: 30 }, 'gpt-5.4': { in: 2.5, out: 15 }, 'gpt-5.4-mini': { in: 0.75, out: 4.5 }, 'gpt-5.4-nano': { in: 0.20, out: 1.25 },
};
const OPENAI_TIER_NOTES = {
  luna: 'fast and inexpensive; lookups, validation, short text', nano: 'smallest and cheapest', mini: 'small and inexpensive',
  sol: 'balanced; strong writing and reasoning', terra: 'balanced', astra: 'most capable; costs like a premium model', '': 'general model',
};
const OPENAI_ID = /^gpt-(\d+(?:\.\d+)?)(?:-(astra|sol|terra|luna|mini|nano))?$/;
const OPENAI_FALLBACK = [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }];

function describeOpenAI(model) {
  const m = OPENAI_ID.exec(model.id);
  if (!m) return null;
  const version = m[1], tier = m[2] || '';
  const price = OPENAI_PRICES[model.id] || null;
  return {
    id: `openai:${model.id}`, provider: 'openai', family: 'openai', tier, version,
    name: `GPT-${version}${tier ? ' ' + tier[0].toUpperCase() + tier.slice(1) : ''}`,
    input: price ? price.in : null, output: price ? price.out : null,
    note: OPENAI_TIER_NOTES[tier] || '',
    created_at: model.created ? new Date(model.created * 1000).toISOString() : null,
  };
}

function currentOpenAIModels(raw) {
  const list = raw.map(describeOpenAI).filter(m => m && (parseFloat(m.version) || 0) >= 5.4);
  if (!list.length) return [];
  const major = Math.max(...list.map(m => Math.floor(parseFloat(m.version))));
  // Within the newest major version keep only the latest of each tier (6.1 Sol over 6 Sol).
  const latestTier = new Map();
  for (const m of list.filter(x => Math.floor(parseFloat(x.version)) === major)) {
    const prev = latestTier.get(m.tier);
    if (!prev || parseFloat(m.version) > parseFloat(prev.version)) latestTier.set(m.tier, m);
  }
  for (const m of latestTier.values()) m.newest = true;
  return list.sort((a, b) => (!!b.newest - !!a.newest) || ((a.input ?? 99) - (b.input ?? 99)) || (parseFloat(b.version) - parseFloat(a.version)));
}

// ─── Google Gemini (web lookups only, 2026-10-20) ─────────────────
// Ids come from GET /v1beta/models with the Gemini key; menus get the "gemini:" prefix and offer
// them only for lookup tasks (aiModels). Text Flash / Flash-Lite / Pro models that support Grounding
// with Google Search (ai.google.dev, October 2026; 3.1 Flash-Lite does not). Paid Standard prices
// per million tokens, checked 2026-10-20; Flash prices double on 2027-01-01. Searches: 5,000 a month
// free (shared by all Gemini 3+ models), then $14 per 1,000 queries.
const GEMINI_PRICES = {
  'gemini-3.8-flash': { in: 0.75, out: 3.75 }, 'gemini-3.6-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 }, 'gemini-3-flash-preview': { in: 0.50, out: 3.00 },
  'gemini-3.1-pro-preview': { in: 2, out: 12 }, 'gemini-4-argon': { in: 2, out: 10 },   // Argon doubles 2026-12-01
};
const GEMINI_NO_SEARCH = new Set(['gemini-3.1-flash-lite']);
// Text models only: "gemini-<version>-<flash-lite|flash|pro>" with optional "-preview…", "-001",
// "-latest" style suffixes, or a Gemini 4+ codename ("gemini-4-argon", Pro class). Speech, image,
// live, embedding and other special models are left out.
const GEMINI_ID = /^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)((?:-preview)?)(?:-[a-z0-9.-]+)?$/;
const GEMINI_CODENAME = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)$/;
const GEMINI_SPECIAL = /(tts|image|live|audio|embed|transcribe|translate|native|robotics|computer|banana|omni|aqa|learnlm|gemma|veo|imagen)/i;
const GEMINI_FALLBACK = [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-3.5-flash-lite' }];
const GEMINI_NOTES = { 'flash-lite': 'cheapest Gemini with Google Search; web lookups', flash: 'fast; web lookups with Google Search', pro: 'most capable Gemini; costs more than lookups need' };
function parseGemini(id) {
  id = String(id || '').replace(/^models\//, '');
  if (!id || GEMINI_SPECIAL.test(id) || GEMINI_NO_SEARCH.has(id)) return null;
  let m = GEMINI_ID.exec(id);
  if (m) return { id, version: m[1], tier: m[2], preview: /preview/.test(id), suffix: id.slice(`gemini-${m[1]}-${m[2]}`.length) };
  m = GEMINI_CODENAME.exec(id);
  if (m && parseFloat(m[1]) >= 4 && !['flash', 'pro', 'lite'].includes(m[2])) return { id, version: m[1], tier: 'pro', codename: m[2], preview: false, suffix: '' };
  return null;
}
const geminiPrice = id => GEMINI_PRICES[id] || GEMINI_PRICES[String(id).replace(/-(\d{3}|latest)$/, '')] || ({ 'flash-lite': { in: 0.30, out: 2.50 }, flash: { in: 0.75, out: 3.75 }, pro: { in: 2, out: 12 } })[(parseGemini(id) || {}).tier] || { in: 0.75, out: 3.75 };

function describeGemini(model) {
  const g = parseGemini(model.name || model.id);
  if (!g || (parseFloat(g.version) || 0) < 3) return null;
  const p = GEMINI_PRICES[g.id] || GEMINI_PRICES[g.id.replace(/-(\d{3}|latest)$/, '')] || null;
  const tierName = { 'flash-lite': 'Flash-Lite', flash: 'Flash', pro: 'Pro' }[g.tier];
  const label = g.codename ? `Gemini ${g.version} ${g.codename[0].toUpperCase()}${g.codename.slice(1)}` : `Gemini ${g.version} ${tierName}${g.preview ? ' Preview' : ''}`;
  return {
    id: `gemini:${g.id}`, provider: 'gemini', family: 'gemini', tier: g.tier, version: g.version, preview: g.preview, plain: !g.suffix || g.suffix === '-preview',
    name: model.displayName && !g.codename ? model.displayName : label,
    input: p ? p.in : null, output: p ? p.out : null,
    note: `${GEMINI_NOTES[g.tier]}${p && (g.tier === 'flash' || g.codename) ? '; price doubles soon (see Google pricing)' : ''}`,
    created_at: null,
  };
}

// Newest of each tier (Flash-Lite, Flash, Pro); released over preview, the plain id over a dated or
// "-latest" alias of the same model.
function currentGeminiModels(raw) {
  const list = raw.map(describeGemini).filter(Boolean);
  const best = new Map();
  for (const m of list) {
    const prev = best.get(m.tier);
    const v = x => parseFloat(x.version) || 0;
    const better = !prev || (prev.preview && !m.preview) || (prev.preview === m.preview && (v(m) > v(prev) || (v(m) === v(prev) && m.plain && !prev.plain)));
    if (better) best.set(m.tier, m);
  }
  for (const m of best.values()) m.newest = true;
  return list.sort((a, b) => (!!b.newest - !!a.newest) || ((a.input ?? 99) - (b.input ?? 99)) || (parseFloat(b.version) - parseFloat(a.version)));
}

// ─── Cross-provider helpers ───────────────────────────────────────
// What a model is for: fast (Haiku / Luna, Nano, Mini), balanced (Sonnet /
// Sol, Terra), deep (Opus / Astra), premium (Fable). Used for the usage view
// and to pick the matching model on the other provider for side-by-side tests.
function modelClass(id) {
  const s = String(id || '');
  const o = /^openai:/.test(s) ? OPENAI_ID.exec(s.slice(7)) : null;
  const g = /^gemini:/.test(s) ? parseGemini(s.slice(7)) : null;
  if (g) return g.tier === 'pro' ? 'balanced' : 'fast';
  if (o) return ['luna', 'nano', 'mini'].includes(o[2]) ? 'fast' : o[2] === 'astra' ? 'deep' : 'balanced';
  return { haiku: 'fast', sonnet: 'balanced', opus: 'deep', fable: 'premium' }[parse(s)?.family] || 'balanced';
}
const EQUIVALENT = {
  anthropic: { fast: 'claude-haiku-5-5', balanced: 'claude-sonnet-5-5', deep: 'claude-opus-5-5', premium: 'claude-fable-5-1' },
  openai: { fast: 'openai:gpt-6-luna', balanced: 'openai:gpt-6.1-sol', deep: 'openai:gpt-6-astra', premium: 'openai:gpt-6-astra' },
};
function equivalentModel(id, provider) {
  const current = /^(openai|gemini):/.exec(String(id || ''))?.[1] || 'anthropic';
  return current === provider ? id : EQUIVALENT[provider]?.[modelClass(id)] || id;
}
// Per web search in USD: Claude and OpenAI about $0.01; Gemini's Google searches are free up to
// 5,000 a month (then $0.014), counted here as free.
const searchFee = model => (/^gemini:/.test(String(model || '')) ? 0 : 0.01);
// Estimated cost in USD from token counts (list prices; cached input at 10%
// of input, cache writes at 125%, plus web searches).
function estimateCost(model, { input_tokens = 0, output_tokens = 0, cache_read = 0, cache_write = 0, web_searches = 0 } = {}) {
  const p = price(model);
  return (input_tokens * p.in + output_tokens * p.out + cache_read * p.in * 0.1 + cache_write * p.in * 1.25) / 1e6 + web_searches * searchFee(model);
}

// "Claude · Haiku 5.5" / "OpenAI · GPT-6 Luna" for any stored model id.
function displayName(id) {
  const s = String(id || '');
  if (/^openai:/.test(s)) { const d = describeOpenAI({ id: s.slice(7) }); return `OpenAI · ${d ? d.name : s.slice(7)}`; }
  if (/^gemini:/.test(s)) { const d = describeGemini({ id: s.slice(7) }); return `Google · ${d ? d.name : s.slice(7)}`; }
  const p = parse(s);
  return p ? `Claude · ${p.family[0].toUpperCase()}${p.family.slice(1)}${p.version ? ' ' + p.version : ''}` : s;
}

module.exports = { parse, price, describe, sortModels, currentModels, retirement, replacementFor, FALLBACK, RETIREMENT, displayName,
  describeOpenAI, currentOpenAIModels, OPENAI_FALLBACK, OPENAI_PRICES, describeGemini, currentGeminiModels, GEMINI_FALLBACK, GEMINI_PRICES,
  modelClass, equivalentModel, estimateCost, searchFee };
