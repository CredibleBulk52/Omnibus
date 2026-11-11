'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicationHint } = require('./candidate');
const { parseIssueNumberEvidence } = require('./evidence');
const hint = name => { const h = publicationHint(name + '.cbz', null, null); return h && `${h.name}|${h.number}|${h.year}`; };

test('padded negatives and half issues normalize to Comic Vine numbering', () => {
  for (const [raw, expected] of [['0-1', '-1'], ['000-1', '-1'], ['-01', '-1'], ['0.5', '1/2'], ['½', '1/2'], ['1/2', '1/2'], ['8AU', '8.AU'], ['1.NOW', '1.NOW']])
    assert.equal(parseIssueNumberEvidence(raw).normalized, expected, raw);
  assert.equal(parseIssueNumberEvidence('1a').requiresReview, true);
});

test('common filename conventions produce a publication hint', () => {
  const cases = {
    'X-Men 0-1 (1997)': 'X-Men|-1|1997', 'X-Men 000-1 (1997)': 'X-Men|-1|1997',
    'Batman v2 001 (2011)': 'Batman|1|2011', 'Batman Vol. 2 001 (2011)': 'Batman|1|2011',
    'Batman 001 (2011) (2 covers)': 'Batman|1|2011', 'Batman 001 (2011) (Fixed)': 'Batman|1|2011',
    'Batman 001 (2011) (c2c) (Glorith-HD)': 'Batman|1|2011', 'Batman 001 (Nov 2011)': 'Batman|1|2011',
    'Batman 001 (2011-11)': 'Batman|1|2011', 'Wizard 0.5 (1996)': 'Wizard|1/2|1996',
    'Cosmic Boy 002(1987)(Digital)(TLK-EMPIRE-HD)': 'Cosmic Boy|2|1987',
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(hint(name), expected, name);
  for (const name of ['Batman 001-002 (2011)', 'Batman 001 (2011) (Other title)']) assert.equal(hint(name), null, name);
});

test('a scraper Volume year one off from Comic Vine is overruled by the filename year', () => {
  const { candidateMatches } = require('./candidate');
  const xml = '<ComicInfo><Series>Morbius</Series><Number>3</Number><Volume>2019</Volume><Notes>Scraped metadata from Comixology [CMXDB815218]</Notes></ComicInfo>';
  const volume = { id: 122817, name: 'Morbius', start_year: '2020' }, issue = { id: 1, issue_number: '3', cover_date: '2020-03-01', store_date: '2020-01-08', volume: { id: 122817 } };
  assert.equal(candidateMatches({ filename: 'Morbius 003 (2020).cbz', comicInfoXml: xml, folderName: 'Morbius (2019)', issue, volume }), true);
  assert.equal(candidateMatches({ filename: 'Morbius 003 (2021).cbz', comicInfoXml: xml, folderName: 'Morbius (2019)', issue, volume }), false);
  assert.equal(candidateMatches({ filename: 'Morbius 003 (2020).cbz', comicInfoXml: xml.replace('</Notes>', ' CVDB9</Notes>'), folderName: 'Morbius (2019)', issue, volume }), false);
});
