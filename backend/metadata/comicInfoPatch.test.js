'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { planMetadataMerge, FIELDS } = require('./merge');
const { parseComicInfoEvidence } = require('./evidence');
const { applyComicInfoPlan } = require('./comicInfoPatch');

const target = { bookId: 'physical-copy-a', cvIssueId: '123' };
const code = expected => error => error.code === expected;
function plan(xml, fields = { Writer: 'New Writer' }, overrides = null) {
  return planMetadataMerge({ bookId: target.bookId, decision: { ...target, status: 'accepted' }, currentXml: xml,
    source: { cvIssueId: target.cvIssueId, fields }, overrides: overrides && { ...target, fields: overrides } });
}
function apply(xml, fields, overrides) {
  return applyComicInfoPlan({ ...target, currentXml: xml, plan: plan(xml, fields, overrides) });
}

test('adding a missing scalar preserves comments, namespaces, attributes, unknown XML and Pages exactly', () => {
  const xml = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n<!--before--><ComicInfo xmlns:x="urn:extra" custom="yes">\r\n'
    + '<Title lang="en"><![CDATA[Original <Title>]]></Title>\r\n'
    + '<Web>https://comicvine.gamespot.com/issue/4000-123/</Web>\r\n'
    + '<x:Extra z="2" a="1"><x:Writer>not a creator</x:Writer></x:Extra>\r\n'
    + '<Pages><Page Image="0" Type="FrontCover" Bookmark="Start"/><Page Image="12" DoublePage="True"/></Pages>\r\n'
    + '<!-- <Writer>not real</Writer> --><?custom keep="yes"?></ComicInfo><!--after-->';
  const result = apply(xml);
  assert.equal(result.xml, xml.replace('</ComicInfo>', '<Writer>New Writer</Writer></ComicInfo>'));
  assert.equal(result.changed, true);
  assert.equal(result.xmlHash, createHash('sha256').update(result.xml).digest('hex'));
  assert.ok(Buffer.from(result.xml).includes(Buffer.from('<Pages><Page Image="0" Type="FrontCover" Bookmark="Start"/><Page Image="12" DoublePage="True"/></Pages>')));
});
test('replacement edits only scalar content, preserving original tag spelling and attributed opening tag', () => {
  const xml = '<ComicInfo>\n<tItLe xml:lang="en" note="a > b">Old &amp; good</tItLe><Unknown keep="yes"/>\n</ComicInfo>';
  const result = apply(xml, {}, { Title: 'New <title> & "value"' });
  assert.equal(result.xml, xml.replace('Old &amp; good', 'New &lt;title&gt; &amp; "value"'));
});
test('CDATA inside an approved scalar becomes escaped text without changing adjacent CDATA', () => {
  const xml = '<ComicInfo><Title><![CDATA[Old <thing>]]></Title><Extra><![CDATA[leave <this> & alone]]></Extra></ComicInfo>';
  assert.equal(apply(xml, {}, { Title: 'New ]]> text' }).xml, '<ComicInfo><Title>New ]]&gt; text</Title><Extra><![CDATA[leave <this> & alone]]></Extra></ComicInfo>');
});
test('self-closing scalar retains attributes and expands in place', () => {
  const xml = '<ComicInfo><Writer source="manual" /></ComicInfo>';
  assert.equal(apply(xml).xml, '<ComicInfo><Writer source="manual" >New Writer</Writer></ComicInfo>');
});
test('self-closing root retains default namespace and all attributes', () => {
  const xml = '<?xml version="1.0"?><comicinfo xmlns="urn:comic" x="1" />';
  assert.equal(apply(xml).xml, '<?xml version="1.0"?><comicinfo xmlns="urn:comic" x="1" ><Writer>New Writer</Writer></comicinfo>');
});
test('multiple replacements and additions use original offsets without modifying nested lookalikes', () => {
  const xml = '<ComicInfo><Title>Old</Title><Summary>Before</Summary><Extension><Writer>Nested</Writer></Extension></ComicInfo>';
  const result = apply(xml, { Locations: 'Gotham' }, { Title: 'T', Summary: 'Longer & better summary' });
  assert.equal(result.xml, '<ComicInfo><Title>T</Title><Summary>Longer &amp; better summary</Summary><Extension><Writer>Nested</Writer></Extension><Locations>Gotham</Locations></ComicInfo>');
});
test('intentional blank override clears only the approved field', () => {
  const xml = '<ComicInfo><Title>Old</Title><Pages><Page Image="0" Bookmark="Keep"/></Pages></ComicInfo>';
  assert.equal(apply(xml, {}, { Title: '' }).xml, xml.replace('Old', ''));
});
test('source-managed fields update using the actual merge plan', () => {
  const xml = '<ComicInfo><Writer>Old Writer</Writer></ComicInfo>';
  const planned = planMetadataMerge({ bookId: target.bookId, decision: { ...target, status: 'accepted' }, currentXml: xml,
    source: { cvIssueId: '123', fields: { Writer: 'New Writer' } }, previous: { ...target, fields: { Writer: 'Old Writer' } } });
  const result = applyComicInfoPlan({ ...target, currentXml: xml, plan: planned });
  assert.equal(result.xml, xml.replace('Old Writer', 'New Writer'));
  assert.deepEqual(planned.managedFieldsAfterApply, { Writer: 'New Writer' });
});
test('Comic Vine replaces an imported value Omnibus never wrote, alongside a filled gap', () => {
  const xml = '<ComicInfo><Summary>Rich imported description</Summary></ComicInfo>';
  const planned = plan(xml, { Summary: 'Different', Writer: 'Credit' });
  assert.equal(planned.observations.length, 0);
  assert.equal(planned.patches.find(p => p.field === 'Summary').reason, 'comic_vine_authority');
  assert.equal(applyComicInfoPlan({ ...target, currentXml: xml, plan: planned }).xml, '<ComicInfo><Summary>Different</Summary><Writer>Credit</Writer></ComicInfo>');
});

