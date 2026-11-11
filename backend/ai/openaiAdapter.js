'use strict';
// ─── OpenAI adapter ───────────────────────────────────────────────
// Omnibus builds every AI request in Claude's Messages format. This file
// translates one request to OpenAI's Responses API and the reply back, so
// OpenAI models can run the same tasks: plain prompts, web search and the
// Comic Book Guy tool loop (function calls, tool results, page images).
//
// Round trip: the reply keeps OpenAI's own output items in a hidden block
// ({ type: 'openai_items' }) next to the translated text/tool_use blocks. When
// the caller sends that assistant turn back, those items are replayed exactly
// (reasoning included), which OpenAI needs for multi-step tool use. Claude
// never sees the hidden block: anthropicSafe() strips it.

const HIDDEN = 'openai_items';
const WEB_TOOLS = new Set(['web_search_20250305', 'web_search_20260209', 'web_search']);   // web_fetch has no OpenAI equivalent: its web search opens pages itself

const textBlocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : (content || []);
const imageUrl = src => (src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src?.url);

function userItems(content) {
  const items = [], parts = [], images = [];
  for (const b of textBlocks(content)) {
    if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
    else if (b.type === 'image') parts.push({ type: 'input_image', image_url: imageUrl(b.source) });
    else if (b.type === 'tool_result') {
      const blocks = textBlocks(b.content);
      const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('\n') || (typeof b.content === 'string' ? b.content : '');
      items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: text || '(no text)' });
      // Images returned by a tool (a comic page) follow as a user message.
      for (const img of blocks.filter(x => x.type === 'image')) images.push({ type: 'input_image', image_url: imageUrl(img.source) });
    }
  }
  if (images.length) items.push({ role: 'user', content: [{ type: 'input_text', text: 'Image returned by the tool above:' }, ...images] });
  if (parts.length) items.push({ role: 'user', content: parts });
  return items;
}

function assistantItems(content) {
  const blocks = textBlocks(content);
  const hidden = blocks.find(b => b.type === HIDDEN);
  if (hidden) return hidden.items;                      // OpenAI turn: replay as sent
  const items = [], text = [];
  for (const b of blocks) {                             // Claude turn: translate what OpenAI understands
    if (b.type === 'text' && b.text) text.push({ type: 'output_text', text: b.text });
    else if (b.type === 'tool_use') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) });
  }
  if (text.length) items.unshift({ role: 'assistant', content: text });
  return items;
}

function toolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { type: 'function', name: choice.name };
  return undefined;
}

// Claude's output_config json_schema → OpenAI's strict json_schema text format (user 2026-10-18).
// Strict mode wants every object closed (additionalProperties false) with every property required;
// a property the schema left optional becomes nullable instead. Our generator schemas already
// follow this; the conversion keeps any future schema valid.
function strictSchema(node, optional = false) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => strictSchema(n));
  const out = { ...node };
  if (out.type === 'object' || out.properties) {
    const props = out.properties || {};
    const req = new Set(out.required || []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strictSchema(v, !req.has(k))]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(out[k])) out[k] = out[k].map(n => strictSchema(n));
  if (optional) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  }
  return out;
}

