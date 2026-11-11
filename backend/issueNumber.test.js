'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const IN = require('./issueNumber');

test('Marvel NOW! branding falls back to the plain number only when Comic Vine lists it that way', () => {
  assert.equal(IN.brandingFallback('023.NOW', ['22', '23', '24']), '23');      // Iron Man 2013, pack 856
  assert.equal(IN.brandingFallback('23.NOW', ['23', '23.NOW']), '23.NOW');    // Comic Vine has the suffixed issue
  assert.equal(IN.brandingFallback('5.NOW', ['4', '6']), '5.NOW');            // no plain #5 either
  assert.equal(IN.brandingFallback('8AU', ['8']), '8AU');                     // tie-ins are separate issues
  assert.equal(IN.brandingFallback('20.INH', ['20', '20.INH']), '20.INH');
  assert.equal(IN.brandingFallback('12', ['12']), '12');
});