for (const xml of [null, '', ' \r\n\t']) {
  test(`absent XML ${JSON.stringify(xml)} gets a minimal root only when there are approved patches`, () => {
    assert.equal(apply(xml).xml, '<ComicInfo><Writer>New Writer</Writer></ComicInfo>');
    assert.equal(apply(xml, {}).xml, xml);
    assert.equal(apply(xml, {}).changed, false);
  });
}
test('unchanged XML returns identical UTF-8 bytes including BOM, CRLF and CDATA', () => {
  const xml = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<ComicInfo><Title><![CDATA[Å title]]></Title></ComicInfo>\r\n';
  const result = apply(xml, { Title: 'Å title' });
  assert.deepEqual(Buffer.from(result.xml), Buffer.from(xml));
  assert.equal(result.changed, false); assert.equal(result.xmlHash, result.originalXmlHash);
});
test('same-length external edit invalidates the original XML hash/plan', () => {
  const xml = '<ComicInfo><Title>Old</Title></ComicInfo>';
  assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml.replace('Old', 'New'), plan: plan(xml) }), code('STALE_XML'));
});
test('a plan for another physical copy or publication cannot apply', () => {
  const xml = '<ComicInfo/>'; const planned = plan(xml);
  for (const change of [{ bookId: 'copy-b' }, { cvIssueId: '456' }]) assert.throws(() => applyComicInfoPlan({ ...target, ...change, currentXml: xml, plan: planned }), code('PLAN_TARGET_MISMATCH'));
});
test('identity correction review cannot be bypassed by independent safe additions', () => {
  // A differing Number from another source is now replaced by Comic Vine; a
  // file naming another Comic Vine issue still requires review.
  const replaced = plan('<ComicInfo><Number>1035.1</Number></ComicInfo>', { Number: '1', Writer: 'Credit' });
  assert.equal(replaced.status, 'ready'); assert.equal(replaced.patches.find(p => p.field === 'Number').after, '1');
  for (const xml of ['<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-456/</Web></ComicInfo>']) {
    const planned = plan(xml, { Number: '1', Writer: 'Credit' });
    assert.equal(planned.status, 'needs_review');
    assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: planned }), code('PLAN_NOT_APPLICABLE'));
  }
});
test('blocked and inconsistent plan envelopes are refused', () => {
  const xml = '<ComicInfo/>'; const planned = plan(xml);
  for (const change of [{ status: 'blocked' }, { changed: false }, { status: 'unchanged' }, { policyVersion: 'old' }, { review: [{ reason: 'pending' }] }, { patches: null }]) {
    assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: { ...planned, ...change } }), code('PLAN_NOT_APPLICABLE'));
  }
});
test('repeated and structured fields require review in the merge layer', () => {
  for (const xml of ['<ComicInfo><Writer>A</Writer><writer>B</writer></ComicInfo>', '<ComicInfo><Writer><Name>A</Name></Writer></ComicInfo>', '<ComicInfo><Writer>A</Writer><Writer><Name>B</Name></Writer></ComicInfo>']) {
    assert.throws(() => apply(xml), code('PLAN_NOT_APPLICABLE'));
  }
});
for (const inner of ['Old<!-- keep annotation -->', 'Old<?note keep="yes"?>']) {
  test(`annotated scalar is held rather than discarding ${inner}`, () => {
    const xml = `<ComicInfo><Title>${inner}</Title></ComicInfo>`;
    assert.throws(() => apply(xml, {}, { Title: 'Replacement' }), code('UNSUPPORTED_FIELD'));
  });
}
test('comments and processing instructions outside a changed scalar remain intact', () => {
  const xml = '<ComicInfo><!--root--><?note retain?><Title>Old</Title><!--end--></ComicInfo>';
  assert.equal(apply(xml, {}, { Title: 'New' }).xml, xml.replace('Old', 'New'));
});
test('nested and namespaced title lookalikes do not receive scalar patches', () => {
  const xml = '<ComicInfo xmlns:x="urn:extra"><x:Title>External</x:Title><Extra><Title>Nested</Title></Extra></ComicInfo>';
  assert.equal(apply(xml, { Title: 'Actual title' }).xml, xml.replace('</ComicInfo>', '<Title>Actual title</Title></ComicInfo>'));
});
test('identity markers, Notes, Pages and arbitrary fields cannot be smuggled into a scalar plan', () => {
  const xml = '<ComicInfo/>'; const planned = plan(xml);
  for (const field of ['Web', 'Notes', 'Pages', 'file_path', 'Unknown']) {
    assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: { ...planned, patches: [{ field, before: null, after: 'bad' }] } }), code('INVALID_PATCH'));
  }
});
test('duplicate patches, changed before-value and non-string values are rejected', () => {
  const xml = '<ComicInfo/>'; const planned = plan(xml);
  for (const patches of [[...planned.patches, ...planned.patches], [{ field: 'Writer', before: null, after: {} }]]) {
    assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: { ...planned, patches } }), code('INVALID_PATCH'));
  }
  assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: { ...planned, patches: [{ field: 'Writer', before: 'wrong', after: 'Credit' }] } }), code('STALE_FIELD'));
});
test('Unicode, markup characters, literal entities and carriage returns round-trip as literal scalar values', () => {
  for (const value of ['Å Ω 漫画 😀', '<script>&foo; " \' ]]> ', 'one\rtwo\nthree\tfour']) {
    const result = apply('<ComicInfo/>', { Writer: value });
    assert.equal(parseComicInfoEvidence(result.xml).fields.writer[0], value.trim());
  }
});
test('invalid XML characters cannot enter a patch', () => {
  for (const value of ['A\0B', 'A\u0001B', 'A\uD800B', 'A\uDC00B', 'A\uFFFEB']) {
    assert.throws(() => apply('<ComicInfo/>', { Writer: value }), code('INVALID_PATCH_TEXT'));
  }
});
test('output exceeding the XML size cap is refused', () => {
  assert.throws(() => apply('<ComicInfo/>', { Writer: 'a'.repeat(2 * 1024 * 1024) }), code('OUTPUT_XML_INVALID'));
});
test('unsupported declared byte encodings are held without silently relabeling them', () => {
  for (const encoding of ['UTF-16', 'ISO-8859-1']) {
    const xml = `<?xml version="1.0" encoding="${encoding}"?><ComicInfo/>`;
    assert.throws(() => apply(xml), code('UNSUPPORTED_ENCODING'));
  }
});
test('matching patched content produces an unchanged next merge, without adopting unrelated fields', () => {
  const xml = '<ComicInfo><Summary>Imported</Summary></ComicInfo>';
  const result = apply(xml);
  assert.equal(plan(result.xml).status, 'unchanged');
  assert.deepEqual(plan(result.xml).managedFieldsAfterApply, {});
});
test('the source XML, patches and proposed ownership remain unmodified', () => {
  const xml = '<ComicInfo><Summary>Imported</Summary></ComicInfo>';
  const planned = plan(xml); const before = JSON.stringify(planned);
  applyComicInfoPlan({ ...target, currentXml: xml, plan: planned });
  assert.equal(JSON.stringify(planned), before);
});
test('all allowed scalar fields can be serialized without losing unknown or page metadata', () => {
  const fields = Object.fromEntries(FIELDS.map(field => [field, `${field} & value`]));
  Object.assign(fields, { Year: '2026', Month: '10', Day: '', Volume: '2026', Number: '1', Count: '12' });
  const xml = '<ComicInfo><Extra><Anything a="1"/></Extra><Pages><Page Image="0"/></Pages></ComicInfo>';
  const result = apply(xml, {}, fields), parsed = parseComicInfoEvidence(result.xml);
  for (const [field, value] of Object.entries(fields)) if (value) assert.equal(parsed.fields[field.toLowerCase()][0], value);
  assert.ok(result.xml.startsWith(xml.replace('</ComicInfo>', '')));
});
test('coherent cover dates fill Year and Month without inventing Day', () => {
  const xml = '<ComicInfo><Pages><Page Image="0" Bookmark="Keep"/></Pages></ComicInfo>';
  const planned = planMetadataMerge({ bookId: target.bookId, decision: { ...target, status: 'accepted' }, currentXml: xml,
    source: { cvIssueId: '123', fields: { Year: '2026', Month: '10' }, date: { basis: 'cover_date', precision: 'month', value: '2026-10' } } });
  const result = applyComicInfoPlan({ ...target, currentXml: xml, plan: planned });
  assert.equal(result.xml, xml.replace('</ComicInfo>', '<Year>2026</Year><Month>10</Month></ComicInfo>'));
});
test('patching across supplementary Unicode preserves exact offsets and existing entities', () => {
  const xml = '<ComicInfo><Extra>😀 &amp; Ω</Extra><Title>Old</Title><Summary>Before 😀</Summary></ComicInfo>';
  const result = apply(xml, {}, { Title: 'New 😀', Summary: 'After Ω' });
  assert.equal(result.xml, xml.replace('Old', 'New 😀').replace('Before 😀', 'After Ω'));
});
test('markup-looking CDATA outside the target cannot invent direct fields', () => {
  const xml = '<ComicInfo><Extra><![CDATA[<Writer>Wrong</Writer>]]></Extra></ComicInfo>';
  assert.equal(apply(xml).xml, xml.replace('</ComicInfo>', '<Writer>New Writer</Writer></ComicInfo>'));
});
test('entity-expanded before values are checked without normalizing unpatched entities', () => {
  const xml = '<ComicInfo><Title>O&#108;d</Title><Extra>&#65;&amp;&#x42;</Extra></ComicInfo>';
  assert.equal(apply(xml, {}, { Title: 'New' }).xml, xml.replace('O&#108;d', 'New'));
});
test('review status cannot be forged into authorization for an existing conflicting identity', () => {
  const xml = '<ComicInfo><Web>https://comicvine.gamespot.com/issue/4000-456/</Web></ComicInfo>';
  const planned = { ...plan(xml), status: 'ready', changed: true, review: [], patches: [{ field: 'Writer', before: null, after: 'Credit' }] };
  assert.throws(() => applyComicInfoPlan({ ...target, currentXml: xml, plan: planned }), code('IDENTITY_CORRECTION_REQUIRED'));
});
