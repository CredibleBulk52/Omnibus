'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assertPublicHttpUrl, isPublicAddress } = require('./urlSafety');

const lookupTo = (...addresses) => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

test('public, private and special addresses are told apart', () => {
  for (const a of ['8.8.8.8', '104.21.3.4', '2606:4700::1111']) assert.equal(isPublicAddress(a), true, a);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.1.10', '::ffff:127.0.0.1', 'not-an-ip']) assert.equal(isPublicAddress(a), false, a);
});

test('public http(s) addresses are accepted', async () => {
  const url = await assertPublicHttpUrl('https://getcomics.org/dlds/abc', { lookup: lookupTo('104.21.3.4') });
  assert.equal(url.hostname, 'getcomics.org');
  await assertPublicHttpUrl('http://8.8.8.8/file.cbz', { lookup: () => { throw new Error('IP literals need no lookup'); } });
});

test('local, private and non-web addresses are refused', async () => {
  const cases = [
    ['file:///etc/passwd', lookupTo('8.8.8.8')],
    ['ftp://example.com/x', lookupTo('8.8.8.8')],
    ['http://localhost:9810/api/settings', lookupTo('127.0.0.1')],
    ['http://sabnzbd.local/api', lookupTo('8.8.8.8')],
    ['http://127.0.0.1:8080/', lookupTo()],
    ['http://[::1]/', lookupTo()],
    ['http://169.254.169.254/latest/meta-data/', lookupTo()],
    ['http://router.example/', lookupTo('192.168.1.1')],
    ['http://mixed.example/', lookupTo('8.8.8.8', '10.0.0.2')],
    ['http://user:pass@example.com/', lookupTo('8.8.8.8')],
    ['not a url', lookupTo('8.8.8.8')],
  ];
  for (const [value, lookup] of cases) {
    await assert.rejects(assertPublicHttpUrl(value, { lookup }), e => e.status === 400 && e.code === 'UNSAFE_URL', value);
  }
  await assert.rejects(assertPublicHttpUrl('http://nowhere.invalid/', { lookup: async () => { throw new Error('ENOTFOUND'); } }), /could not be resolved/);
});
