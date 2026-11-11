'use strict';
// ⓘ AI details and the AI activity feed (2026-11-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const aiInfo = require('./aiInfo');
const { cleanAppearance } = require('./appearancePrefs');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, ms INTEGER, task TEXT, provider TEXT, model TEXT, ok INTEGER DEFAULT 1, error TEXT,
            input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, web_searches INTEGER DEFAULT 0,
            thinking_tokens INTEGER, job_id TEXT, run_id TEXT, request_id TEXT, cost REAL);
          CREATE TABLE ai_runs (id TEXT PRIMARY KEY, at INTEGER, label TEXT, user_id TEXT);`);
  return d;
}
const add = (d, r) => d.prepare(`INSERT INTO ai_calls (at, ms, task, model, ok, error, input_tokens, output_tokens, cache_read, cache_write, web_searches, thinking_tokens, job_id, run_id, request_id, cost)
  VALUES (@at, @ms, @task, @model, @ok, @error, @input_tokens, @output_tokens, @cache_read, @cache_write, @web_searches, @thinking_tokens, @job_id, @run_id, @request_id, @cost)`)
  .run({ at: Date.now(), ms: 1000, task: 'quick_answer', model: 'openai:gpt-6-luna', ok: 1, error: null, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
    web_searches: 0, thinking_tokens: null, job_id: null, run_id: null, request_id: null, cost: 0, ...r });

function routes(d) {
  const r = {};
  aiInfo.registerAiInfo({ app: { get: (p, ...h) => { r[p] = h[h.length - 1]; } }, db: d, requireAdmin: () => {},
    displayName: m => ({ 'openai:gpt-6-luna': 'Luna', 'gemini:gemini-3.8-flash': 'Gemini Flash' }[m] || m),
    taskLabel: t => ({ quick_answer: 'Quick Answers', web_lookup: 'Web Search' }[t] || t), callCost: c => c.cost });
  return (p, query) => new Promise(resolve => r[p]({ query }, { status() { return this; }, json: resolve }));
}

test('track: AI calls made while handling the request carry its id; admins get it in the reply', async () => {
  const run = (role, body) => new Promise(resolve => {
    const headers = {};
    const res = { headersSent: false, set: (k, v) => { headers[k] = v; }, json: b => resolve({ body: b, headers, inside }) };
    let inside = null;
    const req = { user: { role } };
    aiInfo.track(req, res, () => { setImmediate(() => { inside = aiInfo.currentRequest(); res.json(body); }); });
  });
  const admin = await run('admin', { answer: 'hi' });
  assert.ok(admin.inside);
  assert.equal(admin.body.ai_request, admin.inside);
  assert.equal(admin.headers['X-AI-Request'], admin.inside);
  const user = await run('user', { answer: 'hi' });
  assert.equal(user.body.ai_request, undefined);   // the header (an id only) is sent to everyone
  assert.equal(aiInfo.currentRequest(), null);   // nothing outside a tracked request
});

test('details: one request, every model, per-call rows and totals', async () => {
  const d = db(), get = routes(d);
  d.prepare("INSERT INTO ai_runs VALUES ('r1', 0, 'Comic Book Guy: when do I read Annual 2?', 'u')").run();
  add(d, { request_id: 'q1', run_id: 'r1', input_tokens: 900, cache_read: 21000, output_tokens: 120, cost: 0.0010 });
  add(d, { request_id: 'q1', run_id: 'r1', task: 'web_lookup', model: 'gemini:gemini-3.8-flash', input_tokens: 400, output_tokens: 300, web_searches: 1, cost: 0.0018 });
  add(d, { request_id: 'other', cost: 5 });
  const r = await get('/api/admin/ai/details', { request: 'q1' });
  assert.equal(r.label, 'Comic Book Guy: when do I read Annual 2?');
  assert.deepEqual(r.models, ['Luna', 'Gemini Flash']);
  assert.equal(r.totals.calls, 2);
  assert.equal(r.totals.input_cached, 21000);
  assert.equal(r.totals.web_searches, 1);
  assert.ok(Math.abs(r.totals.cost - 0.0028) < 1e-9);
  assert.deepEqual(r.calls.map(c => c.purpose), ['Quick Answers', 'Web Search']);
  assert.deepEqual(aiInfo.totals(d, 'request_id', 'q1'), { cents: 0.3, tokens: 22720, calls: 2 });
  assert.equal(aiInfo.totals(d, 'request_id', 'nope'), null);
  assert.equal((await get('/api/admin/ai/details', {})).error, 'request, run, job or call required');
});

test('recent: runs, jobs and lone calls, newest first', async () => {
  const d = db(), get = routes(d);
  const t = Date.now();
  add(d, { at: t - 5000, run_id: 'r-old', cost: 0.01 });
  add(d, { at: t - 4000, run_id: 'r-old', cost: 0.02 });
  add(d, { at: t - 3000, job_id: 'j1', task: 'annual_validator', cost: 0.001 });
  add(d, { at: t - 1000, cost: 0.002 });
  add(d, { at: t - 500, task: 'connection_test', cost: 0 });
  const r = await get('/api/admin/ai/recent', {});
  assert.deepEqual(r.runs.map(x => x.kind), ['call', 'job', 'run']);
  assert.equal(r.runs[2].calls, 2);
  assert.ok(Math.abs(r.runs[2].cost - 0.03) < 1e-9);
});

test('appearance keeps the admin switch for AI details', () => {
  assert.equal(cleanAppearance({ aiInfo: false }).aiInfo, false);
  assert.equal(cleanAppearance({}).aiInfo, undefined);
  assert.equal(cleanAppearance({ aiInfo: 'no' }), null);
});
