'use strict';
// Links that contradict a book's Comic Vine ID (monitoredLinks.js, 2026-11-21).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { clearContradictingMonitoredLinks } = require('./monitoredLinks');

test('a tagged book linked to another issue loses the link; agreeing and untagged links stay', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE scanned_books (id TEXT PRIMARY KEY, cv_issue_id TEXT, monitored_issue_id TEXT)');
  const add = db.prepare('INSERT INTO scanned_books VALUES (?,?,?)');
  add.run('ww1', '1014924', '1014924');      // Wonder Woman #1: its own issue
  add.run('kt1', '1001518', '1014924');      // Knight Terrors: Wonder Woman #1, linked to Wonder Woman #1
  add.run('untagged', null, '1026531');      // no Comic Vine ID: nothing contradicts the link
  add.run('blank', '', '1026531');
  add.run('free', '555', null);
  assert.equal(clearContradictingMonitoredLinks(db), 1);
  const link = id => db.prepare('SELECT monitored_issue_id AS m FROM scanned_books WHERE id = ?').get(id).m;
  assert.equal(link('ww1'), '1014924');
  assert.equal(link('kt1'), null);
  assert.equal(link('untagged'), '1026531');
  assert.equal(link('blank'), '1026531');
  assert.equal(link('free'), null);
  assert.equal(clearContradictingMonitoredLinks(db), 0);   // idempotent
});
