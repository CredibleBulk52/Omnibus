'use strict';
// Recaps (recaps/): synopsis waterfall, arc grouping, scope and limits, gathering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { arcFromTitle, writerRuns, firstWriter } = require('./arcs');
const { comicInfoSynopsis } = require('./synopses');
const createRecaps = require('./index');

const ci = ({ series, number, title = '', writer = 'Writer A', year = 2020, summary = '' }) =>
  `<ComicInfo><Series>${series}</Series><Number>${number}</Number><Title>${title}</Title><Year>${year}</Year><Writer>${writer}</Writer>${summary ? `<Summary>${summary}</Summary>` : ''}</ComicInfo>`;

function setup({ reply, pagesReply, aiCalls = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scanned_series (id TEXT PRIMARY KEY, name TEXT, year INTEGER);
    CREATE TABLE scanned_books (id TEXT PRIMARY KEY, series_id TEXT, issue_number TEXT, title TEXT, comicinfo TEXT, cv_issue_id TEXT, sort_order REAL);
    CREATE TABLE read_progress (id INTEGER PRIMARY KEY, book_id TEXT, user_id TEXT, page INTEGER, completed INTEGER, updated_at TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE event_issues (id INTEGER PRIMARY KEY, event_id TEXT, scanned_book_id TEXT, sort_order INTEGER, tier TEXT);
    CREATE TABLE canon_runs (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE canon_run_issues (id INTEGER PRIMARY KEY, run_id INTEGER, scanned_book_id INTEGER, sort_order INTEGER);
    CREATE TABLE reading_lists (id INTEGER PRIMARY KEY, name TEXT);`);
  const addSeries = (id, name, year, issues) => {
    db.prepare('INSERT INTO scanned_series VALUES (?, ?, ?)').run(id, name, year);
    issues.forEach((x, k) => db.prepare('INSERT INTO scanned_books VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}-${k + 1}`, id, String(k + 1), x.title || '', ci({ series: name, number: k + 1, year, ...x }), `${id}cv${k + 1}`, k + 1));
  };
  const ai = {
    complete: async o => {
      aiCalls.push(o);
      const isPages = o.task === 'recap_reader';
      const out = isPages ? (pagesReply || { found: true, beats: [{ pages: '1', what: 'x' }], synopsis: 'From the pages.', confidence: 'high' })
        : (typeof reply === 'function' ? reply(o) : reply || { found: true, synopsis: 'From the web.', source_url: 'https://dc.fandom.com/wiki/w', confidence: 'high' });
      return { model: isPages ? 'openai:gpt-6.1-sol' : 'claude-haiku-5-5', text: JSON.stringify(out), usage: { input_tokens: 20000, output_tokens: 1000, server_tool_use: { web_search_requests: isPages ? 0 : 2 } } };
    },
  };
  const getPageImage = async (id, k, size) => ({ data: 'eA==', media_type: 'image/jpeg', count: 3, size });
  const modelCatalog = { price: m => (/sol/.test(m) ? { in: 2, out: 10 } : { in: 0.1, out: 0.5 }) };
  const readingLists = { orderedBooks: (id, user) => (String(id) === '7' ? ['ss1-3', 'ss2-1', 'ss1-4', 'ss2-2'] : null) };
  const r = createRecaps({ db, ai, logger: { info() {}, warn() {}, error() {} }, getPageImage, modelCatalog, readingLists });
  return { db, r, aiCalls, addSeries };
}

test('arc names and part numbers come from issue titles', () => {
  assert.deepEqual(arcFromTitle('War of the Green Lanterns, Part Three'), { name: 'War of the Green Lanterns', part: 'Three' });
  assert.deepEqual(arcFromTitle('Ends of the Earth Part 1'), { name: 'Ends of the Earth', part: '1' });
  assert.deepEqual(arcFromTitle('Going Sane Part Three: Beat On the Brat'), { name: 'Going Sane', part: 'Three' });
  assert.deepEqual(arcFromTitle('Chapter Two'), { name: null, part: 'Two' });
  assert.deepEqual(arcFromTitle('Year One (Part 2)'), { name: 'Year One', part: '2' });
  assert.deepEqual(arcFromTitle('Hush 3 of 12'), { name: 'Hush', part: '3' });
  assert.equal(arcFromTitle('The Laughing Fish'), null);
  assert.equal(arcFromTitle(''), null);
});

