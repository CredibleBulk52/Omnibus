'use strict';
// OpenAI parity for the generators (2026-10-18): GPT gets read_page, strict JSON and room to answer;
// Claude's request must stay exactly as it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiClient } = require('./aiClient');
const { strictSchema, toOpenAI } = require('./openaiAdapter');
const { readPage, htmlToText, checkUrl, privateAddress } = require('./pageReader');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['issues'], properties: { issues: { type: 'array', items: { type: 'string' } } } };
const GEN = { task: 'timeline', maxTokens: 32000, webSearch: 10, webFetch: 6, tools2026: true, outputSchema: SCHEMA, prompt: 'P', timeout: 1000, jobId: 'j' };

function client(model, replies, extra = {}) {
  const sent = [];
  const axios = { post: async (url, body) => { sent.push({ url, body }); const r = replies.shift(); return { data: typeof r === 'function' ? r(body) : r }; }, ...extra };
  return { ai: createAiClient({ axios, getAnthropicKey: () => 'a', getOpenAIKey: () => 'o', modelFor: () => model }), sent };
}

test('Claude: the generator request is exactly as before (tools, schema, limit, prompt)', async () => {
  const { ai, sent } = client('claude-opus-5-5', [{ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {} }]);
  await ai.complete(GEN);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    model: 'claude-opus-5-5', max_tokens: 32000, messages: [{ role: 'user', content: 'P' }],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6, max_content_tokens: 60000 }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });
});

test('GPT: read_page tool, strict JSON, more room; pages are read and sent back', async () => {
  const fnCall = { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'read_page', arguments: JSON.stringify({ url: 'https://93.184.216.34/order' }) }], usage: {} };
  const final = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"issues":["1"]}' }] }], usage: {} };
  const gets = [];
  const { ai, sent } = client('openai:gpt-6.1-sol', [fnCall, final], { get: async (url) => { gets.push(url); return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html><title>Order</title><body><ol><li>Part 1</li><li>Part 2</li></ol><script>x()</script></body></html>' }; } });
  const r = await ai.complete(GEN);
  assert.equal(r.text, '{"issues":["1"]}');
  const first = sent[0].body;
  assert.equal(first.max_output_tokens, 64000);
  assert.deepEqual(first.tools.map(t => t.type + (t.name ? `:${t.name}` : '')), ['web_search', 'function:read_page']);
  assert.equal(first.text.format.type, 'json_schema'); assert.equal(first.text.format.strict, true);
  assert.deepEqual(gets, ['https://93.184.216.34/order']);
  const out = sent[1].body.input.find(i => i.type === 'function_call_output');
  assert.match(out.output, /Order[\s\S]*• Part 1[\s\S]*• Part 2/); assert.doesNotMatch(out.output, /x\(\)/);
});

test('GPT: no more pages than allowed; a reply cut off by the limit is asked again once with more room', async () => {
  const call = n => ({ status: 'completed', output: [{ type: 'function_call', call_id: `c${n}`, name: 'read_page', arguments: '{"url":"https://93.184.216.34/"}' }], usage: {} });
  const cut = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: {} };
  const final = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: {} };
  let gets = 0;
  const { ai, sent } = client('openai:gpt-6.1-sol', [call(1), call(2), cut, final], { get: async () => { gets++; return { status: 200, headers: { 'content-type': 'text/plain' }, data: 'page' }; } });
  const r = await ai.complete({ ...GEN, webFetch: 1 });
  assert.equal(r.text, 'ok');
  assert.equal(gets, 1);                                                           // the second read was refused
  assert.match(sent[2].body.input.filter(i => i.type === 'function_call_output').at(-1).output, /No more pages/);
  assert.equal(sent[3].body.max_output_tokens, 100000);                           // retried with more room
});

test('read_page refuses local and private addresses, also after a redirect', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.248', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.1.2', '192.0.0.8', '192.0.2.10', '198.51.100.1', '203.0.113.9', '0.0.0.0']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '192.0.78.254', '192.0.79.33', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
  const lookup = async h => (h === 'lan.example' ? [{ address: '192.168.1.10' }] : [{ address: '93.184.216.34' }]);
  await assert.rejects(checkUrl('http://localhost/x', lookup), /local/);
  await assert.rejects(checkUrl('https://lan.example/', lookup), /private/);
  await assert.rejects(checkUrl('file:///etc/passwd', lookup), /http/);
  await assert.rejects(checkUrl('https://a.example:8080/', lookup), /port/);
  const axios = { get: async () => ({ status: 302, headers: { location: 'http://192.168.1.248/admin' }, data: '' }) };
  await assert.rejects(readPage('https://good.example/', { axios, lookup }), /private/);
});

test('strict schema: optional properties become required and nullable; text cleanup', () => {
  const s = strictSchema({ type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'string', enum: ['x'] } } });
  assert.deepEqual(s.required, ['a', 'b', 'c']); assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.a.type, 'string'); assert.deepEqual(s.properties.b.type, ['integer', 'null']); assert.deepEqual(s.properties.c.enum, ['x', null]);
  assert.equal(toOpenAI({ model: 'openai:x', max_tokens: 10, messages: [{ role: 'user', content: 'p' }] }).text, undefined);   // no schema → no format
  assert.equal(htmlToText('<p>A&amp;B</p><p>C&#8217;s</p>'), 'A&B\nC’s');
});
