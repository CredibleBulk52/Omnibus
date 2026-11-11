'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRouting, migrationRows, retireTierRows, settingsRows, TASKS } = require('./aiModels');
const { createAiClient } = require('./aiClient');
const catalog = require('../modelCatalog');
const store = obj => key => (key in obj ? obj[key] : null);

test('tasks use their recommended model unless pinned; the old top-level settings are ignored', () => {
  const r = createModelRouting(store({ ai_model_quick: 'q', ai_model_generation: 'g', ai_task_topshelf: 'pinned' }));
  assert.equal(r.modelFor('enricher'), 'claude-haiku-5-5');
  assert.equal(r.modelFor('timeline'), 'claude-sonnet-5-5');
  assert.equal(r.modelFor('quick_answer'), 'openai:gpt-6-luna');
  assert.equal(r.modelFor('long_answer'), 'openai:gpt-6.1-sol');
  assert.equal(r.modelFor('topshelf'), 'pinned');
  assert.equal(r.modelFor('quick'), 'claude-haiku-5-5');
  const claudeOnly = createModelRouting(store({}), { hasProvider: p => p === 'anthropic' });
  assert.equal(claudeOnly.modelFor('quick_answer'), 'claude-haiku-5-5');
  assert.equal(claudeOnly.modelFor('reading_list'), 'claude-sonnet-5-5');
  assert.equal(claudeOnly.modelFor('topshelf'), 'claude-opus-5-5');
  assert.equal(claudeOnly.snapshot().tasks.find(t => t.id === 'quick_answer').default_reason, 'no OpenAI key saved');
  assert.throws(() => r.modelFor('nope'));
  const snap = r.snapshot();
  assert.equal(snap.tasks.length, TASKS.length);
  assert.equal(snap.tasks.find(t => t.id === 'topshelf').pinned, 'pinned');
});

test('migration carries the old models over once', () => {
  const rows = migrationRows(store({ anthropic_validation_model: 'h', anthropic_event_model: 's', assistant_model: 'x', assistant_list_model: 's' }));
  assert.deepEqual(Object.fromEntries(rows), { ai_model_quick: 'h', ai_model_generation: 's', ai_task_quick_answer: 'x' });
  assert.deepEqual(migrationRows(store({ ai_model_quick: 'h' })), []);
  assert.deepEqual(migrationRows(store({ ai_tiers_retired_2026_10: 'done', anthropic_validation_model: 'h' })), []);
});

test('retiring the top-level models keeps what each task was using', () => {
  const all = { hasProvider: () => true };
  // Followed Quick = Haiku (now its recommendation): nothing pinned. Followed Generation = Opus: pinned to Opus where it differs.
  const r = retireTierRows(store({ ai_model_quick: 'claude-haiku-5-5', ai_model_generation: 'claude-opus-5-5', ai_task_reading_list: 'openai:gpt-6.1-sol' }), all);
  assert.deepEqual(Object.fromEntries(r.rows), { ai_task_timeline: 'claude-opus-5-5', ai_task_long_answer: 'claude-opus-5-5', ai_task_quick_answer: 'claude-haiku-5-5', ai_tiers_retired_2026_10: 'done' });
  assert.deepEqual(r.remove, ['ai_model_quick', 'ai_model_generation']);
  assert.deepEqual(retireTierRows(store({ ai_tiers_retired_2026_10: 'done' }), all), { rows: [], remove: [] });
});

test('settings rows validate tasks and ids (top-level models are no longer saved)', () => {
  assert.deepEqual(settingsRows({ quick: 'a', tasks: { enricher: '', timeline: 'b' } }), [['ai_task_enricher', ''], ['ai_task_timeline', 'b']]);
  assert.throws(() => settingsRows({ tasks: { bogus: 'a' } }));
  assert.throws(() => settingsRows({ tasks: { enricher: 'bad id' } }));
});

