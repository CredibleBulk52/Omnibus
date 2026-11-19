'use strict';
// postProcessScan.js (moved out of server.js 2026-11-19): several filed downloads in a row give one
// scan, 10 s after the last, of only the libraries that received files (every library when the
// destination is unknown), then the Download Manager is told to reload.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostProcessScan } = require('./postProcessScan');

test('downloads filed in a row are scanned once, in the libraries that received them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const libs = [{ id: 'a', name: 'Marvel', path: '/comics/Marvel' }, { id: 'b', name: 'DC', path: '/comics/DC' }];
  const scanned = [], pushed = [];
  const { schedulePostProcessScan } = createPostProcessScan({ db: { prepare: () => ({ all: () => libs }) }, logger: { info() {}, warn() {} },
    pushSseEvent: e => pushed.push(e.type), runLibraryScan: async (lib, why) => { scanned.push(`${lib.name}:${why}`); } });
  schedulePostProcessScan('/comics/DC/Batman (2016)/Batman 001.cbz');
  t.mock.timers.tick(5000);
  schedulePostProcessScan('/comics/DC/Superman (2018)/Superman 001.cbz');
  t.mock.timers.tick(9999);
  assert.deepEqual(scanned, []);   // still waiting for quiet
  t.mock.timers.tick(1); await new Promise(r => setImmediate(r));
  assert.deepEqual(scanned, ['DC:postprocess']);
  assert.deepEqual(pushed, ['series_updated']);
  schedulePostProcessScan(); t.mock.timers.tick(10000); await new Promise(r => setImmediate(r));
  assert.deepEqual(scanned.slice(1), ['Marvel:postprocess', 'DC:postprocess']);   // destination unknown: every library
});
