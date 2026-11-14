'use strict';
const { createHash } = require('node:crypto');
const { parseComicInfoEvidence, parseCvIssueId, eachNotesId, notesIds } = require('./evidence');
const { FIELDS, POLICY_VERSION } = require('./merge');
const { locateElements } = require('./xmlLayout');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const hash = text => createHash('sha256').update(text || '', 'utf8').digest('hex');
function escapeText(text) {
  // XML 1.0 characters, including supplementary planes but not lone surrogates.
  for (const char of text) {
    const n = char.codePointAt(0);
    if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff))) {
      fail('INVALID_PATCH_TEXT', 'Patch contains a character unsupported by XML 1.0');
    }
  }
  // Preserve carriage returns through XML newline normalization.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

// Consumes a trusted dry-run plan. It does not approve identity corrections,
// allocate IDs, write archives, rename files or persist proposed provenance.
function applyComicInfoPlan({ bookId, cvIssueId, currentXml, plan, initializeIdentity = false } = {}) {
  if (!bookId || plan?.bookId !== bookId || !parseCvIssueId(cvIssueId) || plan.cvIssueId !== parseCvIssueId(cvIssueId)) fail('PLAN_TARGET_MISMATCH', 'Plan must target this physical book and publication');
  if (plan.policyVersion !== POLICY_VERSION || !['ready', 'unchanged'].includes(plan.status)
    || !Array.isArray(plan.review) || plan.review.length || !Array.isArray(plan.patches)
    || plan.changed !== (plan.patches.length > 0 || plan.identityCorrection === true) || (plan.status === 'ready') !== plan.changed) fail('PLAN_NOT_APPLICABLE', 'Only ready or unchanged merge plans can be applied');
  const evidence = parseComicInfoEvidence(currentXml);
  // Say why (2026-11-14): "cannot be safely edited" alone needed the file opened to find the cause.
  if (evidence.status === 'invalid' || ['invalid', 'conflict'].includes(evidence.identity.status)) fail('UNSUPPORTED_XML', evidence.identity.status === 'conflict'
    ? `Existing metadata names more than one Comic Vine issue (${evidence.identity.ids.join(', ')})`
    : `Existing metadata cannot be safely edited (${(evidence.diagnostics || []).join(', ') || 'unreadable'})`);
  if (plan.originalXml !== evidence.rawXml || plan.originalXmlHash !== hash(evidence.rawXml)) fail('STALE_XML', 'ComicInfo changed after planning');
  const correcting = plan.identityCorrection === true;
  if (!correcting && evidence.identity.ids.some(id => id !== plan.cvIssueId)) fail('IDENTITY_CORRECTION_REQUIRED', 'Identity corrections need their own reviewed plan');
  // The caller must decode archive bytes strictly as UTF-8. Do not relabel an
  // unsupported XML encoding while serializing a JS string back to UTF-8.
  const encoding = /^\uFEFF?<\?xml\b[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(evidence.rawXml || '');
  if (encoding && !/^utf-8$/i.test(encoding[2])) fail('UNSUPPORTED_ENCODING', 'Only UTF-8 ComicInfo editing is supported');
  const addIdentity=initializeIdentity===true&&!evidence.identity.ids.length;
  if (!plan.changed&&!addIdentity) return { xml: evidence.rawXml, changed: false, originalXmlHash: plan.originalXmlHash, xmlHash: plan.originalXmlHash };

  let xml = evidence.status === 'absent' ? '<ComicInfo></ComicInfo>' : evidence.rawXml;
  const { root, children } = locateElements(xml);
  const edits = [], additions = [], seen = new Set();
  // Extend an existing Web without removing its text, comments or CDATA, and
  // avoid introducing duplicate scalar elements into ComicInfo consumers.
  let identityWebAfter=null;
  if(addIdentity){
    const link=`https://comicvine.gamespot.com/issue/4000-${plan.cvIssueId}/`,web=children.find(n=>n.name.toLowerCase()==='web');
    if(!web)additions.push(`<Web>${link}</Web>`);
    else{
      identityWebAfter=[...(evidence.fields.web||[])];
      if(web.selfClosing){edits.push({start:web.openEnd-2,end:web.end,text:`>${link}</${web.name}>`});identityWebAfter[0]=link;}
      else{edits.push({start:web.closeStart,end:web.closeStart,text:'\n'+link});identityWebAfter[0]+='\n'+link;}
    }
  }
  // Explicit correction: point Web links and Notes CVDB/Issue ID references at
  // the chosen issue; everything else in those elements is kept as written.
  let correctedIdentity = null;
  if (correcting) {
    const link = `https://comicvine.gamespot.com/issue/4000-${plan.cvIssueId}/`;
    const swapWeb = value => value.replace(/https?:\/\/[^\s<>"']+/gi, token => {
      const id = parseCvIssueId(token.replace(/&amp;/g, '&'));
      return id && id !== plan.cvIssueId ? link : token;
    });
    // Only Comic Vine ids: another database's id on its own tagger line stays as written.
    const swapNotes = value => eachNotesId(value, (m, prefix, id) => (id === plan.cvIssueId ? m : prefix + plan.cvIssueId));
    correctedIdentity = { web: (evidence.fields.web || []).map(swapWeb), notes: (evidence.fields.notes || []).map(swapNotes) };
    for (const node of children) {
      const name = node.name.toLowerCase();
      if ((name !== 'web' && name !== 'notes') || node.selfClosing) continue;
      if (node.children || node.hasMarkup) fail('UNSUPPORTED_FIELD', 'Structured or annotated identity fields require review');
      const inner = xml.slice(node.openEnd, node.closeStart), next = name === 'web' ? swapWeb(inner) : swapNotes(inner);
      if (next !== inner) edits.push({ start: node.openEnd, end: node.closeStart, text: next });
    }
    const has = v => parseComicInfoEvidence(`<ComicInfo><Web>${escapeText(v)}</Web></ComicInfo>`).identity.ids.includes(plan.cvIssueId)
      || notesIds(v).includes(plan.cvIssueId);
    if (![...correctedIdentity.web, ...correctedIdentity.notes].some(has)) {
      const web = children.find(n => n.name.toLowerCase() === 'web');
      if (!web) { additions.push(`<Web>${link}</Web>`); correctedIdentity.web = [link]; }
      else if (web.selfClosing) { edits.push({ start: web.openEnd - 2, end: web.end, text: `>${link}</${web.name}>` }); correctedIdentity.web = [link]; }
      else { edits.push({ start: web.closeStart, end: web.closeStart, text: '\n' + link }); correctedIdentity.web[0] += '\n' + link; }
    }
  }
  for (const patch of plan.patches) {
    if (!FIELDS.includes(patch.field) || seen.has(patch.field) || typeof patch.after !== 'string'
      || !(patch.before === null || typeof patch.before === 'string')) fail('INVALID_PATCH', 'Only unique supported scalar-field patches are allowed');
    seen.add(patch.field);
    const nodes = children.filter(n => n.name.toLowerCase() === patch.field.toLowerCase());
    const values = evidence.fields[patch.field.toLowerCase()] || [];
    if (nodes.length > 1 || values.length > 1 || nodes.some(n => n.children || n.hasMarkup)) fail('UNSUPPORTED_FIELD', 'Repeated, structured or annotated fields require review');
    const before = values.length ? values[0] : null;
    if (before !== patch.before) fail('STALE_FIELD', 'Patch before-value differs from the current field');
    const escaped = escapeText(patch.after);
    if (!nodes.length) additions.push(`<${patch.field}>${escaped}</${patch.field}>`);
    else if (nodes[0].selfClosing) {
      const node = nodes[0];
      edits.push({ start: node.openEnd - 2, end: node.end, text: `>${escaped}</${node.name}>` });
    } else {
      const node = nodes[0];
      edits.push({ start: node.openEnd, end: node.closeStart, text: escaped });
    }
  }
  if (additions.length) {
    if (root.selfClosing) edits.push({ start: root.openEnd - 2, end: root.end, text: '>' + additions.join('') + `</${root.name}>` });
    else edits.push({ start: root.closeStart, end: root.closeStart, text: additions.join('') });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
  const after = parseComicInfoEvidence(xml);
  if (after.status !== 'valid') fail('OUTPUT_XML_INVALID', 'Patched ComicInfo failed readback validation');
  for (const patch of plan.patches) {
    const values = after.fields[patch.field.toLowerCase()] || [];
    if (values.length !== 1 || values[0] !== patch.after) fail('OUTPUT_FIELD_MISMATCH', 'Patched scalar value failed readback validation');
  }
  // Ensure every unpatched scalar and all identity assertions still parse alike.
  for (const [field, values] of Object.entries(evidence.fields)) {
    if(correctedIdentity&&(field==='web'||field==='notes')){if(JSON.stringify(after.fields[field]||[])!==JSON.stringify(correctedIdentity[field]))fail('PRESERVATION_FAILED','Identity references were not corrected exactly');continue;}
    if(addIdentity&&field==='web'){if(JSON.stringify(after.fields.web)!==JSON.stringify(identityWebAfter))fail('PRESERVATION_FAILED','Existing web links changed');continue;}
    if (![...seen].some(name => name.toLowerCase() === field) && JSON.stringify(values) !== JSON.stringify(after.fields[field])) fail('PRESERVATION_FAILED', 'Unpatched metadata changed');
  }
  if(correctedIdentity){if(after.identity.status!=='supported'||after.identity.cvIssueId!==plan.cvIssueId)fail('PRESERVATION_FAILED','Corrected identity failed readback');}
  else if(addIdentity){if(after.identity.status!=='supported'||after.identity.cvIssueId!==plan.cvIssueId)fail('PRESERVATION_FAILED','Initial identity failed readback');}
  else if (JSON.stringify(evidence.identity) !== JSON.stringify(after.identity)) fail('PRESERVATION_FAILED', 'Identity evidence changed');
  return { xml, changed: xml !== evidence.rawXml, originalXmlHash: plan.originalXmlHash, xmlHash: hash(xml) };
}

module.exports = { applyComicInfoPlan };
