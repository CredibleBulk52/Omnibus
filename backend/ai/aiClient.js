'use strict';
// ─── Shared AI client ─────────────────────────────────────────────
// Every AI request in Omnibus goes through here so they are built the same
// way: one API version, current tool definitions (no beta headers), text read
// from all text blocks (newer models may send thinking/tool blocks first), and
// a stop reason that callers can check. The provider comes from the model id:
// "openai:<id>" goes to OpenAI's Responses API through openaiAdapter.js (plain
// prompts, web search and tool loops); "gemini:<id>" goes to Google's Gemini API
// through geminiAdapter.js (web lookups only); anything else goes to Anthropic. Every
// reply comes back in the Claude Messages shape, and every call is reported to
// onCall (task, provider, model, tokens, time, error) for the usage view.
const { toOpenAI, fromOpenAI, anthropicSafe } = require('./openaiAdapter');
const { readPage } = require('./pageReader');
const gemini = require('./geminiAdapter');
const { randomUUID } = require('node:crypto');
// Runs (2026-10-23, Settings › Usage & results): a run is one piece of work someone started, such as
// a Comic Book Guy question with its web lookup and recap summaries, or an event build. The code that
// starts one wraps it in aiRun(); every AI call made inside it, however deep, carries the run's id and label.
const { AsyncLocalStorage } = require('node:async_hooks');
const runStore = new AsyncLocalStorage();
function aiRun({ label = null, userId = null } = {}, fn) {
  if (runStore.getStore()) return fn();   // already inside a run: stay in it
  return runStore.run({ id: randomUUID(), label: label ? String(label).replace(/\s+/g, ' ').trim().slice(0, 200) : null, userId: userId || null }, fn);
}
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const WEB_SEARCH_TOOL = 'web_search_20250305';
// Newer server tools (2026-10-17, for the event generator): search and fetch with dynamic
// filtering (Claude filters pages with code before they enter the context; the API provides the
// code execution itself). Opt-in per call (opts.tools2026); callers fall back to the basic tool
// if a request is refused.
const WEB_SEARCH_TOOL_2026 = 'web_search_20260209';
const WEB_FETCH_TOOL = 'web_fetch_20250910', WEB_FETCH_TOOL_2026 = 'web_fetch_20260209';

