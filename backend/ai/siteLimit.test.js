'use strict';
// Event generator site limit (2026-10-20, claude/EVENT_GENERATOR_V3.md): search and page reading
// only on the reading-order sites — the API's allowed_domains for Claude; OpenAI's search filter and
// Omnibus's read_page for GPT.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiClient } = require('./aiClient');
const { readPage, hostAllowed } = require('./pageReader');

const SITES = ['findmecomics.com', 'readingorders.com'];
const GEN = { task: 'timeline', maxTokens: 32000, webSearch: 4, webFetch: 5, webFetchTokens: 30000, allowedDomains: SITES, tools2026: true, prompt: 'P', timeout: 1000, jobId: 'j' };

function client(model, replies, extra = {}) {
  const sent = [];
  const axios = { post: async (url, body) => { sent.push({ url, body }); const r = replies.shift(); return { data: typeof r === 'function' ? r(body) : r }; }, ...extra };
  return { ai: createAiClient({ axios, getAnthropicKey: () => 'a', getOpenAIKey: () => 'o', modelFor: () => model }), sent };
}

test('Claude: allowed_domains on search and fetch, page cap passed through', async () => {
  const { ai, sent } = client('claude-opus-5-5', [{ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {} }]);
  await ai.complete(GEN);
  assert.deepEqual(sent[0].body.tools, [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 4, allowed_domains: SITES },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5, max_content_tokens: 30000, allowed_domains: SITES },
  ]);
});

test('Claude: allowedDomains replaces blockedDomains (the API takes one or the other)', async () => {
  const { ai, sent } = client('claude-opus-5-5', [{ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {} }]);
  await ai.complete({ ...GEN, webFetch: 0, blockedDomains: ['x.com'] });
  assert.deepEqual(sent[0].body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, allowed_domains: SITES }]);
});

test('GPT: search filter and read_page refuse other sites', async () => {
  const call = url => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'read_page', arguments: JSON.stringify({ url }) }], usage: {} });
  const final = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }], usage: {} };
  const gets = [];
  const { ai, sent } = client('openai:gpt-6.1-sol', [call('https://evil.example/x'), final], { get: async url => { gets.push(url); return { status: 200, headers: {}, data: 'x' }; } });
  await ai.complete(GEN);
  assert.deepEqual(sent[0].body.tools.find(t => t.type === 'web_search').filters, { allowed_domains: SITES });
  assert.deepEqual(gets, []);
  const out = sent[1].body.input.find(i => i.type === 'function_call_output');
  assert.match(out.output, /not one of the sites/);
});

test('read_page: subdomains of an allowed site are read; a redirect off the list is refused', async () => {
  assert.equal(hostAllowed('www.findmecomics.com', SITES), true);
  assert.equal(hostAllowed('notfindmecomics.com', SITES), false);
  assert.equal(hostAllowed('anything.example', null), true);
  const lookup = async () => [{ address: '93.184.216.34' }];
  const axios = { get: async () => ({ status: 302, headers: { location: 'https://elsewhere.example/' }, data: '' }) };
  await assert.rejects(readPage('https://www.readingorders.com/a', { axios, lookup, allowedDomains: SITES }), /not one of the sites/);
});