test('shared client builds one request style: no beta header, web search tool, joined text', async () => {
  let sent;
  const axios = { post: async (url, body, cfg) => { sent = { url, body, cfg }; return { data: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }; } };
  const ai = createAiClient({ axios, getAnthropicKey: () => 'k', modelFor: id => `model-for-${id}` });
  const r = await ai.complete({ task: 'timeline', prompt: 'hi', webSearch: 3, maxTokens: 100 });
  assert.equal(r.text, 'ab');
  assert.equal(sent.body.model, 'model-for-timeline');
  assert.deepEqual(sent.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  assert.equal(sent.cfg.headers['anthropic-beta'], undefined);
  assert.equal(sent.cfg.headers['anthropic-version'], '2023-06-01');
  await assert.rejects(ai.complete({ model: 'mistral:large', prompt: 'hi' }), e => e.code === 'AI_PROVIDER_UNAVAILABLE');
  const noKey = createAiClient({ axios, getAnthropicKey: () => '', modelFor: () => 'm' });
  await assert.rejects(noKey.complete({ task: 'x', prompt: 'hi' }), e => e.code === 'AI_KEY_MISSING');
});

test('model menus drop retired or soon-retiring models and mark the recommended picks', () => {
  const now = Date.parse('2026-10-12');
  const raw = ['claude-3-5-haiku-20241022|Claude Haiku 3.5', 'claude-haiku-4-5-20251001|Claude Haiku 4.5', 'claude-haiku-5-5|Claude Haiku 5.5',
    'claude-sonnet-4-5-20250929|Claude Sonnet 4.5', 'claude-sonnet-4-6|Claude Sonnet 4.6', 'claude-sonnet-5-5|Claude Sonnet 5.5',
    'claude-opus-4-1-20250805|Claude Opus 4.1', 'claude-opus-4-5-20251101|Claude Opus 4.5', 'claude-opus-5-5|Claude Opus 5.5',
    'claude-fable-5-1|Claude Fable 5.1', 'claude-mythos-5-1|Claude Mythos 5.1'].map(x => { const [id, display_name] = x.split('|'); return { id, display_name }; });
  const list = catalog.currentModels(raw.map(catalog.describe), now);
  assert.deepEqual(list.map(m => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-fable-5-1']);
  assert.equal(list.find(m => m.id === 'claude-haiku-5-5').recommended, 'quick');
  assert.equal(list.find(m => m.id === 'claude-sonnet-5-5').recommended, 'generation');
  assert.equal(list.find(m => m.id === 'claude-sonnet-4-6').newest, undefined);
});

test('one-time upgrade moves to Haiku 5.5 / Sonnet 5.5 and replaces soon-retiring pins', () => {
  const { upgradeRows } = require('./aiModels');
  const now = Date.parse('2026-10-12');
  const rows = Object.fromEntries(upgradeRows(store({ ai_model_quick: 'claude-haiku-4-5-20251001', ai_model_generation: 'claude-sonnet-4-6',
    ai_task_topshelf: 'claude-sonnet-4-5-20250929', ai_task_long_answer: 'claude-opus-5-5' }), catalog, now));
  assert.deepEqual(rows, { ai_model_quick: 'claude-haiku-5-5', ai_model_generation: 'claude-sonnet-5-5', ai_task_topshelf: 'claude-sonnet-5-5', ai_models_upgrade_2026_10: 'done' });
  assert.deepEqual(upgradeRows(store({ ai_models_upgrade_2026_10: 'done' }), catalog, now), []);
});

test('OpenAI models go to the Responses API and come back in the shared reply shape', async () => {
  let sent;
  const axios = { post: async (url, body, cfg) => { sent = { url, body, cfg }; return { data: { id: 'r1', model: 'gpt-6-luna', status: 'completed',
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 5, output_tokens: 2 } } }; } };
  const ai = createAiClient({ axios, getAnthropicKey: () => 'a', getOpenAIKey: () => 'o', modelFor: () => 'openai:gpt-6-luna' });
  const r = await ai.complete({ task: 'topshelf', system: 'be brief', prompt: 'hi', maxTokens: 500 });
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(sent.body, { model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], max_output_tokens: 500, store: false, instructions: 'be brief' });
  assert.equal(sent.cfg.headers.Authorization, 'Bearer o');
  assert.equal(r.text, 'hello'); assert.equal(r.stopReason, 'end_turn'); assert.equal(r.data.content[0].text, 'hello');
  const cut = createAiClient({ axios: { post: async () => ({ data: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }) }, getAnthropicKey: () => 'a', getOpenAIKey: () => 'o', modelFor: () => 'openai:x' });
  assert.equal((await cut.complete({ task: 'x', prompt: 'hi' })).stopReason, 'max_tokens');
  const noKey = createAiClient({ axios, getAnthropicKey: () => 'a', getOpenAIKey: () => '', modelFor: () => 'openai:x' });
  await assert.rejects(noKey.complete({ task: 'x', prompt: 'hi' }), e => e.code === 'AI_KEY_MISSING');
});

test('every task can now run on OpenAI; an unknown provider still cannot', () => {
  const { routingProblems, PROVIDER_FEATURES } = require('./aiModels');
  assert.deepEqual(routingProblems(store(Object.fromEntries(TASKS.filter(t => !t.gemini).map(t => [`ai_task_${t.id}`, 'openai:gpt-6.1-sol'])))), []);
  assert.deepEqual(PROVIDER_FEATURES.openai.sort(), ['images', 'tools', 'web_search']);
  assert.ok(routingProblems(store({ ai_task_quick_answer: 'mistral:large' })).some(p => p.id === 'quick_answer'));
});

test('OpenAI menu keeps current text models and flags the newest major version', () => {
  const raw = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-4o', 'o3', 'gpt-realtime-2', 'gpt-5.6-cyber', 'gpt-6-luna-2026-09-03', 'text-embedding-3-small'].map(id => ({ id }));
  const list = catalog.currentOpenAIModels(raw);
  assert.deepEqual(list.filter(m => m.newest).map(m => m.id).sort(), ['openai:gpt-6-astra', 'openai:gpt-6-luna', 'openai:gpt-6.1-sol']);
  assert.deepEqual(list.filter(m => !m.newest).map(m => m.id).sort(), ['openai:gpt-5.6-terra', 'openai:gpt-6-sol']);
});

test('OpenAI adapter: tools, tool results, images, web search and replay', () => {
  const { toOpenAI, fromOpenAI, anthropicSafe } = require('./openaiAdapter');
  const req = toOpenAI({ model: 'openai:gpt-6-luna', max_tokens: 900,
    system: [{ type: 'text', text: 'You are CBG.', cache_control: { type: 'ephemeral' } }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }, { name: 'search_series', description: 'find', input_schema: { type: 'object', properties: { q: { type: 'string' } } }, cache_control: { type: 'ephemeral' } }],
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: 'Who is Hal Jordan?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'search_series', input: { q: 'Green Lantern' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Page 1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] },
    ] });
  assert.equal(req.model, 'gpt-6-luna'); assert.equal(req.instructions, 'You are CBG.'); assert.equal(req.store, false);
  assert.deepEqual(req.tools[0], { type: 'web_search' });
  assert.equal(req.tools[1].name, 'search_series'); assert.equal(req.tool_choice, 'auto');
  assert.deepEqual(req.input[0], { role: 'user', content: [{ type: 'input_text', text: 'Who is Hal Jordan?' }] });
  assert.deepEqual(req.input[2], { type: 'function_call', call_id: 'toolu_1', name: 'search_series', arguments: '{"q":"Green Lantern"}' });
  assert.deepEqual(req.input[3], { type: 'function_call_output', call_id: 'toolu_1', output: 'Page 1' });
  assert.equal(req.input[4].content[1].image_url, 'data:image/png;base64,AAA');

  const reply = fromOpenAI({ id: 'r', model: 'gpt-6-luna', status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20 },
    output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'x' }, { type: 'web_search_call', id: 'ws_1' },
      { type: 'message', content: [{ type: 'output_text', text: 'Hal is a Green Lantern (dc.com).', annotations: [{ type: 'url_citation', url: 'https://dc.com', title: 'DC', start_index: 22, end_index: 31 }] }] },
      { type: 'function_call', call_id: 'call_9', name: 'respond', arguments: '{"answer":"Hal"}' }] }, 'gpt-6-luna');
  assert.equal(reply.stop_reason, 'tool_use');
  assert.equal(reply.content.find(b => b.type === 'text').text, 'Hal is a Green Lantern.');
  assert.deepEqual(reply.content.find(b => b.type === 'tool_use'), { type: 'tool_use', id: 'call_9', name: 'respond', input: { answer: 'Hal' } });
  assert.equal(reply.content.find(b => b.type === 'web_search_tool_result').content[0].url, 'https://dc.com');
  assert.deepEqual(reply.usage, { input_tokens: 60, output_tokens: 20, thinking_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } });
  // Replaying that assistant turn sends OpenAI's own items back, reasoning included.
  const again = toOpenAI({ model: 'openai:gpt-6-luna', max_tokens: 10, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: reply.content }] });
  assert.deepEqual(again.input.slice(1).map(i => i.type), ['reasoning', 'web_search_call', 'message', 'function_call']);
  // Claude never receives the hidden or synthetic blocks.
  const safe = anthropicSafe({ model: 'claude-sonnet-5-5', messages: [{ role: 'assistant', content: reply.content }] });
  assert.deepEqual(safe.messages[0].content.map(b => b.type), ['text', 'tool_use']);
});

