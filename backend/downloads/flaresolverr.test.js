'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlareSolverr, looksChallenged, unfinished, cloudflareError } = require('./flaresolverr');

// A fake FlareSolverr: sessions supported unless told otherwise; cached cookies rejected by
// "Cloudflare" unless cookiesWork.
function fake({ sessionsOk = true, cookiesWork = false, delay = 10 } = {}) {
  const calls = [];
  let active = 0, maxActive = 0;
  return {
    calls, maxActive: () => maxActive,
    post: async (url, body) => {
      calls.push(body);
      if (body.cmd === 'sessions.create') return sessionsOk ? { data: { status: 'ok' } } : { data: { status: 'error', message: 'Unknown cmd' } };
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, delay)); active--;
      return { data: { solution: { status: 200, response: `<html>page ${body.url}</html>`, cookies: [{ name: 'cf_clearance', value: 'c' }], userAgent: 'UA' } } };
    },
    get: async () => (cookiesWork ? { status: 200, data: '<html>via cookies</html>' } : { status: 403, data: 'no' }),
  };
}
const gets = calls => calls.filter(c => c.cmd === 'request.get');

test('sessions: one session per domain, every page through it, one request at a time', async () => {
  const ax = fake();
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax, useSessions: true });
  const pages = await Promise.all(['https://getcomics.org/?s=a', 'https://getcomics.org/post-a', 'https://getcomics.org/post-b'].map(u => fs.fetchPage(u)));
  assert.match(pages[1], /post-a/); assert.match(pages[2], /post-b/);
  assert.equal(ax.calls.filter(c => c.cmd === 'sessions.create').length, 1);
  assert.ok(gets(ax.calls).every(c => c.session === 'omnibus-getcomics.org' && c.session_ttl_minutes === 30));
  assert.equal(ax.maxActive(), 1);                                    // the session browser is never asked twice at once
  await fs.fetchPage('https://leagueofcomicgeeks.com/x');
  assert.equal(ax.calls.filter(c => c.cmd === 'sessions.create').length, 2);
  assert.equal(fs.cache.get('getcomics.org').userAgent, 'UA');        // cookies still kept for downloads
});

test('sessions unavailable: one-off solves, as before', async () => {
  const ax = fake({ sessionsOk: false });
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax, useSessions: true });
  await fs.fetchPage('https://getcomics.org/a'); await fs.fetchPage('https://getcomics.org/b');
  assert.equal(ax.calls.filter(c => c.cmd === 'sessions.create').length, 1);   // asked once, remembered
  assert.ok(gets(ax.calls).every(c => !c.session));
});

test('working cached cookies skip FlareSolverr; a session FlareSolverr forgot is made again', async () => {
  const ax = fake({ cookiesWork: true });
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax, useSessions: true });
  await fs.fetchPage('https://getcomics.org/a');
  assert.equal(await fs.fetchPage('https://getcomics.org/b'), '<html>via cookies</html>');
  assert.equal(gets(ax.calls).length, 1);
  let forgot = true;
  const ax2 = fake();
  const realPost = ax2.post;
  ax2.post = async (u, body) => {
    if (body.cmd === 'request.get' && forgot) { forgot = false; const e = new Error('500'); e.response = { data: { message: 'Error: The session does not exist.' } }; throw e; }
    return realPost(u, body);
  };
  const fs2 = createFlareSolverr({ url: 'http://fs:8191', axios: ax2, useSessions: true });
  assert.match(await fs2.fetchPage('https://getcomics.org/a'), /page/);
  assert.equal(ax2.calls.filter(c => c.cmd === 'sessions.create').length, 2);  // the first create, then re-made after the error
});

test('challenge pages and failures', async () => {
  assert.ok(looksChallenged('<title>Just a moment...</title>') && !looksChallenged('<html>ok</html>'));
  assert.ok(!looksChallenged('<html><title>Search</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>'));
  const ax = { post: async (u, b) => (b.cmd === 'sessions.create' ? { data: { status: 'ok' } } : { data: { message: 'Error solving the challenge' } }), get: async () => ({ status: 403 }) };
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax, useSessions: true });
  await assert.rejects(fs.fetchPage('https://getcomics.org/a'), /FlareSolverr: Error solving the challenge/);
  await assert.rejects(fs.fetchPage('https://getcomics.org/b'), /Error solving the challenge/);   // the queue keeps going after a failure
});

