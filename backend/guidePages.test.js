'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gp = require('./guidePages');

const INDEX = `<html><body>
<a href="/reading-lists/1994-zero-hour-dc-comicslocg"><span>EVENT</span><h3>Zero Hour</h3><p>42 issues</p></a>
<a href="https://www.findmecomics.com/reading-lists/the-sinestro-corps-war"><h3>The Sinestro Corps War</h3></a>
<a href="/reading-lists/dc-ko"><h3>DC K.O.</h3></a>
<a href="/reading-lists/secret-wars"><h3>Secret Wars</h3></a>
<a href="/reading-lists/acts-of-vengeance"><h3>Acts of Vengeance (1989)</h3></a>
<a href="/reading-lists?page=2">Next →</a></body></html>`;

test('parseIndex: list links with their titles, not paging links', () => {
  const l = gp.parseIndex(INDEX);
  assert.deepEqual(l.map(x => x.slug), ['1994-zero-hour-dc-comicslocg', 'the-sinestro-corps-war', 'dc-ko', 'secret-wars', 'acts-of-vengeance']);
  assert.equal(l[0].title, 'Zero Hour');
  assert.equal(l[4].title, 'Acts of Vengeance (1989)');
});

test('fmcCandidates: matches by title or slug, short names, and title years', () => {
  const l = gp.parseIndex(INDEX);
  assert.equal(gp.fmcCandidates(l, 'Zero Hour: Crisis in Time', 1994)[0].slug, '1994-zero-hour-dc-comicslocg');
  assert.equal(gp.fmcCandidates(l, 'Sinestro Corps War', 2007)[0].slug, 'the-sinestro-corps-war');
  assert.equal(gp.fmcCandidates(l, 'DC K.O.', 2025)[0].slug, 'dc-ko');
  assert.equal(gp.fmcCandidates(l, 'Acts of Vengeance', 2011).length, 0);
  assert.equal(gp.fmcCandidates([{ slug: 'infinity-gauntlet', title: 'Infinity Gauntlet' }], 'Infinity', 2013).length, 0);
  assert.equal(gp.fmcCandidates(l, 'Secret Wars', 1984)[0].slug, 'secret-wars');   // no year in the title: the page check decides
});

const page = (title, issues) => `<html><head><title>${title}</title></head><body><h1>${title}</h1><ol>${issues.map(i => `<li>${i}</li>`).join('')}</ol></body></html>`;

test('checkPage: wrong era, empty shell and wrong event are rejected', () => {
  const sw2015 = page('Secret Wars Reading Order — 229 Issues', ['Black Widow #19 (2015)', 'Secret Wars #1 (2015)', 'Secret Wars #2 (2015)', 'Secret Wars #3 (2015)']);
  assert.equal(gp.checkPage(sw2015, 'Secret Wars', 1984).ok, false);
  assert.equal(gp.checkPage(sw2015, 'Secret Wars', 2015).ok, true);
  assert.equal(gp.checkPage(page('Reading Orders : Comic Book Reading Orders & Timelines', []), 'DC One Million', 1998, { checkYears: false }).ok, false);
  assert.equal(gp.checkPage(page('Infinity Reading Order', ['Infinity #1 (2013)', 'Avengers #18 (2013)', 'New Avengers #9 (2013)']), 'DC K.O.', 2025).ok, false);
  // Volume years elsewhere are not issue years.
  assert.equal(gp.checkPage(page('DC K.O. Reading Order', ['Superman (2023) #28', 'Superman (2023) #29', 'Titans (2023) #28']), 'DC K.O.', 2025, { checkYears: false }).ok, true);
});

test('findGuidePages: index cached, checked pages handed over, misses noted', async () => {
  const pages = {
    'https://www.findmecomics.com/reading-lists?page=1': INDEX,
    'https://www.findmecomics.com/reading-lists/dc-ko': page('DC K.O. Reading Order — 43 Issues', ['DC K.O. #1 (2025)', 'Titans #28 (2025)', 'Superman #31 (2025)']),
    'https://www.readingorders.com/reading-orders/dc-ko': page('DC K.O. Reading Order', ['DC K.O. #1', 'Superman #31', 'Titans #28']),
  };
  const gets = [];
  const axios = { get: async url => { gets.push(url); return pages[url] ? { status: 200, data: pages[url] } : { status: 404, data: '' }; } };
  let saved = null;
  const store = { get: () => saved, set: v => { saved = v; } };
  const r = await gp.findGuidePages({ name: 'DC K.O.', year: 2025, axios, store });
  assert.deepEqual(r.pages.map(p => p.code), ['FMC', 'RO']);
  assert.ok(JSON.parse(saved).lists.length === 5);
  assert.ok(r.tried.some(t => t.code === 'CBT' && t.why === 'did not load'));
  const n = gets.length;
  await gp.findGuidePages({ name: 'DC K.O.', year: 2025, axios, store });
  assert.equal(gets.filter(u => /\?page=/.test(u)).length, 2);   // page 1 then the empty page 2, once: the second run used the cache
  assert.ok(gets.length > n);
  const block = gp.guidePagesPrompt(r.pages);
  assert.match(block, /FMC: https:\/\/www\.findmecomics\.com\/reading-lists\/dc-ko/);
  assert.match(block, /never guess a page address/);
  assert.equal(gp.guidePagesPrompt([]), '');
});

