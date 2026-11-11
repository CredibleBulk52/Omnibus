'use strict';
// ─── Web Search (task web_lookup, 2026-10-20) ─────────────────────
// One plain question to the Web Search model (Settings → AI Models → Lookups; Gemini by default when
// its key is saved, else Haiku, else Luna) → notes and the pages it found. Shared by Comic Book Guy's
// web_lookup tool (detail 'short') and step 1 of recap lookups (detail 'full', recaps/synopses.js).
// Plain questions matter: asked to "write a synopsis" with a reply format, Gemini mostly skipped
// searching and answered from memory (lookup comparison 2026-10-20); asked a plain question it searched.
// grounded = the model actually searched (queries or sources came back); callers trust nothing else.

const PROMPTS = {
  short: q => `Answer this comics question from web sources: ${q}\n\nSearch with focused queries. Prefer pages that answer it directly (wiki character and issue pages, reviews and explainers that walk through the story). Give the answer in under 200 words, oldest events first, naming every issue you mention with its year. Say plainly when sources disagree or when you could not confirm something. Do not list sources in the text.`,
  full: q => `What happens in ${q}? Search the web for pages that walk through this issue's plot: a wiki page or recap for this exact issue first, then detailed spoiler reviews (search with the series, volume year and issue number plus words like "plot summary", "recap" or "review"). Skip solicitations and previews; they only describe the set-up.\n\nThen tell me what the pages say happens, scene by scene, including how the issue ends and any backup story, in under 300 words. Say plainly what the pages do not cover. Do not list sources in the text.`,
  arc: q => `What happens in ${q}? Search the web for pages that summarize the plot of these issues: wiki pages, recaps of the issues or of their collected edition, detailed spoiler reviews (search with the series, volume year and issue numbers plus words like "plot summary" or "recap"). Skip solicitations and previews.\n\nThen tell me what the pages say happens, in order, including how the stretch ends, in under 300 words. Say plainly what the pages do not cover. Do not list sources in the text.`,
  // A second try when the first answered without searching (Gemini decides for itself; 5 of 14 recap
  // lookups skipped the search in the 2026-10-20 comparison).
  retry: q => `Use Google Search now: search for "${q} plot summary" and "${q} recap review". Do not answer from memory. Then tell me what the pages you found say happens there, in order and including the ending, in under 300 words.`,
};

const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

function createWebLookup({ ai, modelCatalog = null, logger = null, fallbackModel = 'claude-haiku-5-5' }) {
  // → { notes, sources: [{url, title}], queries, grounded, model, cost (USD) }
  async function lookup(question, { detail = 'short', blockedDomains = [], source = 'live', jobId, signal, model, maxSources = 10 } = {}) {
    const opts = { task: 'web_lookup', ...(model ? { model } : {}), prompt: (PROMPTS[detail] || PROMPTS.short)(question),
      maxTokens: detail === 'short' ? 1200 : 2000, webSearch: 2, ...(blockedDomains.length ? { blockedDomains } : {}),
      timeout: 90000, source, ...(jobId ? { jobId } : {}), ...(signal ? { signal } : {}) };
    let r;
    try { r = await ai.complete(opts); }
    catch (e) {
      // A Web Search model pinned to a provider whose key was removed: use the fallback.
      if (e.code !== 'AI_KEY_MISSING' || model === fallbackModel) throw e;
      logger?.warn?.('ai', 'Web Search model has no key; using the fallback', { fallback: fallbackModel, error: e.message });
      r = await ai.complete({ ...opts, model: fallbackModel });
    }
    const content = Array.isArray(r.data?.content) ? r.data.content : [];
    const queries = content.filter(b => b.type === 'server_tool_use' && b.input?.query).map(b => String(b.input.query));
    const blocked = blockedDomains.map(d => String(d).toLowerCase().replace(/^www\./, ''));
    const seen = new Set(), sources = [];
    for (const b of content) {
      if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
      for (const x of b.content) {
        if (!x || !x.url || seen.has(x.url)) continue;
        const h = hostOf(x.url);
        if (blocked.some(d => h === d || h.endsWith(`.${d}`))) continue;
        seen.add(x.url); sources.push({ url: x.url, title: x.title || '' });
      }
    }
    const u = r.usage || {}, searches = u.server_tool_use?.web_search_requests || 0;
    const cost = modelCatalog?.estimateCost ? modelCatalog.estimateCost(r.model, { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0, web_searches: searches }) : 0;
    // Gemini reports which sentences its sources back (grounding supports): keep only those as "backed".
    const backed = Array.isArray(r.data?.grounding?.supported) && r.data.grounding.supported.length ? r.data.grounding.supported.join(' ') : null;
    return { notes: String(r.text || '').trim(), backed, sources: sources.slice(0, maxSources), queries, grounded: queries.length > 0 || searches > 0 || sources.length > 0, model: r.model, cost };
  }
  return { lookup };
}

module.exports = { createWebLookup, PROMPTS };
