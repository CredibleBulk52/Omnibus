'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideIdentity } = require('./identity');
const { planMetadataMerge } = require('./merge');
const { applyComicInfoPlan } = require('./comicInfoPatch');
const { parseComicInfoEvidence } = require('./evidence');

const wrongXml = '<?xml version="1.0"?><ComicInfo><Series>Robin 3000</Series><Number>2</Number><Volume>1993</Volume><Title>Old title</Title>'
  + '<Writer>Old Writer</Writer><Year>1993</Year><Month>1</Month><LanguageISO>en</LanguageISO><Notes>Scraped metadata from ComicVine [CVDB557577].</Notes>'
  + '<Web>https://comicvine.gamespot.com/robin-3000-2/4000-557577/</Web><Pages><Page Image="0" Type="FrontCover"/></Pages><CustomTag>keep</CustomTag></ComicInfo>';
const source = { cvIssueId:'40000', fields:{ Series:'Robin 3000', Number:'2', Volume:'1992', Writer:'Elliot S! Maggin', Year:'1992', Month:'12' },
  date:{ basis:'cover_date', precision:'month', value:'1992-12' } };
const stale = { bookId:'sb_robin', cvIssueId:'557577', fields:{ Series:'Robin 3000', Writer:'Old Writer' } };

function planFor(explicitIssueId, extra = {}) {
  const decision = decideIdentity({ bookId:'sb_robin', arrival:'scanner', comicInfoXml:wrongXml, indexedIssueId:'557577', explicitIssueId });
  return planMetadataMerge({ bookId:'sb_robin', decision, currentXml:wrongXml, source, previous:stale, ...extra });
}

test('manual Tag with a different issue replaces the wrong identity', () => {
  const plan = planFor('40000');
  assert.equal(plan.status, 'ready'); assert.equal(plan.identityCorrection, true); assert.deepEqual(plan.review, []);
  const byField = Object.fromEntries(plan.patches.map(p => [p.field, p.after]));
  assert.equal(byField.Volume, '1992'); assert.equal(byField.Writer, 'Elliot S! Maggin'); assert.equal(byField.Title, ''); assert.equal(byField.Month, '12');
  assert.equal('LanguageISO' in byField, false, 'series/format fields kept when source is blank');
  const out = applyComicInfoPlan({ bookId:'sb_robin', cvIssueId:'40000', currentXml:wrongXml, plan });
  const after = parseComicInfoEvidence(out.xml);
  assert.equal(after.identity.status, 'supported'); assert.equal(after.identity.cvIssueId, '40000');
  assert.match(out.xml, /\[CVDB40000\]/); assert.match(out.xml, /4000-40000\//); assert.doesNotMatch(out.xml, /557577/);
  assert.match(out.xml, /<CustomTag>keep<\/CustomTag>/); assert.match(out.xml, /<Pages><Page Image="0" Type="FrontCover"\/><\/Pages>/);
  assert.match(out.xml, /<LanguageISO>en<\/LanguageISO>/);
});

test('automatic tagging still never changes an existing identity', () => {
  const decision = decideIdentity({ bookId:'sb_robin', arrival:'scanner', comicInfoXml:wrongXml, indexedIssueId:'557577' });
  assert.notEqual(decision.cvIssueId, '40000');
  const forced = { ...decision, status:'accepted', cvIssueId:'40000', reason:'supported_issue_identity' };
  const plan = planMetadataMerge({ bookId:'sb_robin', decision:forced, currentXml:wrongXml, source });
  assert.equal(plan.status, 'needs_review'); assert.equal(plan.identityCorrection, undefined);
});

test('manual Tag adds a Web link when the old identity was only in the library index', () => {
  const bare = '<ComicInfo><Series>Robin 3000</Series><Number>2</Number></ComicInfo>';
  const decision = decideIdentity({ bookId:'sb_robin', arrival:'scanner', comicInfoXml:bare, indexedIssueId:'557577', explicitIssueId:'40000' });
  const plan = planMetadataMerge({ bookId:'sb_robin', decision, currentXml:bare, source, previous:stale });
  assert.equal(plan.status, 'ready');
  const out = applyComicInfoPlan({ bookId:'sb_robin', cvIssueId:'40000', currentXml:bare, plan });
  assert.equal(parseComicInfoEvidence(out.xml).identity.cvIssueId, '40000');
});

test('manual Tag of the same issue ignores nothing and still refreshes normally', () => {
  const sameXml = wrongXml.replace(/557577/g, '40000');
  const decision = decideIdentity({ bookId:'sb_robin', arrival:'scanner', comicInfoXml:sameXml, indexedIssueId:'40000', explicitIssueId:'40000' });
  const plan = planMetadataMerge({ bookId:'sb_robin', decision, currentXml:sameXml, source, previous:{ ...stale, cvIssueId:'40000' } });
  assert.equal(plan.identityCorrection, undefined); assert.notEqual(plan.reason, 'identity_correction');
});

test('Comic Vine replaces a differing Series label from another source, manually or automatically', () => {
  const xml = '<ComicInfo><Series>Hellboy and the B.P.R.D.: 1957 --Family Ties</Series><Writer>Mike Mignola</Writer></ComicInfo>';
  const src = { cvIssueId:'884933', fields:{ Series:'Hellboy and the B.P.R.D.: Family Ties', Number:'1', Writer:'Someone Else' } };
  const manual = planMetadataMerge({ bookId:'sb_hb', currentXml:xml, source:src,
    decision:decideIdentity({ bookId:'sb_hb', arrival:'scanner', comicInfoXml:xml, explicitIssueId:'884933' }) });
  assert.equal(manual.status, 'ready');
  assert.equal(manual.patches.find(p => p.field === 'Series').after, 'Hellboy and the B.P.R.D.: Family Ties');
  assert.equal(manual.patches.find(p => p.field === 'Writer').after, 'Someone Else', 'Comic Vine is the metadata authority');
  const auto = planMetadataMerge({ bookId:'sb_hb', currentXml:xml, source:src,
    decision:{ ...decideIdentity({ bookId:'sb_hb', arrival:'scanner', comicInfoXml:xml }), status:'accepted', cvIssueId:'884933', reason:'corroborated_publication' } });
  assert.equal(auto.status, 'ready');
  assert.equal(auto.patches.find(p => p.field === 'Series').reason, 'comic_vine_authority');
});

test('filename and folder outweigh a non-Comic Vine series label for identification hints', () => {
  const { publicationHint } = require('./candidate');
  const xml = '<ComicInfo><Series>Hellboy and the B.P.R.D.: 1957 --Family Ties</Series></ComicInfo>';
  assert.equal(publicationHint('Hellboy and the B.P.R.D. Family Ties 1 (2021).cbz', xml, 'Hellboy and the B.P.R.D. Family Ties (2021)').name, 'Hellboy and the B.P.R.D. Family Ties');
  assert.equal(publicationHint('Hellboy and the B.P.R.D. Family Ties 1 (2021).cbz', xml, 'Hellboy (2021)'), null);
  assert.equal(publicationHint('Hellboy and the B.P.R.D. Family Ties 1 (2021).cbz', xml.replace('</Series>', '</Series><Notes>CVDB5</Notes>'), 'Hellboy and the B.P.R.D. Family Ties (2021)'), null);
});
