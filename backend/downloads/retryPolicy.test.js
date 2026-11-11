'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createRetryPolicy, blockKind, isTransientDownloadError, MANUAL_ONLY_HOSTS } = require('./retryPolicy');

function setup(t0 = Date.parse('2026-11-03T10:00:00Z')) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE monitored_issues (id TEXT PRIMARY KEY, status TEXT, download_id TEXT, file_path TEXT, retry_after TEXT,
    last_fail_reason TEXT, retry_epoch TEXT, weekly_retries INTEGER DEFAULT 0);
    INSERT INTO monitored_issues (id, status) VALUES ('1', 'snatched'), ('2', 'snatched'), ('3', 'snatched'), ('4', 'failed');`);
  let clock = t0;
  const policy = createRetryPolicy({ db, now: () => clock });
  return { db, policy, tick: ms => { clock += ms; } };
}
const row = (db, id) => ({ ...db.prepare('SELECT status, last_fail_reason FROM monitored_issues WHERE id = ?').get(id) });

test('block kinds: only links that can never work are permanent', () => {
  assert.equal(blockKind('1024terabox.com is not supported for auto-download. The link must be downloaded manually'), 'permanent');
  assert.equal(blockKind('DDL link resolved to unsupported host'), 'permanent');
  assert.equal(blockKind('Folder URLs are pack-only, not valid for single-issue downloads'), 'permanent');
  for (const r of ['DDL download error: Request failed with status code 500', 'Post-process error: Command failed: bsdtar -xf', 'SABnzbd: Failed',
    'DDL download error: Download host returned a web page instead of the file', 'DDL failed: No download links found on page', 'Post-process: Downloaded file is not a comic archive'])
    assert.equal(blockKind(r), 'retry', r);
  assert.ok(isTransientDownloadError('DDL download error: aborted') && !isTransientDownloadError('404'));
  assert.ok(MANUAL_ONLY_HOSTS.test('https://www.terabox.com/s/x') && !MANUAL_ONLY_HOSTS.test('https://pixeldrain.com/u/x'));
});

test('triage: deploy pauses, rate limits and temporary errors never block a link', () => {
  const { db, policy, tick } = setup();
  assert.equal(policy.triage({ id: '1' }, 'https://x/f', 'DDL download error: Metadata work is paused for deployment'), 'deferred');
  assert.match(row(db, '1').last_fail_reason, /Paused while Omnibus was updating/);
  assert.equal(policy.triage({ id: '2' }, 'https://x/f', 'DDL download error: Request failed with status code 429'), 'deferred');
  assert.ok(policy.cooldownActive());
  assert.equal(policy.cooldown().strikes, 1);
  tick(11 * 60000);
  assert.ok(!policy.cooldownActive());
  for (let i = 1; i <= 3; i++) assert.equal(policy.triage({ id: '3' }, 'https://h/f', 'DDL download error: aborted'), 'deferred', `strike ${i}`);
  assert.equal(policy.triage({ id: '3' }, 'https://h/f', 'DDL download error: aborted'), 'block');   // the 4th in a row is blocked
  policy.noteSuccess('3');
  assert.equal(policy.triage({ id: '3' }, 'https://h/f', 'DDL download error: aborted'), 'deferred');
  assert.equal(policy.triage({ id: '1' }, 'https://h/f', 'DDL download error: Request failed with status code 404'), 'block');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM download_blacklist').get().n, 0);   // triage itself records nothing
});

test('a host refusing three issues with 403 pauses downloads and clears its recent 403 blocks', () => {
  const { db, policy } = setup();
  policy.record('1', 'https://fs2.host.ru/a.cbz', 'DDL download error: Request failed with status code 403');
  assert.equal(policy.triage({ id: '1' }, 'https://fs2.host.ru/a.cbz', 'status code 403'), 'block');
  assert.equal(policy.triage({ id: '2' }, 'https://fs2.host.ru/b.cbz', 'status code 403'), 'block');
  assert.equal(policy.triage({ id: '3' }, 'https://fs2.host.ru/c.cbz', 'status code 403'), 'deferred');
  assert.ok(policy.cooldownActive());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM download_blacklist').get().n, 0);
});

test('blocks: recorded with a kind, counted per round, retry kind released by the failed-issue retry', () => {
  const { db, policy } = setup();
  assert.equal(policy.record('4', 'https://a/1', 'DDL download error: Request failed with status code 500'), 'retry');
  assert.equal(policy.record('4', 'https://www.terabox.com/x', 'www.terabox.com is not supported for auto-download.'), 'permanent');
  assert.equal(policy.record('4', null, 'x'), null);
  assert.deepEqual([...policy.blocked('4')].sort(), ['https://a/1', 'https://www.terabox.com/x']);
  assert.equal(policy.attempts('4', null), 2);
  assert.equal(policy.attempts('4', '2999-01-01 00:00:00'), 0);
  db.exec("UPDATE monitored_issues SET weekly_retries = 4 WHERE id = '4'");
  assert.equal(policy.releaseForFailedRetry(4), 0);                // past the last retry: nothing released
  db.exec("UPDATE monitored_issues SET weekly_retries = 1 WHERE id = '4'");
  assert.equal(policy.releaseForFailedRetry(4), 1);
  assert.deepEqual([...policy.blocked('4')], ['https://www.terabox.com/x']);
});

test('one-time cleanup: old temporary-reason blocks released, unsupported hosts kept, runs once', () => {
  const { db, policy } = setup();
  const ins = db.prepare('INSERT INTO download_blacklist (issue_id, url, reason) VALUES (?, ?, ?)');
  ins.run('1', 'u1', 'DDL download error: Request failed with status code 500');
  ins.run('1', 'u2', 'DDL download error: aborted');
  ins.run('2', 'u3', 'vikingfile.com is not supported for auto-download. The link must be downloaded manually in your browser.');
  ins.run('2', 'u4', 'DDL download error: Metadata work is paused for deployment');
  let marked = false;
  assert.deepEqual(policy.migrate(false, () => { marked = true; }), { released: 3, permanent: 1 });
  assert.ok(marked);
  assert.deepEqual(db.prepare('SELECT url, kind FROM download_blacklist').all().map(r => `${r.url}:${r.kind}`), ['u3:permanent']);
  assert.equal(policy.migrate(true, () => {}), null);
});