test('cost estimates and matching models across providers', () => {
  assert.equal(catalog.equivalentModel('claude-haiku-5-5', 'openai'), 'openai:gpt-6-luna');
  assert.equal(catalog.equivalentModel('claude-sonnet-5-5', 'openai'), 'openai:gpt-6.1-sol');
  assert.equal(catalog.equivalentModel('openai:gpt-6-astra', 'anthropic'), 'claude-opus-5-5');
  assert.equal(Math.round(catalog.estimateCost('openai:gpt-6.1-sol', { input_tokens: 1e6, output_tokens: 1e6 }) * 100) / 100, 12);
});

test('trial split sends the chosen share of jobs to the trial model', () => {
  const { settingsRows } = require('./aiModels');
  const r = createModelRouting(store({ ai_trial_enricher: JSON.stringify({ model: 'openai:gpt-6-luna', share: 0.25 }) }));
  assert.equal(r.pick('enricher', () => 0.1), 'openai:gpt-6-luna');
  assert.equal(r.pick('enricher', () => 0.9), 'claude-haiku-5-5');
  assert.equal(r.pick('timeline', () => 0.1), 'claude-sonnet-5-5');
  assert.deepEqual(r.trialFor('enricher'), { model: 'openai:gpt-6-luna', share: 0.25 });
  assert.deepEqual(settingsRows({ trials: { enricher: { model: 'openai:gpt-6-luna', share: 0.5 }, topshelf: null } }),
    [['ai_trial_enricher', '{"model":"openai:gpt-6-luna","share":0.5}'], ['ai_trial_topshelf', '']]);
  assert.throws(() => settingsRows({ trials: { enricher: { model: 'x', share: 0.9 } } }));
});