const providerOf = model => {
  const m = String(model || '');
  const prefixed = /^([a-z][a-z0-9_-]*):/.exec(m);
  return prefixed ? prefixed[1] : 'anthropic';
};
const textOf = data => (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
const webSearchTool = maxUses => ({ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: maxUses });
const errorText = e => e?.response?.data?.error?.message || e?.message || String(e);

// A job is one piece of work (a description, an event, one Comic Book Guy
// answer) that may take several calls; usage is compared per job.
const newJobId = () => randomUUID();

// OpenAI parity for the generators (user 2026-10-18). Claude's requests are untouched; these apply only
// when the model is an OpenAI one:
// - read_page: Claude's web_fetch server tool has no OpenAI equivalent, so GPT gets a function tool and
//   Omnibus reads the page (pageReader.js), up to the same number of pages (opts.webFetch).
// - room to answer: a reasoning model's hidden reasoning counts against max_output_tokens, so long
//   replies (8k+) get more room, and a reply cut off by the limit is asked again once with double.
const READ_PAGE_TOOL = { name: 'read_page', description: 'Read a web page in full, as plain text (reading orders, award lists, publisher pages, wiki articles). Give the full URL.',
  input_schema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', description: 'The page address, starting with https://' } } } };
const OPENAI_MAX_OUTPUT = 100000;
const openaiRoom = n => (n >= 8000 ? Math.min(Math.max(n * 2, n + 16000), OPENAI_MAX_OUTPUT) : n);

// Output tokens spent thinking, per call (2026-10-22, for Settings › AI Models). Gemini and OpenAI
// report it exactly (usage.thinking_tokens, set by their adapters). Claude reports total output only and
// returns its thinking summarized, so it is estimated: output minus the visible reply (text and tool
// input, ~3.6 characters a token). 0 when a Claude reply has no thinking block; null when unknown.
function thinkingTokens(data) {
  const u = data?.usage;
  if (!u) return null;
  if (typeof u.thinking_tokens === 'number') return u.thinking_tokens;
  const blocks = Array.isArray(data.content) ? data.content : [];
  if (!blocks.some(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking'))) return 0;
  let chars = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text') chars += String(b.text || '').length;
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') chars += JSON.stringify(b.input || {}).length;
  }
  return Math.max(0, (u.output_tokens || 0) - Math.round(chars / 3.6));
}

function createAiClient({ axios, getAnthropicKey, getOpenAIKey = () => '', getGeminiKey = () => '', modelFor, pick = null, logger = null, onCall = null }) {
  const report = entry => { try { onCall?.(entry); } catch (e) { logger?.warn?.('ai', 'Usage log failed', { error: e.message }); } };

  // Raw Messages-style request (the assistant's tool loop uses this directly).
  // opts.task / opts.source label the call in the usage view.
  async function request(body, { timeout = 90000, signal, task = null, source = 'live', jobId = null } = {}) {
    const provider = providerOf(body.model);
    const started = Date.now();
    let data = null, error = null;
    try {
      if (provider === 'openai') {
        const key = getOpenAIKey();
        if (!key) throw Object.assign(new Error('No OpenAI API key set (Settings → AI Models)'), { code: 'AI_KEY_MISSING' });
        const r = await axios.post(OPENAI_URL, toOpenAI(body), { headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, timeout, signal });
        data = fromOpenAI(r.data || {}, String(body.model).replace(/^openai:/, ''));
      } else if (provider === 'gemini') {
        const key = getGeminiKey();
        if (!key) throw Object.assign(new Error('No Gemini API key set (Settings → AI Models)'), { code: 'AI_KEY_MISSING' });
        const id = String(body.model).replace(/^gemini:/, '');
        // A 400 about an optional feature (thinking level, a schema together with search) is asked
        // again without it, at most twice.
        const dropped = [...(body._gemini_drop || [])];
        for (;;) {
          try {
            const r = await axios.post(gemini.GEMINI_URL(id), gemini.toGemini(body, { drop: dropped }), { headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, timeout, signal });
            data = gemini.fromGemini(r.data || {}, String(body.model));
            break;
          } catch (e) {
            const next = gemini.dropFor(e, dropped);
            if (!next) throw e;
            dropped.push(next);
            logger?.warn?.('ai', 'Gemini refused an option; asking again without it', { model: id, dropped: next, error: errorText(e).slice(0, 200) });
          }
        }
        await gemini.resolveSources(data, axios);
      } else if (provider === 'anthropic') {
        const key = getAnthropicKey();
        if (!key) throw Object.assign(new Error('No Anthropic API key set (Settings → AI Models)'), { code: 'AI_KEY_MISSING' });
        const r = await axios.post(ANTHROPIC_URL, anthropicSafe(body), {
          headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
          timeout, signal,
        });
        data = r.data;
      } else throw Object.assign(new Error(`AI provider "${provider}" is not set up yet`), { code: 'AI_PROVIDER_UNAVAILABLE' });
      return data;
    } catch (e) { error = e; throw e; }
    finally {
      const u = data?.usage || {};
      const thinking = thinkingTokens(data);
      report({ task, source, job_id: jobId || newJobId(), run: runStore.getStore() || null, provider, model: String(body.model || ''), ok: !error, error: error ? errorText(error).slice(0, 300) : null,
        ms: Date.now() - started, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0,
        web_searches: u.server_tool_use?.web_search_requests || 0, thinking_tokens: thinking });   // fetches are free; only searches are counted
    }
  }

  // complete({ task | model, prompt | messages, system, maxTokens, webSearch, webFetch, tools2026, outputSchema, tools, toolChoice, timeout, source })
  //   webFetch: max page fetches (whole pages, not search snippets); tools2026: newer search/fetch tool versions;
  //   outputSchema: a JSON schema for the reply (Claude's structured outputs; OpenAI: strict json_schema text format).
  async function complete(opts = {}) {
    // pick() applies a task's trial split; one model per job.
    const model = opts.model || (pick ? pick(opts.task) : modelFor(opts.task));
    const jobId = opts.jobId || newJobId();
    const openai = providerOf(model) === 'openai';
    const body = {
      model,
      max_tokens: openai ? openaiRoom(opts.maxTokens || 2048) : (opts.maxTokens || 2048),
      messages: opts.messages || [{ role: 'user', content: opts.prompt }],
    };
    if (opts.system) body.system = opts.system;
    // allowedDomains: search and page reading limited to these sites (the API enforces it; for GPT,
    // OpenAI's search filter and Omnibus's read_page). Takes the place of blockedDomains (the API takes one or the other).
    const allowed = opts.allowedDomains?.length ? opts.allowedDomains : null;
    const siteLimit = allowed ? { allowed_domains: allowed } : opts.blockedDomains?.length ? { blocked_domains: opts.blockedDomains } : {};
    const tools = openai
      ? [...(opts.webSearch ? [{ ...webSearchTool(opts.webSearch), ...(allowed ? { allowed_domains: allowed } : {}) }] : []), ...(opts.webFetch ? [READ_PAGE_TOOL] : []), ...(opts.tools || [])]
      : [...(opts.webSearch ? [{ ...webSearchTool(opts.webSearch), ...(opts.tools2026 ? { type: WEB_SEARCH_TOOL_2026 } : {}), ...siteLimit }] : []),
        ...(opts.webFetch ? [{ type: opts.tools2026 ? WEB_FETCH_TOOL_2026 : WEB_FETCH_TOOL, name: 'web_fetch', max_uses: opts.webFetch, max_content_tokens: opts.webFetchTokens || 60000, ...(allowed ? { allowed_domains: allowed } : {}) }] : []),
        ...(opts.tools || [])];
    if (tools.length) body.tools = tools;
    if (opts.outputSchema) body.output_config = { format: { type: 'json_schema', schema: opts.outputSchema } };
    // thinking: 'off' — newer Claude models think by default and the thinking counts against max_tokens
    // (Haiku 5.5 spent whole tier-note replies thinking, 2026-10-22). Claude only.
    if (opts.thinking === 'off' && providerOf(model) === 'anthropic') body.thinking = { type: 'disabled' };
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    // Gemini: ask for the JSON in words instead of a response schema. With a schema it often skipped
    // Google Search and answered from memory (lookup comparison, 2026-10-20).
    if (opts.schemaInWords && providerOf(model) === 'gemini') body._gemini_drop = ['schema'];
    if (opts.geminiThinking && providerOf(model) === 'gemini') body._gemini_thinking = opts.geminiThinking;
    const reqOpts = { timeout: opts.timeout, signal: opts.signal, task: opts.task || null, source: opts.source || 'live', jobId };
    let data = await request(body, reqOpts);
    if (openai) {
      // read_page calls: Omnibus reads each page and sends it back, until the model answers.
      let reads = 0, messages = body.messages;
      const maxReads = opts.webFetch || 0;
      const maxChars = Math.min((opts.webFetchTokens || 20000) * 4, 80000);
      for (let round = 0; round < maxReads + 2 && data.stop_reason === 'tool_use'; round++) {
        const calls = (data.content || []).filter(b => b.type === 'tool_use' && b.name === 'read_page');
        if (!calls.length) break;
        const results = [];
        for (const c of calls) {
          let out;
          if (reads >= maxReads) out = 'No more pages can be read for this request. Answer now with what you have.';
          else {
            reads++;
            try { const p = await readPage(c.input && c.input.url, { axios, maxChars, allowedDomains: allowed }); out = `${p.url}\n\n${p.text}`; logger?.info?.('ai', 'read_page', { task: opts.task, url: p.url, chars: p.text.length }); }
            catch (e) { out = `Could not read ${c.input && c.input.url}: ${e.message}`; logger?.info?.('ai', 'read_page failed', { task: opts.task, url: c.input && c.input.url, error: e.message }); }
          }
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
        }
        messages = [...messages, { role: 'assistant', content: data.content }, { role: 'user', content: results }];
        const prev = data.usage || {};
        data = await request({ ...body, messages }, reqOpts);
        // The caller sees one reply: add up the tokens of every call it took (each call is still reported to Usage on its own).
        const u = data.usage || (data.usage = {});
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens']) u[k] = (u[k] || 0) + (prev[k] || 0);
      }
      if (data.stop_reason === 'max_tokens' && !opts._roomRetry && body.max_tokens < OPENAI_MAX_OUTPUT) {
        logger?.warn?.('ai', 'OpenAI reply hit the token limit; asking again with more room', { task: opts.task, model, max: body.max_tokens });
        return complete({ ...opts, model, jobId, maxTokens: Math.min(body.max_tokens * 2, OPENAI_MAX_OUTPUT), _roomRetry: true });
      }
    }
    const result = { data, jobId, model: data.model || model, text: textOf(data), stopReason: data.stop_reason, usage: data.usage || {} };
    if (result.stopReason === 'max_tokens') logger?.warn?.('ai', 'Reply hit the token limit', { task: opts.task, model: result.model });
    return result;
  }

  // Small connectivity check with the given (or Quick) model.
  async function ping(model) {
    const data = await request({ model: model || modelFor('quick'), max_tokens: 64, messages: [{ role: 'user', content: 'Reply with: ok' }] }, { timeout: 20000, task: 'connection_test' });
    return data.model || model;
  }

  // The model a task would use for one job (its trial split applied once), so a caller can pin it
  // across several calls and shape its prompt for the provider.
  const choose = task => (pick ? pick(task) : modelFor(task));

  return { request, complete, ping, textOf, webSearchTool, providerOf, newJobId, choose, run: aiRun };
}

module.exports = { thinkingTokens, aiRun, createAiClient, textOf, webSearchTool, providerOf, WEB_SEARCH_TOOL, WEB_SEARCH_TOOL_2026, WEB_FETCH_TOOL, WEB_FETCH_TOOL_2026, newJobId };