// Claude Messages body → OpenAI Responses request.
function toOpenAI(body) {
  const system = typeof body.system === 'string' ? body.system : (body.system || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
  const input = [];
  for (const m of body.messages || []) input.push(...(m.role === 'assistant' ? assistantItems(m.content) : userItems(m.content)));
  const req = { model: String(body.model).replace(/^openai:/, ''), input, max_output_tokens: body.max_tokens, store: false };
  if (system) req.instructions = system;
  const schema = body.output_config?.format?.type === 'json_schema' ? body.output_config.format.schema : null;
  if (schema) req.text = { format: { type: 'json_schema', name: 'reply', schema: strictSchema(schema), strict: true } };
  const tools = [];
  for (const t of body.tools || []) {
    if (WEB_TOOLS.has(t.type)) {
      // search_context_size: how much page text each search returns (default "medium").
      tools.push({ type: 'web_search', ...(t.openai_search_context ? { search_context_size: t.openai_search_context } : {}),
        ...(t.allowed_domains?.length ? { filters: { allowed_domains: t.allowed_domains.map(d => String(d).replace(/^www\./, '')) } } : {}) });
      // Claude's per-call max_uses → OpenAI's response-wide cap on built-in tool calls
      // (web search is the only built-in tool we send).
      if (t.max_uses) req.max_tool_calls = t.max_uses;
    }
    else if (t.name && t.input_schema) tools.push({ type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema, strict: false });
  }
  if (tools.length) {
    req.tools = tools;
    const choice = toolChoice(body.tool_choice);
    if (choice) req.tool_choice = choice;
    // Replaying reasoning between tool calls needs its encrypted content when nothing is stored.
    req.include = ['reasoning.encrypted_content'];
  }
  return req;
}

// Remove inline citation text that OpenAI marks with url_citation annotations,
// collecting the sources (as Claude's web_search_tool_result does).
function cleanCitations(part, sources) {
  let text = part.text || '';
  const cites = (part.annotations || []).filter(a => a.type === 'url_citation' && a.url);
  for (const a of cites) if (!sources.has(a.url)) sources.set(a.url, a.title || a.url);
  const spans = cites.filter(a => Number.isInteger(a.start_index) && Number.isInteger(a.end_index) && a.end_index > a.start_index)
    .sort((a, b) => b.start_index - a.start_index);
  for (const a of spans) text = text.slice(0, a.start_index) + text.slice(a.end_index);
  return text.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ');
}

// OpenAI Responses reply → Claude Messages-shaped reply.
function fromOpenAI(d, requestedModel) {
  const output = Array.isArray(d.output) ? d.output : [];
  const content = [], sources = new Map();
  let searches = 0;
  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content || []) if (part.type === 'output_text') {
        const text = cleanCitations(part, sources);
        if (text.trim()) content.push({ type: 'text', text });
      }
    } else if (item.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(item.arguments || '{}'); } catch { input = { _raw: item.arguments }; }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    } else if (item.type === 'web_search_call') searches++;
  }
  if (sources.size) content.push({ type: 'web_search_tool_result', synthetic: true, content: [...sources].map(([url, title]) => ({ type: 'web_search_result', url, title })) });
  content.push({ type: HIDDEN, items: output.filter(o => ['reasoning', 'message', 'function_call', 'web_search_call'].includes(o.type)) });
  const incomplete = d.status === 'incomplete';
  const cached = d.usage?.input_tokens_details?.cached_tokens || 0;
  return {
    id: d.id, model: `openai:${d.model || requestedModel}`, provider: 'openai', role: 'assistant',
    stop_reason: incomplete ? (d.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : (d.incomplete_details?.reason || 'incomplete'))
      : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    content,
    usage: { input_tokens: Math.max(0, (d.usage?.input_tokens || 0) - cached), output_tokens: d.usage?.output_tokens || 0,
      thinking_tokens: d.usage?.output_tokens_details?.reasoning_tokens || 0,   // exact (reasoning tokens)
      cache_read_input_tokens: cached, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: searches } },
  };
}

// Claude must not receive OpenAI-only blocks (a conversation can change
// provider when a question is handed to a bigger model).
function anthropicSafe(body) {
  // OpenAI-only tool options must not reach Claude's API.
  if (Array.isArray(body.tools) && body.tools.some(t => t && 'openai_search_context' in t))
    body = { ...body, tools: body.tools.map(t => (t && 'openai_search_context' in t) ? (({ openai_search_context, ...rest }) => rest)(t) : t) };
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.filter(b => b.type !== HIDDEN && !b.synthetic);
    if (content.length !== m.content.length) changed = true;
    return content.length === m.content.length ? m : { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] };
  });
  return changed ? { ...body, messages } : body;
}

module.exports = { strictSchema, toOpenAI, fromOpenAI, anthropicSafe, HIDDEN };