test('calls carry a job id so several calls count as one job', async () => {
  const seen = [];
  const axios = { post: async () => ({ data: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } } }) };
  const ai = createAiClient({ axios, getAnthropicKey: () => 'k', modelFor: () => 'claude-haiku-5-5', onCall: e => seen.push(e) });
  const r = await ai.complete({ task: 'enricher', prompt: 'a' });
  await ai.request({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, { task: 'quick_answer', jobId: 'job-1' });
  await ai.request({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [] }, { task: 'quick_answer', jobId: 'job-1' });
  assert.equal(seen[0].job_id, r.jobId);
  assert.deepEqual(seen.slice(1).map(e => e.job_id), ['job-1', 'job-1']);
  assert.equal(catalog.displayName('openai:gpt-6.1-sol'), 'OpenAI · GPT-6.1 Sol');
});

test('Top Shelf – Category Check has its own task: Haiku recommended, can be pinned, needs web search', () => {
  const { createModelRouting, TASKS } = require('./aiModels');
  const t = TASKS.find(x => x.id === 'topshelf_categories');
  assert.equal(t.tier, 'quick'); assert.deepEqual(t.needs, ['web_search']);
  const store = o => k => o[k];
  assert.equal(createModelRouting(store({ ai_task_topshelf: 'opus' })).modelFor('topshelf_categories'), 'claude-haiku-5-5');   // not tied to the run generator
  assert.equal(createModelRouting(store({ ai_task_topshelf_categories: 's' })).modelFor('topshelf_categories'), 's');
});

