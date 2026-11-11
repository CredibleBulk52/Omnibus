'use strict';
const { createHash } = require('node:crypto');
const { parseComicInfoEvidence, parseCvIssueId } = require('./evidence');
const { locateElements } = require('./xmlLayout');
const POLICY_VERSION = 'merge-v2';
// Identity links, Notes, Pages and unknown extension elements require their own preservation path.
const FIELDS = Object.freeze(['Series','Number','Volume','Title','Year','Month','Day','Publisher','Imprint','Format','Summary','Writer','Penciller','Inker','Colorist','Letterer','CoverArtist','Editor','Characters','Teams','Locations','Genre','LanguageISO','AgeRating','Count','Manga']);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = value => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError('Metadata values must be strings, finite numbers, or null');
};
// Padding of numeric date/count fields is presentation, not a metadata change.
// Number remains a publication identifier: do not erase decimal spelling or suffixes.
function equivalent(field, left, right) {
  const normalize = value => {
    const v = text(value);
    if (['Year','Month','Day','Volume','Count'].includes(field) && /^\d+$/.test(v)) return v.replace(/^0+(?=\d)/, '');
    // "020" and "20" are the same issue number; padding alone is not a change.
    if (field === 'Number' && /^-?\d+(?:\.\d+)?$/.test(v)) return v.replace(/^(-?)0+(?=\d)/, '$1');
    // Keep word boundaries, punctuation, case and list order meaningful.
    if (['Writer','Penciller','Inker','Colorist','Letterer','CoverArtist','Editor','Characters','Teams','Locations','Genre'].includes(field)) return v.split(',').map(x=>x.trim().replace(/\s+/g,' ')).join(', ');
    return field === 'Summary' ? v.replace(/\s+/g,' ') : v;
  };
  return normalize(left) === normalize(right);
}
function validateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('A fields object is required');
  for (const [field, value] of Object.entries(fields)) {
    if (!FIELDS.includes(field)) throw new TypeError(`Unsupported merge field: ${field}`);
    text(value);
  }
}
function validDateRecord(date, fields) {
  if (!date || !['cover_date','store_date'].includes(date.basis)) return false;
  const monthPrecision=date.basis==='cover_date';
  if(date.precision !== (monthPrecision?'month':'day') || typeof date.value!=='string'
    || !(monthPrecision?/^\d{4}-\d{2}$/:/^\d{4}-\d{2}-\d{2}$/).test(date.value)) return false;
  const full=monthPrecision?date.value+'-01':date.value;
  const parsed=new Date(full+'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===full
    && ['Year','Month','Day'].every((f,i)=>equivalent(f,fields[f],date.value.split('-')[i]));
}

// Explicit correction: the chosen issue's values replace the Comic Vine fields.
// Issue-specific fields the new issue lacks are cleared (they described the old
// issue); series-level and format fields are kept when the source is blank.
// Unknown XML, pages and other elements are untouched; the patcher rewrites the
// Web/Notes identity references.
const ISSUE_FIELDS = new Set(['Title','Summary','Writer','Penciller','Inker','Colorist','Letterer','CoverArtist','Editor','Characters','Teams','Locations','Year','Month','Day']);
function planExplicitCorrection(result, current, source, directElements) {
  result.identityCorrection = true;
  const dates = ['Year','Month','Day'];
  const sourceDateValid = validDateRecord(source.date, source.fields);
  for (const field of FIELDS) {
    const values = current.fields[field.toLowerCase()] || [];
    const before = values.length ? values[0] : null;
    let incoming = owns(source.fields, field) ? text(source.fields[field]) : '';
    if (dates.includes(field) && !sourceDateValid) incoming = '';
    if (!incoming && !(ISSUE_FIELDS.has(field) && text(before))) {
      if (text(before)) result.retained.push({ field, reason: 'source_blank' });
      continue;
    }
    const nodes = directElements.filter(node => node.name.toLowerCase() === field.toLowerCase());
    if (values.length > 1 || nodes.length > 1 || nodes.some(node => node.children > 0 || node.hasMarkup)) {
      result.review.push({ field, reason: 'non_scalar_or_repeated_field', proposed: incoming });
      continue;
    }
    if (incoming) result.managedFieldsAfterApply[field] = incoming;
    if (equivalent(field, before, incoming)) { result.retained.push({ field, reason: 'unchanged' }); continue; }
    result.patches.push({ field, before, after: incoming, reason: incoming ? 'identity_correction' : 'identity_correction_cleared' });
  }
  if (sourceDateValid) result.managedDateAfterApply = { ...source.date };
  // The identity itself changes even when every field already matches.
  result.changed = true;
  result.status = result.review.length ? 'needs_review' : 'ready';
  result.reason = result.review.length ? 'field_review_required' : 'identity_correction';
  return result;
}

// A dry-run patch plan, never an XML serializer or authorization to write an archive.
function planMetadataMerge({ bookId, decision, currentXml, source, previous = null, overrides = null } = {}) {
  if (!bookId || decision?.bookId !== bookId) throw new TypeError('Decision must belong to the stable book ID');
  const current = parseComicInfoEvidence(currentXml);
  const result = { bookId, policyVersion: POLICY_VERSION, status: 'blocked', reason: null,
    originalXml: current.rawXml, originalXmlHash: createHash('sha256').update(current.rawXml || '').digest('hex'),
    cvIssueId: decision.cvIssueId || null, changed: false, patches: [], review: [], observations: [], retained: [], managedFieldsAfterApply: {}, managedDateAfterApply: null };
  const blocked = reason => ({ ...result, reason });
  if (decision.status !== 'accepted' || !parseCvIssueId(decision.cvIssueId)) return blocked('identity_not_accepted');
  if (current.status === 'invalid' || current.identity.status === 'invalid' || decision.metadataReviewRequired) return blocked('existing_metadata_unreadable');
  if (!source || parseCvIssueId(source.cvIssueId) !== decision.cvIssueId) return blocked('source_identity_mismatch');
  validateFields(source.fields);
  // A manual Tag (explicit issue) is the user's correction. Field records saved
  // for a different issue describe the old identity and no longer apply.
  const explicit = decision.reason === 'explicit_correction';
  if (explicit) {
    if (previous && parseCvIssueId(previous.cvIssueId) !== decision.cvIssueId) previous = null;
    if (overrides && parseCvIssueId(overrides.cvIssueId) !== decision.cvIssueId) overrides = null;
  }
  for (const record of [previous, overrides]) {
    if (record == null) continue;
    if (record.bookId !== bookId) return blocked('field_record_book_mismatch');
    if (parseCvIssueId(record.cvIssueId) !== decision.cvIssueId) return blocked('field_record_identity_mismatch');
    validateFields(record.fields);
  }
  const correction = current.identity.ids.some(id => id !== decision.cvIssueId) || (decision.provenance?.superseded || []).length > 0;
  const directElements = current.status === 'valid' ? locateElements(current.rawXml).children : [];
  if (correction && explicit) return planExplicitCorrection(result, current, source, directElements);
  if (correction) result.review.push({ field: null, reason: 'identity_correction_requires_field_review' });
  for (const field of FIELDS) {
    const values = current.fields[field.toLowerCase()] || [];
    const hasOverride = !!overrides && owns(overrides.fields, field);
    const hasSource = owns(source.fields, field);
    const hasPrevious = !!previous && owns(previous.fields, field);
    if (!hasOverride && !hasSource && !hasPrevious && !(correction && values.length)) continue;
    const incoming = hasOverride ? text(overrides.fields[field]) : hasSource ? text(source.fields[field]) : '';
    // Existing structured/repeated fields must not be overwritten as if they were missing.
    const fieldElements = directElements.filter(node => node.name.toLowerCase() === field.toLowerCase());
    const structured = fieldElements.some(node => node.children > 0);
    if (values.length > 1 || fieldElements.length > 1 || structured) {
      result.review.push({ field, reason: 'non_scalar_or_repeated_field', proposed: incoming });
      continue;
    }
    const before = values.length ? values[0] : null;
    const comparable = text(before);
    const managed = hasPrevious && equivalent(field, before, previous.fields[field]);
    if (managed && !hasOverride && !correction) result.managedFieldsAfterApply[field] = previous.fields[field];
    if (correction) {
      if (hasOverride || incoming || comparable) result.review.push({ field, reason: 'identity_correction_field', before, proposed: hasOverride || incoming ? incoming : null, override: hasOverride });
      continue;
    }
    if (hasOverride) {
      // An empty override is intentional. Unlike a blank source it may clear an existing value.
      if (!equivalent(field, before, incoming)) result.patches.push({ field, before, after: incoming, reason: 'manual_override' });
      else result.retained.push({ field, reason: 'manual_override' });
      continue;
    }
    if (!incoming) {
      result.retained.push({ field, reason: 'source_blank' });
      continue;
    }
    if (equivalent(field, before, incoming)) {
      result.retained.push({ field, reason: 'unchanged' });
      // Equality alone is not proof that Omnibus owns an existing field.
      continue;
    }
    if ((!comparable && !hasPrevious) || managed) {
      result.patches.push({ field, before, after: incoming, reason: managed ? 'refresh_managed_field' : 'fill_missing_field' });
      result.managedFieldsAfterApply[field] = incoming;
    } else {
      const identityField = ['Series','Number','Volume','Format'].includes(field);
      // A manual Tag / Apply match names the publication: its Series/Number/
      // Volume/Format replace differing labels. Other existing values are kept.
      if (identityField && explicit) {
        result.patches.push({ field, before, after: incoming, reason: 'explicit_choice' });
        result.managedFieldsAfterApply[field] = incoming;
        continue;
      }
      // Comic Vine is the sole metadata provider: a value Omnibus never wrote
      // (another scraper's Series, Volume year, summary…) is replaced by Comic
      // Vine's. A value changed after Omnibus wrote it is still held for review.
      if (!hasPrevious) {
        result.patches.push({ field, before, after: incoming, reason: 'comic_vine_authority' });
        result.managedFieldsAfterApply[field] = incoming;
        continue;
      }
      const target = identityField ? result.review : result.observations;
      target.push({ field, before, proposed: incoming, reason: 'externally_changed_field' });
    }
  }
  // Dates are a group. Unknown partial dates never acquire components of another basis.
  const dates=['Year','Month','Day'];
  const existingDate=Object.fromEntries(dates.map(f=>[f,(current.fields[f.toLowerCase()]||[])[0] ?? null]));
  const dateOverrides=dates.filter(f=>overrides && owns(overrides.fields,f));
  const sourceDate=source.date;
  const sourceDateValid=validDateRecord(sourceDate,source.fields);
  const previousDateManaged=validDateRecord(previous?.date,previous?.fields)
    && dates.every(f=>equivalent(f,existingDate[f],previous.fields[f]));
  const groupManaged=sourceDateValid && previousDateManaged && previous.date.basis===sourceDate.basis && previous.date.precision===sourceDate.precision;
  const groupEmpty=dates.every(f=>!text(existingDate[f])) && !dates.some(f=>previous && owns(previous.fields,f));
  // Comic Vine's date replaces an existing date Omnibus never wrote, but only
  // as a whole: every existing component must be supplied by Comic Vine, so a
  // store-date Day never survives next to a cover-date Month. Dates Omnibus
  // wrote follow the ownership rules above.
  const neverOwned=!previous?.date && !dates.some(f=>previous && owns(previous.fields,f));
  const covered=dates.every(f=>!text(existingDate[f]) || (owns(source.fields,f) && !!text(source.fields[f])));
  const dateSafe=dateOverrides.length ? dateOverrides.length===3 : sourceDateValid && (groupEmpty || groupManaged || (neverOwned && covered));
  const datePatches=result.patches.filter(p=>dates.includes(p.field));
  if (datePatches.length && !dateSafe) {
    result.patches=result.patches.filter(p=>!dates.includes(p.field));
    result.observations.push({field:'Date',reason:'date_group_preserved',before:existingDate,proposed:sourceDate || null});
    if(dateOverrides.length) result.review.push({field:'Date',reason:'complete_date_override_required'});
    for(const f of dates) {
      delete result.managedFieldsAfterApply[f];
      if(previousDateManaged && !dateOverrides.length && owns(previous.fields,f)) result.managedFieldsAfterApply[f]=previous.fields[f];
    }
  }
  if(!correction && !dateOverrides.length) {
    if(previousDateManaged) result.managedDateAfterApply={...previous.date};
    if(groupManaged || (datePatches.length && dateSafe)) result.managedDateAfterApply={...sourceDate};
  }
  result.changed = result.patches.length > 0;
  result.status = result.review.length ? 'needs_review' : result.changed ? 'ready' : 'unchanged';
  result.reason = result.review.length ? 'field_review_required' : result.changed ? 'metadata_changes_proposed' : 'no_metadata_changes';
  return result;
}
module.exports = { POLICY_VERSION, FIELDS, planMetadataMerge };