test('an unfinished page (head, empty body) is fetched again with more time, then reported', async () => {
  const half = '<html><head><title>You searched for x – GetComics</title></head><body></body></html>';
  assert.ok(unfinished(half) && !unfinished('<html><body><article>x</article></body></html>'));
  let n = 0; const timeouts = [], sessionsUsed = [];
  const ax = { get: async () => ({ status: 403 }), post: async (u, b) => {
    if (b.cmd === 'sessions.create') return { data: { status: 'ok' } };
    timeouts.push(b.maxTimeout); sessionsUsed.push(!!b.session); n++;
    return { data: { solution: { status: 200, response: n === 1 ? half : '<html><body><article>ok</article></body></html>', cookies: [], userAgent: 'UA' } } };
  } };
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax, useSessions: true });
  assert.match(await fs.fetchPage('https://getcomics.org/?s=x'), /article/);
  assert.deepEqual(timeouts, [90000, 120000]);
  assert.deepEqual(sessionsUsed, [true, false]);                  // the retry skips the session
  const always = { get: async () => ({ status: 403 }), post: async (u, b) => (b.cmd === 'sessions.create' ? { data: { status: 'ok' } } : { data: { solution: { status: 200, response: half, cookies: [], userAgent: 'UA' } } }) };
  await assert.rejects(createFlareSolverr({ url: 'http://fs:8191', axios: always, useSessions: true }).fetchPage('https://getcomics.org/?s=y'), /didn't finish loading \(site slow\)/);
});

test('sessions are off by default; FlareSolverr errors carry its own reason', async () => {
  const ax = fake();
  const fs = createFlareSolverr({ url: 'http://fs:8191', axios: ax });
  await fs.fetchPage('https://getcomics.org/a');
  assert.equal(ax.calls.filter(c => c.cmd === 'sessions.create').length, 0);
  assert.ok(gets(ax.calls).every(c => !c.session));
  const e500 = { get: async () => ({ status: 403 }), post: async () => { const e = new Error('Request failed with status code 500'); e.response = { status: 500, data: { message: 'Error: Error solving the challenge. Timeout after 90.0 seconds.' } }; throw e; } };
  await assert.rejects(createFlareSolverr({ url: 'http://fs:8191', axios: e500 }).fetchPage('https://getcomics.org/a'), /^Error: FlareSolverr: Error solving the challenge\. Timeout after 90\.0 seconds\.$/);
  const slow = { get: async () => ({ status: 403 }), post: async () => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e; } };
  await assert.rejects(createFlareSolverr({ url: 'http://fs:8191', axios: slow }).fetchPage('https://getcomics.org/a'), /did not answer within 95 s/);
});

test('Cloudflare error pages (520–530) are reported, not read as an empty search; media is skipped', async () => {
  const page520 = '<!DOCTYPE html><html><head><title>getcomics.org | 520: Web server is returning an unknown error</title></head><body><div>Cloudflare</div></body></html>';
  assert.deepEqual(cloudflareError(page520), { code: 520, text: 'Web server is returning an unknown error' });
  assert.equal(cloudflareError('<html><head><title>You searched for x – GetComics</title></head><body>x</body></html>'), null);
  const bodies = [];
  const ax = { get: async () => ({ status: 403 }), post: async (u, b) => { bodies.push(b); return { data: { solution: { status: 200, response: page520, cookies: [], userAgent: 'UA' } } }; } };
  await assert.rejects(createFlareSolverr({ url: 'http://fs:8191', axios: ax }).fetchPage('https://getcomics.org/?s=x'), /getcomics\.org is having trouble: Cloudflare 520 \(Web server is returning an unknown error\)/);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].disableMedia, true);
});