test('writer runs keep a short fill-in inside the run', () => {
  const b = w => ({ writer_key: w });
  const runs = writerRuns([b('a'), b('a'), b('x'), b('a'), b('b'), b('b')]);
  assert.deepEqual(runs.map(r => [r.writer_key, r.books.length]), [['a', 4], ['b', 2]]);
  assert.equal(firstWriter('<Writer>Grant Morrison, Peter Milligan</Writer>'), 'grant morrison');
});

test('a ComicInfo summary counts only when long and not a sales teaser', () => {
  const story = 'Batman follows the trail of stolen chemicals to the docks, where he finds the Joker experimenting on fish. '.repeat(7);
  assert.ok(comicInfoSynopsis(`<Summary>${story}</Summary>`));
  assert.equal(comicInfoSynopsis('<Summary>Short.</Summary>'), null);
  assert.equal(comicInfoSynopsis(`<Summary>Don't miss the start of an epic! ${story}</Summary>`), null);
  assert.equal(comicInfoSynopsis(`<Summary>Who is the killer? What will Batman do? ${story}</Summary>`), null);
});

test('synopsis waterfall: ComicInfo free, web, then pages at 1125 px, then missing; stored ones are reused', async () => {
  const story = 'Selina escaped the burning penthouse and chased the kidnappers across London rooftops before losing them. '.repeat(7);
  const { r, aiCalls, addSeries } = setup({ reply: o => (/#2,/.test(o.prompt) || /#3,/.test(o.prompt) ? { found: false, synopsis: null, source_url: null, confidence: 'low' } : { found: true, synopsis: 'Web.', source_url: 'https://dc.fandom.com/wiki/w', confidence: 'high' }) });
  addSeries('cat', 'Catwoman', 2026, [{ summary: story }, {}, {}, {}]);
  const s1 = await r.synopses.ensure('cat-1');
  assert.equal(s1.source, 'comicinfo'); assert.equal(aiCalls.length, 0);
  const s4 = await r.synopses.ensure('cat-4');
  assert.equal(s4.source, 'web'); assert.equal(s4.synopsis, 'Web.'); assert.equal(aiCalls[0].task, 'recap_web');
  assert.ok(!/Summary|teaser/i.test(aiCalls[0].prompt) || !/Selina/.test(aiCalls[0].prompt));
  const s2 = await r.synopses.ensure('cat-2');
  assert.equal(s2.source, 'pages'); assert.equal(s2.synopsis, 'From the pages.');
  assert.equal(aiCalls[2].task, 'recap_reader');
  assert.equal(aiCalls[2].messages[0].content.filter(c => c.type === 'image').length, 3);
  const again = await r.synopses.ensure('cat-4');
  assert.equal(again.spent, 0); assert.equal(aiCalls.length, 3);
  const s3 = await r.synopses.ensure('cat-3', { allowPages: false });
  assert.equal(s3.status, 'missing'); assert.equal(aiCalls.length, 4);
});

test('plan: a short series read in the reader covers the whole series, the open issue left out', () => {
  const { r, addSeries } = setup();
  addSeries('agl', 'Absolute Green Lantern', 2025, Array.from({ length: 14 }, (_, k) => ({ title: k < 3 ? `Without Fear, Part ${k + 1}` : '' })));
  const p = r.scope.plan({ userId: 'u', bookId: 'agl-13' });
  assert.equal(p.case, 'short');
  assert.equal(p.spoilerLine.label, 'Absolute Green Lantern (2025) #12');
  assert.deepEqual(p.parts.near.map(x => x.label.split('#')[1]), ['7', '8', '9', '10', '11', '12']);
  assert.equal(p.parts.arcs[0].name, 'Without Fear');
  assert.equal(p.parts.arcs[0].issues, 3);
  assert.equal(p.lookups.issues, 6);
  // Even a short series needs alternatives when its fresh lookups exceed the cost limit.
  assert.equal(p.bigAsk, true);
  assert.ok(p.estimateCents > r.scope.LIMITS.bigAskCents);
  assert.equal(p.alternatives.length, 3);
  assert.ok(p.estimateCents >= 45 && p.estimateCents <= 52);   // 6 fresh issues (web + likely page check) + 1 stretch
});

test('plan: a long series stops at the last finished issue and covers the current writer run', () => {
  const { r, db, addSeries } = setup();
  addSeries('tec', 'Detective Comics', 1937, Array.from({ length: 60 }, (_, k) => ({ writer: k < 30 ? 'Writer A' : 'Writer B' })));
  for (let k = 1; k <= 50; k++) db.prepare('INSERT INTO read_progress (book_id, user_id, page, completed) VALUES (?, ?, 20, 1)').run(`tec-${k}`, 'u');
  const p = r.scope.plan({ userId: 'u', seriesId: 'tec' });
  assert.equal(p.case, 'long');
  assert.equal(p.spoilerLine.label, 'Detective Comics (1937) #50');
  assert.equal(p.parts.near.length, 6);
  assert.equal(p.earlierIssues, 30);
  const covered = p.parts.arcs.reduce((n, a) => n + a.issues, 0) + p.parts.near.length;
  assert.equal(covered, 20);      // #31–50
  const withEarlier = r.scope.plan({ userId: 'u', seriesId: 'tec', includeEarlier: true });
  assert.ok(withEarlier.parts.far.length >= 1 && withEarlier.parts.far.length <= 2);
});

test('plan: not reading means an overview with no spoiler line; issue by issue beyond 6 is a big ask', () => {
  const { r, addSeries } = setup();
  addSeries('saga', 'Saga', 2012, Array.from({ length: 54 }, () => ({})));
  const p = r.scope.plan({ userId: 'u', seriesId: 'saga' });
  assert.equal(p.reading, false); assert.equal(p.spoilerLine, null); assert.equal(p.case, 'not_reading');
  assert.equal(p.parts.near.length, 0);
  assert.ok(p.parts.arcs.length <= 8 && p.parts.older.length <= 2);
  assert.ok(p.lookups.total <= 16);
  const big = r.scope.plan({ userId: 'u', seriesId: 'saga', mode: 'issues', issueCount: 54 });
  assert.equal(big.bigAsk, true); assert.equal(big.alternatives.length, 3);
  const named = r.scope.plan({ userId: 'u', seriesId: 'saga', until: '36' });
  assert.equal(named.spoilerLine.label, 'Saga (2012) #36');
});

test('plan: a reading list scope; a spin-off gets "going in" from its Timeline event', () => {
  const { r, db, addSeries } = setup();
  addSeries('ss1', 'Parent', 2010, Array.from({ length: 6 }, () => ({})));
  addSeries('ss2', 'Spin Off', 2011, Array.from({ length: 4 }, () => ({})));
  const p = r.scope.plan({ userId: 'u', listId: 7, bookId: 'ss1-4' });
  assert.equal(p.case, 'context');
  assert.deepEqual(p.parts.near.map(x => x.label), ['Parent (2010) #3', 'Spin Off (2011) #1']);
  db.exec(`INSERT INTO events VALUES ('ev', 'Big Event');
    INSERT INTO event_issues (event_id, scanned_book_id, sort_order, tier) VALUES ('ev','ss1-4',1,'essential'),('ev','ss1-5',2,'tie-in'),('ev','ss1-6',3,'essential'),('ev','ss2-1',4,'essential');`);
  const s = r.scope.plan({ userId: 'u', bookId: 'ss2-3' });
  assert.equal(s.case, 'spin_off');
  assert.deepEqual(s.parts.goingIn.map(x => x.label), ['Parent (2010) #4', 'Parent (2010) #6']);
  assert.equal(s.goingInFrom, 'Big Event');
});

test('gather: stored material is free, arcs with every synopsis need no lookup, storedOnly spends nothing', async () => {
  const { r, aiCalls, addSeries } = setup();
  addSeries('x', 'X-Book', 2020, Array.from({ length: 10 }, (_, k) => ({ title: k < 2 ? `Opening, Part ${k + 1}` : '' })));
  await r.synopses.ensure('x-1'); await r.synopses.ensure('x-2');
  const before = aiCalls.length;
  const p = r.scope.plan({ userId: 'u', bookId: 'x-10' });
  const dry = await r.scope.gather(p, { storedOnly: true });
  assert.equal(aiCalls.length, before); assert.equal(dry.spentCents, 0);
  const progress = [];
  const g = await r.scope.gather(p, { onProgress: (d, t, l) => progress.push([d, t]) });
  assert.equal(g.material.arcs[0].source, 'issues');           // "Opening" #1–2 from stored synopses
  assert.equal(g.material.near.length, 6);
  assert.ok(progress.length >= 6 && progress.at(-1)[0] === progress.at(-1)[1]);
  const text = r.scope.asText(p, g);
  assert.match(text, /up to and including X-Book \(2020\) #9/);
  assert.match(text, /do not describe it or anything after it/);
  assert.ok(!/#10/.test(text.replace('X-Book (2020) #10 open', '')));
});

test('titles with several stories, endings and entities', () => {
  assert.deepEqual(arcFromTitle('The Jury Conclusion; Deb Donovan in What the #!$% Is Task Force Z, Part 1'), { name: 'The Jury', part: 'conclusion' });
  assert.deepEqual(arcFromTitle("Fear State: Nakano's Nightmare Finale; Foundations"), { name: "Fear State: Nakano's Nightmare", part: 'finale' });
  assert.deepEqual(arcFromTitle('&#161;Contrabandolero! Part 2'), { name: '¡Contrabandolero!', part: '2' });
});

test('a reader who is reading keeps the latest issues in detail even when "overview" is asked', () => {
  const { r, addSeries } = setup();
  addSeries('agl', 'Absolute Green Lantern', 2025, Array.from({ length: 14 }, () => ({})));
  const p = r.scope.plan({ userId: 'u', bookId: 'agl-13', mode: 'overview' });
  assert.equal(p.parts.near.length, 6);
  assert.equal(p.parts.near[5].label, 'Absolute Green Lantern (2025) #12');
});

test('labels and lookups use the volume as published, not the library folder year', () => {
  const { r, db, addSeries } = setup();
  addSeries('bat', 'Batman', 1986, [{}, {}]);
  db.prepare("UPDATE scanned_books SET comicinfo = replace(comicinfo, '</Series>', '</Series><Volume>1940</Volume>')").run();
  const p = r.scope.plan({ userId: 'u', bookId: 'bat-2' });
  assert.equal(p.spoilerLine.label, 'Batman (1940) #1');
  assert.match(r.synopses.webPrompt(r.synopses.describe({ ...db.prepare('SELECT * FROM scanned_books WHERE id = ?').get('bat-1'), series_name: 'Batman', series_year: 1986 })), /Batman \(1940\) #1/);
});

test('a review-sourced or unsure web synopsis of a recent issue is checked against the pages once', async () => {
  const { r, aiCalls, addSeries } = setup({ reply: o => (/#3,/.test(o.prompt)
    ? { found: true, synopsis: 'A vague review.', source_url: 'https://comic-watch.com/review', confidence: 'medium' }
    : { found: true, synopsis: 'Wiki.', source_url: 'https://dc.fandom.com/wiki/X_3', confidence: 'high' }) });
  addSeries('x', 'X', 2025, [{}, {}, {}, {}]);
  const s3 = await r.synopses.ensure('x-3');
  assert.equal(s3.source, 'pages'); assert.equal(s3.synopsis, 'From the pages.');
  assert.deepEqual(aiCalls.map(c => c.task), ['recap_web', 'recap_reader']);
  const s1 = await r.synopses.ensure('x-1');
  assert.equal(s1.source, 'web'); assert.equal(aiCalls.length, 3);          // wiki + high: kept
  const again = await r.synopses.ensure('x-3');
  assert.equal(again.spent, 0); assert.equal(aiCalls.length, 3);
});

test('an already stored review synopsis is upgraded when a recap needs it, and only tried once', async () => {
  const { r, db, aiCalls, addSeries } = setup({ pagesReply: { found: false, beats: [], synopsis: null, confidence: 'low' } });
  addSeries('y', 'Y', 2025, [{}, {}, {}]);
  db.prepare(`INSERT INTO issue_synopses (issue_key, book_id, status, synopsis, source, source_url, confidence, created_at) VALUES ('ycv2','y-2','ok','Thin review.','web','https://comic-watch.com/r','high',0)`).run();
  const p = r.scope.plan({ userId: 'u', bookId: 'y-3' });
  assert.equal(p.lookups.pageChecks, 1);
  await r.scope.gather(p);
  assert.ok(aiCalls.some(c => c.task === 'recap_reader'));
  const n = aiCalls.length;
  const p2 = r.scope.plan({ userId: 'u', bookId: 'y-3' });
  assert.equal(p2.lookups.pageChecks, 0);
  await r.scope.gather(p2);
  assert.equal(aiCalls.length, n);
  assert.equal(r.synopses.stored('y-2').synopsis, 'Thin review.');           // pages found nothing: the review stays
});

test('story notes: stored summaries up to the spoiler line, searchable by name, nothing looked up', async () => {
  const { r, aiCalls, addSeries } = setup({ reply: o => ({ found: true, synopsis: /#2,/.test(o.prompt) ? 'Kari read the corpse.' : /#4,/.test(o.prompt) ? 'Kari dies.' : 'Other things.', source_url: 'https://dc.fandom.com/wiki/w', confidence: 'high' }) });
  addSeries('g', 'G', 2025, Array.from({ length: 5 }, () => ({})));
  for (const k of [1, 2, 3, 4]) await r.synopses.ensure(`g-${k}`);
  const n = aiCalls.length;
  const hit = r.scope.storedNotes({ userId: 'u', bookId: 'g-4', about: 'Kari' });
  assert.match(hit.text, /Kari read the corpse/);
  assert.ok(!/Kari dies/.test(hit.text));                      // #4 is open: not covered
  assert.match(hit.text, /G \(2025\) #4 is open/);
  const none = r.scope.storedNotes({ userId: 'u', bookId: 'g-2', about: 'Kari' });
  assert.equal(none.none, true);
  const recent = r.scope.storedNotes({ userId: 'u', bookId: 'g-5', recent: 2 });
  assert.equal(recent.count, 2); assert.match(recent.text, /#3[\s\S]*#4/);
  assert.equal(aiCalls.length, n);
});

test('quick refresher material: stored synopses first, previews marked, nothing past the line, nothing looked up', async () => {
  const { r, aiCalls, addSeries } = setup();
  addSeries('q', 'Q', 2020, Array.from({ length: 15 }, (_, k) => ({ summary: k === 13 ? 'Issue fourteen preview.' : `Preview ${k + 1}.` })));
  await r.synopses.ensure('q-12');
  const n = aiCalls.length;
  const m = r.scope.briefMaterial({ userId: 'u', bookId: 'q-14' });
  assert.match(m.text, /up to and including Q \(2020\) #13/);
  assert.match(m.text, /#12 \(summary\): From the web\./);
  assert.match(m.text, /#13 \(PREVIEW, written before the issue came out\): Preview 13\./);
  assert.ok(!/Issue fourteen/.test(m.text));
  assert.match(m.text, /\(1 earlier issues are not included\.\)/);
  assert.equal(aiCalls.length, n);
});

test('estimates count a page check for every fresh recent issue', () => {
  const { r, addSeries } = setup();
  addSeries('e', 'E', 2020, Array.from({ length: 8 }, () => ({})));
  const p = r.scope.plan({ userId: 'u', bookId: 'e-8' });
  assert.equal(p.lookups.issues, 6);
  assert.ok(p.estimateCents >= 6 * 7);
});

test('a high-confidence spoiler review that covers the ending is trusted; a solicit-like one is not', async () => {
  const { r, aiCalls, addSeries } = setup({ reply: o => (/#1,/.test(o.prompt)
    ? { found: true, synopsis: 'Full plot.', source_url: 'https://reviews.example/1', confidence: 'high', covers_ending: true }
    : { found: true, synopsis: 'Set-up only.', source_url: 'https://reviews.example/2', confidence: 'high', covers_ending: false }) });
  addSeries('s', 'S', 2022, [{}, {}]);
  assert.match(aiCalls.length ? '' : r.synopses.webPrompt(r.synopses.describe({ id: 'x', comicinfo: '<Series>S</Series><Number>1</Number>' })), /plot summary/);
  const a = await r.synopses.ensure('s-1');
  assert.equal(a.source, 'web');
  const b = await r.synopses.ensure('s-2');
  assert.equal(b.source, 'pages');
  assert.deepEqual(aiCalls.map(c => c.task), ['recap_web', 'recap_web', 'recap_reader']);
});

test('medium-confidence web synopses are always checked against the pages; lookups may read 2 pages in full', async () => {
  const { r, aiCalls, addSeries } = setup({ reply: o => (/#1,/.test(o.prompt)
    ? { found: true, synopsis: 'Review walk-through.', source_url: 'https://thebatmanuniverse.net/detective-comics-186/', confidence: 'medium', covers_ending: true, source_is_this_issue: true }
    : /#2,/.test(o.prompt) ? { found: true, synopsis: 'Series overview.', source_url: 'https://tvtropes.org/x', confidence: 'medium', covers_ending: true, source_is_this_issue: false }
    : /#3,/.test(o.prompt) ? { found: true, synopsis: 'A quiet issue.', source_url: 'https://insidepulse.com/x', confidence: 'medium', covers_ending: false, source_is_this_issue: true }
    : { found: true, synopsis: 'Unsure.', source_url: 'https://insidepulse.com/y', confidence: 'low', covers_ending: true, source_is_this_issue: true }) });
  addSeries('m', 'M', 2022, [{}, {}, {}, {}]);
  // Medium confidence is no longer trusted (tried and undone, 2026-10-19).
  assert.equal((await r.synopses.ensure('m-1')).source, 'pages');
  assert.equal((await r.synopses.ensure('m-2')).source, 'pages');
  assert.equal((await r.synopses.ensure('m-3')).source, 'pages');
  assert.equal((await r.synopses.ensure('m-4')).source, 'pages');
  assert.equal(aiCalls.filter(c => c.task === 'recap_web' && c.webFetch === 2 && c.webFetchTokens === 15000).length, 4);
});
