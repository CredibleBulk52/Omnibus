'use strict';
// ─── Gemini adapter (2026-10-20) ──────────────────────────────────
// Google's Gemini API, for web lookups only (FOLLOW_UPS.md, "Gemini Web Lookup"): Google's search
// finds the reviews and explainers other searches miss, and grounded searches are free up to
// 5,000 a month on the paid tier. Omnibus builds requests in Claude's Messages format; this file
// translates one request to generateContent and the reply back:
//   web_search  → google_search (Gemini chooses its own queries; each query is billed)
//   web_fetch   → url_context (reads pages it names)
//   output_config.format json_schema → responseMimeType + responseJsonSchema
// Comic Book Guy's app tools are not supported here (aiModels: Gemini is offered only for
// lookup tasks). The reply keeps Claude's shape: server_tool_use blocks for the queries and pages,
// a web_search_tool_result block for the sources, then the text.

const GEMINI_URL = model => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const SEARCH_TOOLS = new Set(['web_search_20250305', 'web_search_20260209', 'web_search']);
const FETCH_TOOLS = new Set(['web_fetch_20250910', 'web_fetch_20260209', 'web_fetch']);
const REDIRECT = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//;

const blocksOf = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []));
const unsupported = what => Object.assign(new Error(`Gemini is set up for web lookups only (${what} not supported)`), { code: 'AI_FEATURE_UNSUPPORTED' });

function partsOf(content) {
  return blocksOf(content).map(b => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'image' && b.source?.type === 'base64') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    if (b.type === 'tool_use' || b.type === 'tool_result') throw unsupported('app tools');
    return null;
  }).filter(Boolean);
}

// opts.drop: optional features to leave out after a refusal ('thinking', 'schema').
function toGemini(body, { drop = [] } = {}) {
  const out = { contents: (body.messages || []).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: partsOf(m.content) })) };
  const system = typeof body.system === 'string' ? body.system : (body.system || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
  if (system) out.systemInstruction = { parts: [{ text: system }] };
  const tools = [], blocked = new Set();
  for (const t of body.tools || []) {
    for (const d of t.blocked_domains || []) blocked.add(d);
    if (SEARCH_TOOLS.has(t.type) || (t.name === 'web_search' && !t.input_schema)) { if (!tools.some(x => x.googleSearch)) tools.push({ googleSearch: {} }); }
    else if (FETCH_TOOLS.has(t.type) || (t.name === 'web_fetch' && !t.input_schema)) { if (!tools.some(x => x.urlContext)) tools.push({ urlContext: {} }); }
    else throw unsupported(`tool "${t.name}"`);
  }
  if (tools.length) out.tools = tools;
  // Google Search has no domain filter: name the blocked sites in the instructions instead.
  if (blocked.size) {
    const note = `Do not use or cite these sites; they carry only solicitations or one-line notes: ${[...blocked].join(', ')}.`;
    out.systemInstruction = { parts: [{ text: system ? `${system}\n\n${note}` : note }] };
  }
  // Thinking counts against maxOutputTokens on Gemini, so leave room for it.
  const max = body.max_tokens || 2048;
  const gen = { maxOutputTokens: max + 8192 };
  // Lookups need little reasoning; page reading asks for more (body._gemini_thinking, set by aiClient).
  if (!drop.includes('thinking')) gen.thinkingConfig = { thinkingLevel: body._gemini_thinking || 'low' };
  const schema = body.output_config?.format?.type === 'json_schema' ? body.output_config.format.schema : null;
  if (schema && !drop.includes('schema')) { gen.responseMimeType = 'application/json'; gen.responseJsonSchema = schema; }
  else if (schema) {
    // Refused together with search: ask for the JSON in words instead.
    const last = out.contents[out.contents.length - 1];
    last.parts.push({ text: `\n\nReply with only a JSON object (no code fence) matching this JSON schema:\n${JSON.stringify(schema)}` });
  }
  out.generationConfig = gen;
  return out;
}

