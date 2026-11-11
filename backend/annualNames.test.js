'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { annualNameFits, yearlyTag, isAnnualName, yearlyAnnualYears } = require('./annualNames');

test('annual names: "… Annual" volumes, unchanged rules', () => {
  assert.equal(annualNameFits('X-Men Annual', 'Uncanny X-Men'), true);                       // the rename case
  assert.equal(annualNameFits('Batman/Superman: World\'s Finest 2024 Annual', 'Batman/Superman: World\'s Finest'), true);
  assert.equal(annualNameFits('Amazing Spider-Man Annual', 'Spider-Versity'), false);
  assert.equal(annualNameFits('Annual', 'Spawn'), false);
});

test('annual names: Marvel\'s yearly annuals ("Title \'96") and the 1998 two-title ones', () => {
  assert.equal(yearlyTag("Sensational Spider-Man '96"), 1996);
  assert.equal(yearlyTag('Sensational Spider-Man ’97'), 1997);
  assert.equal(yearlyTag('Sensational Spider-Man'), null);
  assert.equal(isAnnualName("Uncanny X-Men '96"), true);
  assert.equal(isAnnualName('Spider-Man 2099'), false);
  assert.equal(annualNameFits("Sensational Spider-Man '96", 'The Sensational Spider-Man'), true);
  assert.equal(annualNameFits("The Incredible Hulk '97", 'The Incredible Hulk'), true);
  assert.equal(annualNameFits("Uncanny X-Men / Fantastic Four '98", 'Uncanny X-Men'), true);
  assert.equal(annualNameFits("Peter Parker: Spider-Man/Elektra '98", 'Peter Parker: Spider-Man'), true);
  assert.equal(annualNameFits("Uncanny X-Men / Fantastic Four '98", 'Fantastic Four'), false);   // the first title's
  assert.equal(annualNameFits("Spider-Man '97", 'The Sensational Spider-Man'), false);           // Spider-Man (1990)'s
  assert.equal(annualNameFits("Spider-Man '97", 'Spider-Man'), true);
});

test('annual names: which yearly searches a run needs', () => {
  assert.deepEqual(yearlyAnnualYears(1996, 1998), [1996, 1997, 1998]);
  assert.deepEqual(yearlyAnnualYears(1991, 1996), [1995, 1996, 1997]);
  assert.deepEqual(yearlyAnnualYears(2006, 2008), []);
  assert.deepEqual(yearlyAnnualYears(1980, 1990), []);
  assert.deepEqual(yearlyAnnualYears(null, 1998), []);
});