test('searchResults: links on the site that name the event and look like a guide', () => {
  const html = `<a href="https://www.howtolovecomics.com/2025/10/01/dc-ko-reading-order/">DC K.O. Reading Order</a>
    <a href="https://www.howtolovecomics.com/2025/09/01/absolute-batman-reading-order/">Absolute Batman Reading Order</a>
    <a href="https://www.howtolovecomics.com/2025/10/02/dc-ko-review/">DC K.O. #1 review</a>
    <a href="https://example.com/dc-ko-reading-order/">DC K.O. Reading Order</a>`;
  const r = gp.searchResults(html, 'HTLC', 'DC K.O.');
  assert.deepEqual(r.map(x => x.url), ['https://www.howtolovecomics.com/2025/10/01/dc-ko-reading-order/']);
});

test('findEditorialPage: searches the sites in era order and returns the first page that checks', async () => {
  const page = '<h1>DC K.O. Reading Order</h1><p>DC K.O. #1, DC K.O. #2, Superman #33, Flash #28</p>';
  const calls = [];
  const axios = { get: async url => {
    calls.push(url);
    if (url.includes('howtolovecomics.com/?s=')) return { status: 200, data: '<a href="https://www.howtolovecomics.com/dc-ko-reading-order/">DC K.O. Reading Order</a>' };
    if (url.includes('howtolovecomics.com/dc-ko')) return { status: 200, data: page };
    return { status: 404, data: '' };
  } };
  const r = await gp.findEditorialPage({ name: 'DC K.O.', year: 2025, axios });
  assert.deepEqual(r.page, { code: 'HTLC', url: 'https://www.howtolovecomics.com/dc-ko-reading-order/' });
  assert.ok(calls[0].includes('howtolovecomics.com'));        // modern event: How To Love Comics first
  const old = await gp.findEditorialPage({ name: 'Zero Hour', year: 1994, axios: { get: async u => { calls.push(u); return { status: 404, data: '' }; } } });
  assert.equal(old.page, null);
  assert.ok(old.tried[0].code === 'OMNI');                     // older event: Omniverse first
});

test('searchResults: minified HTML with unquoted attributes (How To Love Comics)', () => {
  const html = `<article\nclass=article-card><a\nhref=https://www.howtolovecomics.com/2025/09/03/dc-k-o-reading-order-checklist/ title="DC K.O. Reading Order Checklist" rel=bookmark>\n<img\nwidth=850 src=x.webp alt></a>
    <h2><a\nhref=https://www.howtolovecomics.com/2025/09/03/dc-k-o-reading-order-checklist/ rel=bookmark>DC K.O. Reading Order Checklist</a></h2>
    <a\nhref=https://www.howtolovecomics.com/2026/08/02/superman-kingdom-of-zod-reading-order/ rel=bookmark>Superman: Kingdom of Zod Reading Order Checklist</a>
    <a\nhref=/contact>Get in touch!</a>`;
  assert.deepEqual(gp.searchResults(html, 'HTLC', 'DC K.O.').map(x => x.url), ['https://www.howtolovecomics.com/2025/09/03/dc-k-o-reading-order-checklist/']);
});

test('readUserPage: reads any public page, reports checks as warnings; userPagePrompt carries the text', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }];
  const html = '<html><body><h1>DC One Million reading order</h1><p>' + 'DC One Million #1, JLA #1000000, Detective Comics #1000000. '.repeat(40) + '</p></body></html>';
  const axios = { get: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: html }) };
  const p = await gp.readUserPage({ url: 'https://example.tumblr.com/post/1/dc-one-million', name: 'DC One Million', year: 1998, axios, lookup });
  assert.equal(p.namesEvent, true);
  assert.ok(p.issueMarks >= 3);
  assert.deepEqual(p.warnings, []);
  const other = await gp.readUserPage({ url: 'https://example.com/x', name: 'Zero Hour', axios, lookup });
  assert.ok(other.warnings.some(w => /does not name the event/.test(w)));
  const prompt = gp.userPagePrompt(p);
  assert.ok(prompt.includes('source code USER') && prompt.includes('DC One Million #1') && prompt.includes('do not search'));
  await assert.rejects(() => gp.readUserPage({ url: 'http://localhost/x', name: 'X', axios, lookup }));
});

test('readUserPage: pasted text is used instead of fetching, and cut at the limit', async () => {
  const axios = { get: async () => { throw new Error('should not fetch'); } };
  const text = 'DC One Million Reading Order\r\n\r\n\r\n' + 'Action Comics #1000000 — Superman of the 853rd century. '.repeat(60);
  const p = await gp.readUserPage({ url: 'https://bringbackwendellvaughn.tumblr.com/post/170537028765/dc-one-million-reading-order', name: 'DC One Million', axios, pastedText: text });
  assert.equal(p.pasted, true);
  assert.equal(p.namesEvent, true);
  assert.ok(!p.text.includes('\r') && !p.text.includes('\n\n\n'));
  assert.ok(gp.userPagePrompt(p).includes('The admin copied its text'));
  const big = await gp.readUserPage({ url: '', name: 'X', axios, pastedText: 'X #1 '.repeat(20000), maxChars: 1000 });
  assert.equal(big.url, null);
  assert.ok(big.warnings.some(w => /long page/.test(w)));
});

test('nameForms / searchForms: two-part names match joined with "and"; parts are for searching only', () => {
  assert.deepEqual(gp.nameForms('House of X / Powers of X'), ['House of X / Powers of X', 'House of X and Powers of X']);
  assert.deepEqual(gp.searchForms('Avengers vs. X-Men'), ['Avengers vs. X-Men', 'Avengers and X-Men', 'Avengers', 'X-Men']);
  assert.deepEqual(gp.nameForms('DC K.O.'), ['DC K.O.']);
  assert.equal(gp.checkPage('<h1>House of X and Powers of X Reading Order</h1><p>House of X #1, Powers of X #1, House of X #2</p>', 'House of X / Powers of X', 2019).ok, true);
});
