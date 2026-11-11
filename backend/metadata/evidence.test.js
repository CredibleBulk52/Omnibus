'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_XML_BYTES, parseCvIssueId, parseIssueNumberEvidence, parseComicInfoEvidence, filenameEvidence, collectMetadataEvidence } = require('./evidence');
const xml = body => `<?xml version="1.0"?><ComicInfo>${body}</ComicInfo>`;

test('CV identities preserve string precision and accept issue URLs on supported hosts', () => {
  for (const value of ['123', '000123', 123, 'https://comicvine.gamespot.com/title/4000-123/', 'http://www.comicvine.com/title/4000-123/', 'https://comicvine.gamespot.com/api/issue/4000-123/?format=json']) assert.equal(parseCvIssueId(value), '123');
  assert.equal(parseCvIssueId('9007199254740993123'), '9007199254740993123');
});
test('reject unrelated hosts, volume URLs, arbitrary trailing numbers and unsafe numeric IDs', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, '', '0', 'https://example.com/4000-123/', 'https://comicvine.gamespot.com.evil.test/4000-123/', 'https://comicvine.gamespot.com/volume/4050-123/', 'https://comicvine.gamespot.com/123/', 'https://comicvine.gamespot.com@evil.test/4000-123/', 'https://user@comicvine.gamespot.com/4000-123/', 'https://comicvine.gamespot.com/4000-123-extra/', 'javascript:4000-123']) assert.equal(parseCvIssueId(value), null, String(value));
});
test('Web, Issue ID and CVDB all supply consistent evidence without requiring Series', () => {
  const result = parseComicInfoEvidence(xml('<Web>https://comicvine.gamespot.com/a/4000-123/</Web><Notes>[Issue ID 123] CVDB123</Notes>'));
  assert.equal(result.identity.status, 'supported');
  assert.equal(result.identity.cvIssueId, '123');
  assert.equal(result.identity.evidence.length, 3);
});
test('conflicting embedded identities request resolution rather than Web taking precedence', () => {
  const result = parseComicInfoEvidence(xml('<Web>https://comicvine.gamespot.com/a/4000-123/</Web><Notes>CVDB456</Notes>'));
  assert.equal(result.identity.status, 'conflict');
  assert.equal(result.identity.cvIssueId, null);
  assert.deepEqual(result.identity.ids, ['123', '456']);
});
test('repeated fields and multiple URLs cannot hide conflicting identities', () => {
  for (const body of ['<Notes>CVDB123</Notes><Notes>CVDB456</Notes>', '<Web>https://comicvine.com/a/4000-123/ https://comicvine.com/b/4000-456/</Web>']) assert.equal(parseComicInfoEvidence(xml(body)).identity.status, 'conflict');
});
test('XML entities, CDATA, case variants and field attributes are parsed', () => {
  const result = parseComicInfoEvidence('<comicinfo xmlns="urn:comicinfo"><Series>A &amp; B</Series><WEB source="legacy"><![CDATA[https://comicvine.com/a/4000-123/]]></WEB><notes>CVDB&#49;23</notes></comicinfo>');
  assert.equal(result.fields.series[0], 'A & B');
  assert.equal(result.identity.cvIssueId, '123');
});
test('raw XML, unknown fields and page annotations remain untouched', () => {
  const source = xml('<Series>A</Series><Custom>preserve me</Custom><Pages><Page Image="0" Type="FrontCover" Bookmark="Start"/></Pages>');
  const result = parseComicInfoEvidence(source);
  assert.equal(result.rawXml, source);
  assert.deepEqual(result.fields.custom, ['preserve me']);
  assert.equal(result.identity.status, 'none');
});
test('comments and nested fields cannot impersonate identity fields', () => {
  const result = parseComicInfoEvidence(xml('<!-- <Notes>CVDB123</Notes> --><Custom><Notes>CVDB456</Notes></Custom>'));
  assert.equal(result.identity.status, 'none');
  assert.equal(parseComicInfoEvidence(xml('<Web><Nested>https://comicvine.com/a/4000-123/</Nested></Web>')).identity.status, 'invalid');
});
test('missing and empty XML is distinct from malformed XML', () => {
  for (const value of [null, undefined, '', '  ']) assert.equal(parseComicInfoEvidence(value).status, 'absent');
  for (const value of ['<ComicInfo><Notes>CVDB123</ComicInfo>', '<ComicInfo>', '<Wrong><Notes>CVDB123</Notes></Wrong>', '<ComicInfo>&bogus;</ComicInfo>', 123]) {
    const result = parseComicInfoEvidence(value);
    assert.equal(result.status, 'invalid', String(value));
    assert.equal(result.identity.cvIssueId, null);
  }
});
test('trailing malformed XML and multiple roots are rejected', () => {
  for (const value of [xml('<Notes>CVDB123</Notes>') + '<ComicInfo><Notes>CVDB456</Notes></ComicInfo>', xml('<Notes>CVDB123</Notes>') + '<Broken>', xml('<Notes>CVDB123</Notes>') + 'garbage']) assert.equal(parseComicInfoEvidence(value).status, 'invalid', value);
});
test('declarations and excessive XML are rejected without resolving entities', () => {
  assert.equal(parseComicInfoEvidence('<!DOCTYPE ComicInfo [<!ENTITY ext SYSTEM "file:///secret">]><ComicInfo><Notes>&ext;</Notes></ComicInfo>').status, 'invalid');
  assert.equal(parseComicInfoEvidence(xml('x'.repeat(MAX_XML_BYTES))).status, 'invalid');
});
test('empty ComicInfo and blank scalar fields are valid without invented identities', () => {
  assert.equal(parseComicInfoEvidence('<ComicInfo/>').status, 'valid');
  const result = parseComicInfoEvidence(xml('<Writer/><Number>0</Number><Notes>CVDB0</Notes>'));
  assert.deepEqual(result.fields.writer, ['']);
  assert.deepEqual(result.fields.number, ['0']);
  assert.equal(result.identity.status, 'none');
});
test('issue evidence supports zero, negatives, decimals, fractions and allowed suffixes', () => {
  for (const [raw, expected] of [['000','0'],['-001','-1'],['008.10','8.10'],['008AU','8.AU'],['001.NOW','1.NOW'],['1/2','1/2'],['½','1/2']]) {
    const result = parseIssueNumberEvidence(raw);
    assert.equal(result.normalized, expected);
    assert.equal(result.raw, raw);
    assert.equal(result.requiresReview, false);
  }
});
test('lettered inserts and unknown suffixes cannot collapse to a different publication number', () => {
  for (const raw of ['443b', '013a', '1ST', '8.NEW', '1e3', '1 extra']) {
    const result = parseIssueNumberEvidence(raw);
    assert.equal(result.raw, raw);
    assert.equal(result.normalized, null);
    assert.equal(result.requiresReview, true);
  }
});
test('filename evidence preserves reading-order suffixes and multiple numbers', () => {
  const result = filenameEvidence('The Amazing Spider-Man #443b (The Mighty Thor #8).cbz');
  assert.equal(result.requiresReview, true);
  assert.ok(result.candidates.some(c => c.raw === '443b' && c.normalized === null));
  assert.ok(result.candidates.some(c => c.raw === '8'));
});
test('filename evidence avoids treating volume numbers and standalone years as issue numbers', () => {
  for (const name of ['Batman v1.cbz', 'Batman Vol 2.cbz', 'Batman 1989 Special.cbz']) assert.deepEqual(filenameEvidence(name).candidates, []);
});
test('filename evidence handles annuals, Windows paths, decimals and allowed suffixes', () => {
  for (const [name, expected] of [['C:\\Comics\\Nightwing 2025 Annual 001.cbz','1'],['/comics/Spider-Man 008.1 (2026).cbz','8.1'],['Hulk 008AU (2013).cbz','8.AU']]) assert.equal(filenameEvidence(name).candidates[0].normalized, expected);
});
test('all three arrival paths expose the same embedded evidence, keeping folder hints separate', () => {
  for (const arrival of ['download', 'import', 'scanner']) {
    const folderMetadata = { metadata: { comicid: '999', name: 'Parent folder' } };
    const result = collectMetadataEvidence({ bookId:'sb_stable', arrival, filename:'Insert 001.cbz', comicInfoXml:xml('<Notes>CVDB123</Notes>'), folderMetadata });
    assert.equal(result.embedded.identity.cvIssueId, '123');
    assert.deepEqual(result.identities, []);
    result.folderHint.metadata.comicid = 'changed';
    assert.equal(folderMetadata.metadata.comicid, '999');
  }
});
test('explicit, download and indexed identities remain attributed assertions for the next decision stage', () => {
  const result = collectMetadataEvidence({ bookId:'sb_stable', arrival:'download', explicitIssueId:'123', downloadIssueId:'456', indexedIssueId:'789' });
  assert.deepEqual(result.identities.map(i=>[i.source,i.cvIssueId]), [['download','456'],['explicit','123'],['library_index','789']]);
  assert.equal(result.bookId, 'sb_stable');
});
test('invalid explicit IDs are reported, never silently promoted to another identity', () => {
  const result = collectMetadataEvidence({ bookId:'sb_stable', arrival:'scanner', explicitIssueId:'https://example.com/123', downloadIssueId:'456' });
  assert.deepEqual(result.diagnostics, ['invalid_explicit_identity']);
  assert.deepEqual(result.identities, [{source:'download',cvIssueId:'456'}]);
  assert.throws(()=>collectMetadataEvidence({arrival:'scanner'}), /stable book ID/);
  assert.throws(()=>collectMetadataEvidence({bookId:'sb_stable',arrival:'unknown'}), /arrival/);
});
