'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('./geminiAdapter');
const { routingProblems } = require('./aiModels');
const catalog = require('../modelCatalog');
const { createAiClient } = require('./aiClient');

const body = { model: 'gemini:gemini-3.5-flash-lite', max_tokens: 4000, system: 'Be brief.', messages: [{ role: 'user', content: 'What happened in 100 Bullets #49?' }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, blocked_domains: ['dc.com'] }, { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2 }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { synopsis: { type: 'string' } } } } } };
const reply = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'plan', thought: true }, { text: '{"synopsis":"Bill died.","source_url":"https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"}' }] },
  groundingMetadata: { webSearchQueries: ['100 Bullets 49 plot', ''], groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'insidepulse.com' } }],
    groundingSupports: [{ segment: { text: 'Bill died.' }, groundingChunkIndices: [0] }, { segment: { text: 'Unbacked.' }, groundingChunkIndices: [] }] } }],
  usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 200, candidatesTokenCount: 300, thoughtsTokenCount: 100, toolUsePromptTokenCount: 5000 }, modelVersion: 'gemini-3.5-flash-lite-001' };

test('Gemini request: search, url context, schema, blocked sites in the instructions', () => {
  const r = g.toGemini(body);
  assert.deepEqual(r.tools, [{ googleSearch: {} }, { urlContext: {} }]);
  assert.equal(r.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.match(r.systemInstruction.parts[0].text, /Be brief\.[\s\S]*dc\.com/);
  const dropped = g.toGemini(body, { drop: ['thinking', 'schema'] });
  assert.equal(dropped.generationConfig.thinkingConfig, undefined);
  assert.equal(dropped.generationConfig.responseJsonSchema, undefined);
  assert.match(dropped.contents[0].parts.at(-1).text, /JSON schema/);
  assert.throws(() => g.toGemini({ ...body, tools: [{ name: 'story_notes', input_schema: { type: 'object' } }] }), /web lookups only/);
});

test('Gemini reply: Claude shape, queries, sources, usage; redirect links resolved', async () => {
  const d = g.fromGemini(reply, body.model);
  assert.equal(d.model, body.model);
  assert.deepEqual(d.grounding.supported, ['Bill died.']);
  assert.deepEqual(d.content.filter(b => b.type === 'server_tool_use').map(b => b.input.query), ['100 Bullets 49 plot']);
  assert.deepEqual(d.usage, { input_tokens: 6000, output_tokens: 400, thinking_tokens: 100, cache_read_input_tokens: 200, server_tool_use: { web_search_requests: 1 } });
  const axios = { get: async () => ({ headers: { location: 'https://insidepulse.com/2004/03/18/6561/' }, data: { destroy() {} } }) };
  await g.resolveSources(d, axios);
  assert.equal(d.content.find(b => b.type === 'web_search_tool_result').content[0].url, 'https://insidepulse.com/2004/03/18/6561/');
  assert.match(d.content.at(-1).text, /insidepulse\.com\/2004/);
});

test('aiClient: Gemini call with key header; a refused option is dropped and asked again', async () => {
  const sent = [];
  const axios = { post: async (url, b, o) => { sent.push({ url, b, o }); if (sent.length === 1) { const e = new Error('bad'); e.response = { status: 400, data: { error: { message: 'thinking level not supported' } } }; throw e; } return { data: reply }; },
    get: async () => ({ headers: {}, data: { destroy() {} } }) };
  const ai = createAiClient({ axios, getAnthropicKey: () => 'a', getGeminiKey: () => 'gk', modelFor: () => 'gemini:gemini-3.5-flash-lite' });
  const r = await ai.complete({ task: 'recap_web', prompt: 'x', webSearch: 2, outputSchema: { type: 'object' } });
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(sent[0].o.headers['x-goog-api-key'], 'gk');
  assert.equal(sent[1].b.generationConfig.thinkingConfig, undefined);
  assert.match(r.text, /Bill died/);
});

test('Gemini only on lookup tasks; prices and free searches', () => {
  const store = o => k => o[k];
  assert.deepEqual(routingProblems(store({ ai_task_recap_web: 'gemini:gemini-3.5-flash-lite' })), []);
  const p = routingProblems(store({ ai_task_annual_validator: 'gemini:gemini-3.5-flash-lite', ai_task_recap_web: 'gemini:gemini-3.5-flash-lite' }));
  assert.ok(p.some(x => x.id === 'annual_validator' && x.reason === 'lookup_only'));
  assert.ok(!p.some(x => x.id === 'recap_web'));
  assert.equal(catalog.searchFee('gemini:gemini-3.8-flash'), 0);
  assert.equal(catalog.displayName('gemini:gemini-3.8-flash'), 'Google · Gemini 3.8 Flash');
  assert.deepEqual(catalog.currentGeminiModels([{ name: 'models/gemini-3.1-flash-lite' }, { name: 'models/gemini-3.5-flash-lite' }, { name: 'models/gemini-3.8-flash-tts' }]).map(m => m.id), ['gemini:gemini-3.5-flash-lite']);
});

test('schemaInWords: Gemini gets the JSON asked for in words (no response schema); other providers keep the schema', async () => {
  const sent = [];
  const axios = { post: async (url, b) => { sent.push({ url, b }); return url.includes('generativelanguage') ? { data: reply } : { data: { content: [{ type: 'text', text: '{}' }], usage: {} } }; },
    get: async () => ({ headers: {}, data: { destroy() {} } }) };
  const ai = createAiClient({ axios, getAnthropicKey: () => 'a', getGeminiKey: () => 'gk', modelFor: () => 'gemini:gemini-3.5-flash-lite' });
  await ai.complete({ task: 'recap_web', prompt: 'x', webSearch: 2, outputSchema: { type: 'object' }, schemaInWords: true });
  assert.equal(sent[0].b.generationConfig.responseJsonSchema, undefined);
  assert.match(sent[0].b.contents[0].parts.at(-1).text, /JSON schema/);
  assert.equal(sent[0].b._gemini_drop, undefined);
  await ai.complete({ task: 'recap_web', model: 'claude-haiku-5-5', prompt: 'x', outputSchema: { type: 'object' }, schemaInWords: true });
  assert.ok(sent[1].b.output_config && !('_gemini_drop' in sent[1].b));
});