test('recap tasks have their own defaults until pinned', () => {
  const { createModelRouting, TASKS } = require('./aiModels');
  const r = createModelRouting(store({ ai_model_quick: 'q', ai_model_generation: 'g' }));
  assert.equal(r.modelFor('recap_web'), 'claude-haiku-5-5');
  assert.equal(r.modelFor('recap_reader'), 'gemini:gemini-3.8-flash');
  assert.equal(createModelRouting(store({ ai_model_generation: 'g', ai_task_recap_reader: 'claude-sonnet-5-5' })).modelFor('recap_reader'), 'claude-sonnet-5-5');
  assert.deepEqual(TASKS.find(t => t.id === 'recap_reader').needs, ['images']);
  assert.equal(r.modelFor('long_answer'), 'openai:gpt-6.1-sol');   // recommended, not the old Generation setting
});

test('lookup defaults follow the saved provider keys (first deploy works with any key)', () => {
  const { createModelRouting, routingProblems } = require('./aiModels');
  const store = o => k => o[k];
  const route = keys => createModelRouting(store({}), { hasProvider: p => keys.includes(p) });
  assert.equal(route(['anthropic']).modelFor('web_lookup'), 'claude-haiku-5-5');
  assert.equal(route(['anthropic', 'gemini']).modelFor('web_lookup'), 'gemini:gemini-3.8-flash');
  assert.equal(route(['anthropic', 'gemini']).modelFor('recap_reader'), 'gemini:gemini-3.8-flash');
  assert.equal(route(['anthropic', 'openai']).modelFor('recap_reader'), 'openai:gpt-6.1-sol');
  assert.equal(route(['openai']).modelFor('web_lookup'), 'openai:gpt-6-luna');
  assert.equal(route(['openai']).modelFor('recap_web'), 'openai:gpt-6-luna');
  assert.equal(route(['anthropic']).modelFor('recap_reader'), 'claude-sonnet-5-5');
  assert.equal(route(['anthropic', 'gemini']).snapshot().tasks.find(t => t.id === 'web_lookup').default_reason, null);   // first choice: nothing to explain
  assert.equal(route(['anthropic']).snapshot().tasks.find(t => t.id === 'web_lookup').default_reason, 'no Gemini key saved');
  assert.equal(createModelRouting(store({ ai_task_web_lookup: 'claude-haiku-5-5' }), { hasProvider: () => true }).modelFor('web_lookup'), 'claude-haiku-5-5', 'a chosen model wins');
  assert.deepEqual(routingProblems(store({}), { hasProvider: p => p === 'anthropic' }), []);
});
