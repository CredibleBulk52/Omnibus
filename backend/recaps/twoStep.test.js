'use strict';
// Two-step recap lookups (2026-10-20): Web Search finds pages, Omnibus reads them, the Summary
// Writer writes and rates; fallbacks; the trust rule for medium ratings from issue pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSynopses } = require('./synopses');

function setup({ finder, pages = {}, writer }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, title TEXT, comicinfo TEXT, cv_issue_id TEXT, sort_order REAL);
    INSERT INTO scanned_series VALUES ('s', 'Superman', 2023);
    INSERT INTO scanned_books VALUES ('b34', 's', '34', '', '<ComicInfo><Series>Superman</Series><Number>34</Number><Year>2026</Year></ComicInfo>', '1154070', 34);`);
  const calls = [], read = [];
  const ai = { complete: async o => {
    calls.push(o);
    if (o.task === 'recap_web' && o.webSearch) return { model: 'claude-haiku-5-5', text: JSON.stringify({ found: true, synopsis: 'Direct search summary.', source_url: 'https://example.com/r', confidence: 'medium' }), usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } }, data: { content: [] } };
    return { model: 'claude-haiku-5-5', text: JSON.stringify(writer), usage: { input_tokens: 5000, output_tokens: 300 } };
  } };
  const webLookup = { lookup: async (q, o) => { calls.push({ task: 'web_lookup', q, o }); return finder; } };
  const readPage = async url => { read.push(url); if (!pages[url]) throw new Error('the page answered 403'); return { url, text: pages[url] }; };
  const s = createSynopses({ db, ai, logger: { info() {}, warn() {} }, modelCatalog: { price: () => ({ in: 0.1, out: 0.5 }), searchFee: () => 0.01 }, axios: {}, webLookup, readPage });
  return { s, calls, read };
}
const long = t => `${t} `.repeat(200);

test('two-step: the issue page is read first; the writer gets the pages; a medium rating from it is trusted', async () => {
  const wiki = 'https://dc.fandom.com/wiki/Superman_Vol_6_34', review = 'https://blog.example.com/news/superman-review';
  const { s, calls, read } = setup({
    finder: { notes: 'Lois and the robot cross the Arctic.', sources: [{ url: review }, { url: wiki }], queries: ['Superman 34 2026 recap'], grounded: true, model: 'gemini:gemini-3.5-flash-lite', cost: 0.001 },
    pages: { [wiki]: long('Saturn Girl threatens Lois.'), [review]: long('A review.') },
    writer: { found: true, synopsis: 'Superboy-Prime arrives.', source_url: wiki, confidence: 'medium', covers_ending: true, source_is_this_issue: true } });
  const r = await s.tryWeb('b34');
  assert.equal(read[0], wiki, 'the wiki page for the issue is read first');
  const w = calls.find(c => c.task === 'recap_web');
  assert.ok(!w.webSearch, 'the writer does not search');
  assert.match(w.prompt, /Saturn Girl threatens Lois/);
  assert.match(w.prompt, /SEARCH NOTES[\s\S]*Arctic/);
  assert.equal(calls.find(c => c.task === 'web_lookup').o.detail, 'full');
  assert.equal(r.source_url, wiki);
  assert.equal(r.would_page_check, false, 'medium from an issue page that covers the ending is trusted');
});

test('two-step: a medium rating from a review still goes to the page read', async () => {
  const review = 'https://blog.example.com/superman-34-review';
  const { s } = setup({ finder: { notes: 'x', sources: [{ url: review }], queries: ['q'], grounded: true, model: 'g', cost: 0 },
    pages: { [review]: long('Review text.') }, writer: { found: true, synopsis: 'Partial.', source_url: review, confidence: 'medium', covers_ending: true, source_is_this_issue: true } });
  assert.equal((await s.tryWeb('b34')).would_page_check, true);
});

test('no search, or no readable page → nothing found (the issue goes to the Page Reader), no writer search', async () => {
  const a = setup({ finder: { notes: 'from memory', sources: [], queries: [], grounded: false, model: 'g', cost: 0 }, writer: {} });
  const ra = await a.s.tryWeb('b34');
  assert.equal(ra.found, false);
  assert.equal(ra.would_page_check, true);
  assert.ok(!a.calls.some(c => c.task === 'recap_web'), 'no writer call, no direct search');
  assert.deepEqual(a.calls.filter(c => c.task === 'web_lookup').map(c => c.o.detail), ['full', 'retry'], 'asked again once');
  const b = setup({ finder: { notes: 'n', sources: [{ url: 'https://x.com/a' }], queries: ['q'], grounded: true, model: 'g', cost: 0 }, pages: {}, writer: {} });
  const rb = await b.s.tryWeb('b34');
  assert.equal(rb.found, false);
  assert.match(rb.steps.fallback, /could be read/);
});

test('backed notes (Gemini grounding) count as a source; enough even when no page downloads', async () => {
  const { s, calls } = setup({
    finder: { notes: 'raw notes', backed: 'Alanna executed her father Sardath. Emily Hawk snapped Shade\'s neck.', sources: [{ url: 'https://comicbookclique.com/review-agl-13' }], queries: ['q'], grounded: true, model: 'gemini:gemini-3.8-flash', cost: 0.002 },
    pages: {}, writer: { found: true, synopsis: 'Emily Hawk killed Shade.', source_url: 'x', confidence: 'high', covers_ending: true, source_is_this_issue: true } });
  const r = await s.tryWeb('b34');
  const w = calls.find(c => c.task === 'recap_web');
  assert.ok(!w.webSearch, 'no direct search: the backed notes were enough');
  assert.match(w.prompt, /each sentence is backed by a search result[\s\S]*snapped Shade/);
  assert.match(w.prompt, /Judge the notes and the pages together/);
  assert.equal(r.source_url, 'https://comicbookclique.com/review-agl-13');
});

test('stretch summaries use the two-step lookup too (no writer search)', async () => {
  const { createArcs } = require('./arcs');
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const ai = { complete: async o => { calls.push(o); return { model: 'claude-haiku-5-5', text: JSON.stringify({ found: true, synopsis: 'Clark fought the Lazarus Corporation.', source_url: 'https://dc.fandom.com/wiki/x', confidence: 'high', covers_ending: true }), usage: { input_tokens: 9000, output_tokens: 200 } }; } };
  const webLookup = { lookup: async (q, o) => { calls.push({ task: 'web_lookup', q, o }); return { notes: 'n', backed: 'Clark fought them.', sources: [{ url: 'https://dc.fandom.com/wiki/x' }], queries: ['q'], grounded: true, model: 'gemini:gemini-3.8-flash', cost: 0.003 }; } };
  const arcs = createArcs({ db, ai, logger: { info() {}, warn() {} }, modelCatalog: { price: () => ({ in: 0.1, out: 0.5 }) }, axios: {}, webLookup, readPage: async url => ({ url, text: 'Wiki text. '.repeat(200) }) });
  const g = { books: [{ id: 'b1', series: 'Absolute Superman', series_year: 2024, number: '1', cover_year: 2024 }, { id: 'b4', series: 'Absolute Superman', series_year: 2024, number: '4', cover_year: 2025 }], name: null, writers: [] };
  const r = await arcs.ensureSummary('scope', g);
  assert.equal(r.status, 'ok');
  assert.equal(calls.find(c => c.task === 'web_lookup').o.detail, 'arc');
  const w = calls.find(c => c.task === 'recap_web');
  assert.ok(!w.webSearch && !w.webFetch, 'the writer does not search');
  assert.match(w.prompt, /Wiki text\./);
});