// Gemini reply → Claude Messages shape.
function fromGemini(r, model) {
  const cand = (r && r.candidates && r.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  let text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  text = text.replace(/^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/, '$1');   // a fenced JSON reply (schema asked in words)
  const gm = cand.groundingMetadata || {};
  const queries = (gm.webSearchQueries || []).filter(q => String(q || '').trim());
  const sources = (gm.groundingChunks || []).map(c => c.web).filter(w => w && w.uri).map(w => ({ type: 'web_search_result', url: w.uri, title: w.title || '' }));
  const pages = ((cand.urlContextMetadata && cand.urlContextMetadata.urlMetadata) || []).map(u => u.retrievedUrl).filter(Boolean);
  // The parts of the answer that Google's sources back up (grounding supports), in order.
  const supported = [...new Set((gm.groundingSupports || []).filter(g => g && g.segment && g.segment.text && (g.groundingChunkIndices || []).length)
    .map(g => String(g.segment.text).trim()).filter(Boolean))];
  const content = [
    ...queries.map((q, i) => ({ type: 'server_tool_use', id: `gsearch_${i}`, name: 'web_search', input: { query: q } })),
    ...(sources.length ? [{ type: 'web_search_tool_result', tool_use_id: 'gsearch_0', content: sources }] : []),
    ...pages.map((u, i) => ({ type: 'server_tool_use', id: `gfetch_${i}`, name: 'web_fetch', input: { url: u } })),
    { type: 'text', text },
  ];
  const u = r.usageMetadata || {};
  const cached = u.cachedContentTokenCount || 0;
  return {
    id: r.responseId || null, type: 'message', role: 'assistant', model, model_version: r.modelVersion || null,   // the requested id, so prices match
    content,
    stop_reason: cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    finish_reason: cand.finishReason || null,
    grounding: { supported },
    usage: {
      input_tokens: Math.max(0, (u.promptTokenCount || 0) - cached) + (u.toolUsePromptTokenCount || 0),
      output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      thinking_tokens: u.thoughtsTokenCount || 0,   // exact
      cache_read_input_tokens: cached,
      server_tool_use: { web_search_requests: queries.length },
    },
  };
}

// Grounding sources are Google redirect links; resolve them to the real pages (for source checks
// and the log), and swap them in the reply text too. Best effort: a link that won't resolve stays.
async function resolveSources(data, axios, { timeout = 6000, max = 10 } = {}) {
  const links = [...new Set((data.content || []).flatMap(b => (b.type === 'web_search_tool_result' ? b.content.map(s => s.url) : [])).filter(u => REDIRECT.test(u)))].slice(0, max);
  if (!links.length) return data;
  const real = new Map();
  await Promise.all(links.map(async link => {
    try {
      const r = await axios.get(link, { maxRedirects: 0, validateStatus: s => s >= 200 && s < 400, timeout, responseType: 'stream' });
      if (r.data && typeof r.data.destroy === 'function') r.data.destroy();
      const loc = r.headers && (r.headers.location || r.headers.Location);
      if (loc) real.set(link, loc);
    } catch { /* keep the redirect link */ }
  }));
  for (const b of data.content || []) {
    if (b.type === 'web_search_tool_result') for (const s of b.content) if (real.has(s.url)) s.url = real.get(s.url);
    if (b.type === 'text') for (const [from, to] of real) b.text = b.text.split(from).join(to);
  }
  return data;
}

// Optional features a 400 may be about, in the order they are dropped on a retry.
function dropFor(error, dropped) {
  const msg = String(error?.response?.data?.error?.message || error?.message || '').toLowerCase();
  if (error?.response?.status !== 400) return null;
  if (!dropped.includes('thinking') && /thinking/.test(msg)) return 'thinking';
  if (!dropped.includes('schema') && /(schema|mime|json|tool)/.test(msg)) return 'schema';
  if (!dropped.includes('thinking')) return 'thinking';
  if (!dropped.includes('schema')) return 'schema';
  return null;
}

module.exports = { GEMINI_URL, toGemini, fromGemini, resolveSources, dropFor, REDIRECT };
