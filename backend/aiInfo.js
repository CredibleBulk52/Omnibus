'use strict';
// ─── AI cost and models where AI is used (admins, diagnostics; 2026-11-09) ────
// Every AI call is already saved in ai_calls (model, tokens, web searches, time, cost at
// the app's prices). This module ties the calls to what caused them, for the ⓘ details
// and the top-bar AI activity feed:
//  • track: Express step on routes that start AI work. It gives the request an id, sends
//    it back as the X-AI-Request header and keeps it for everything the request starts,
//    including background work (async context), so each call can be saved with it.
//  • GET /api/admin/ai/details?request=|run=|job=|call= : one piece of work, per call.
//  • GET /api/admin/ai/recent : the latest runs (any cause), newest first.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('crypto');

const requestStore = new AsyncLocalStorage();
const currentRequest = () => requestStore.getStore()?.id || null;
function track(req, res, next) {
  if (requestStore.getStore()) return next();
  const id = randomUUID();
  // The id goes back as the X-AI-Request header (streamed replies too; only an id, the details
  // are admin-only) and, for admins, in a JSON object reply as ai_request.
  res.set('X-AI-Request', id);
  const json = res.json.bind(res);
  res.json = body => {
    if (req.user?.role === 'admin' && body && typeof body === 'object' && !Array.isArray(body)) body = { ...body, ai_request: id };
    return json(body);
  };
  requestStore.run({ id }, next);
}

function registerAiInfo({ app, db, requireAdmin, displayName, taskLabel, callCost }) {
  const missing = Object.entries({ app, db, requireAdmin, displayName, taskLabel, callCost }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`registerAiInfo: missing ${missing.join(', ')}`);
  const COLS = 'id, at, ms, task, provider, model, ok, error, input_tokens, output_tokens, cache_read, cache_write, web_searches, thinking_tokens, job_id, run_id, request_id, cost';
  const runInfo = db.prepare('SELECT label FROM ai_runs WHERE id = ?');

  // One piece of work: totals, models and each call (oldest first).
  function summarize(rows) {
    const t = { calls: rows.length, failed: 0, input_new: 0, input_cached: 0, input_written: 0, output: 0, thinking: 0, web_searches: 0, ms: 0, cost: 0 };
    const models = [];
    let start = Infinity, end = 0;
    const calls = rows.map(c => {
      const cost = callCost(c) || 0, model = displayName(c.model) || c.model;
      t.failed += c.ok ? 0 : 1; t.input_new += c.input_tokens || 0; t.input_cached += c.cache_read || 0; t.input_written += c.cache_write || 0;
      t.output += c.output_tokens || 0; t.thinking += c.thinking_tokens || 0; t.web_searches += c.web_searches || 0; t.ms += c.ms || 0; t.cost += cost;
      if (!models.includes(model)) models.push(model);
      start = Math.min(start, c.at - (c.ms || 0)); end = Math.max(end, c.at);
      return { at: c.at, purpose: taskLabel(c.task), model, ok: !!c.ok, error: c.error ? String(c.error).slice(0, 200) : null,
        input_new: c.input_tokens || 0, input_cached: c.cache_read || 0, input_written: c.cache_write || 0,
        output: c.output_tokens || 0, thinking: c.thinking_tokens ?? null, web_searches: c.web_searches || 0, ms: c.ms || 0, cost };
    });
    const labels = [...new Set(rows.map(r => r.run_id).filter(Boolean))].map(id => runInfo.get(id)?.label).filter(Boolean);
    return { label: labels[0] || (rows[0] ? taskLabel(rows[0].task) : null), models, totals: t, calls,
      started: rows.length ? start : null, elapsed_ms: rows.length ? Math.max(0, end - start) : 0 };
  }

  app.get('/api/admin/ai/details', requireAdmin, (req, res) => {
    try {
      const [col, val] = [['request', 'request_id'], ['run', 'run_id'], ['job', 'job_id'], ['call', 'id']]
        .map(([q, c]) => [c, req.query[q]]).find(([, v]) => v) || [];
      if (!col) return res.status(400).json({ error: 'request, run, job or call required' });
      const rows = db.prepare(`SELECT ${COLS} FROM ai_calls WHERE ${col} = ? ORDER BY at, id LIMIT 500`).all(String(val));
      res.json(summarize(rows));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Latest runs: calls grouped by run, else job, else on their own; at most the last day.
  app.get('/api/admin/ai/recent', requireAdmin, (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const rows = db.prepare(`SELECT ${COLS} FROM ai_calls WHERE at >= ? AND (task IS NULL OR task != 'connection_test') ORDER BY at DESC, id DESC LIMIT 2000`)
        .all(Date.now() - 24 * 3600 * 1000);
      const groups = new Map();
      for (const r of rows) {
        const key = r.run_id ? `run:${r.run_id}` : r.job_id ? `job:${r.job_id}` : `call:${r.id}`;
        if (!groups.has(key)) { if (groups.size >= limit) continue; groups.set(key, []); }
        groups.get(key).push(r);
      }
      res.json({ runs: [...groups.entries()].map(([key, list]) => {
        const s = summarize(list.reverse());
        const [kind, id] = key.split(/:(.*)/);
        return { key, kind, id, label: s.label, models: s.models, calls: s.totals.calls, failed: s.totals.failed, cost: s.totals.cost,
          started: s.started, elapsed_ms: s.elapsed_ms, last: Math.max(...list.map(c => c.at)) };
      }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return { summarize };
}

// Totals of one piece of work, for the summary lines screens already show (so they match the ⓘ):
// cents (0.1¢ steps), tokens (all input + output) and calls; null when nothing was recorded.
function totals(db, col, id) {
  if (!id || !['request_id', 'run_id', 'job_id'].includes(col)) return null;
  const r = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens + cache_read + cache_write + output_tokens), 0) AS tokens
    FROM ai_calls WHERE ${col} = ?`).get(String(id));
  return r && r.calls ? { cents: Math.round(r.cost * 1000) / 10, tokens: r.tokens, calls: r.calls } : null;
}
const requestTotals = db => totals(db, 'request_id', currentRequest());

module.exports = { track, currentRequest, registerAiInfo, totals, requestTotals };
