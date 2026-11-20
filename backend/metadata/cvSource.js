'use strict';
const { parseCvIssueId } = require('./evidence');
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value).trim() : '';
const id = value => /^\d+$/.test(scalar(value)) ? parseCvIssueId(value) : null;
function plainText(value) {
  return scalar(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:td|th)>\s*<(?:td|th)\b[^>]*>/gi, ' | ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/?(?:p|div|br|li|h[1-6]|table|tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
      const named = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' ' };
      if (named[entity.toLowerCase()] != null) return named[entity.toLowerCase()];
      const hex = /^&#x/i.test(entity); const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
    }).replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
// storeDate: a second source's store date for this issue ({ value, source }, e.g. Metron's), used
// only when Comic Vine has none (2026-11-19). It fills StoreDate and the publication date; it never
// supplies Year/Month/Day, which stay Comic Vine's cover date.
function adaptCvSource({ expectedIssueId, issue, volume = null, storeDate: otherStoreDate = null } = {}) {
  const expected = id(expectedIssueId);
  if (!expected || !issue || id(issue.id) !== expected) return { status:'blocked', reason:'source_issue_mismatch', source:null };
  const volumeId = id(issue.volume?.id);
  if (volume && (!volumeId || id(volume.id) !== volumeId)) return { status:'blocked', reason:'source_volume_mismatch', source:null };
  const fields = {};
  const set = (name, value) => { const v=scalar(value); if(v) fields[name]=v; };
  set('Number',issue.issue_number); set('Title',issue.name);
  // Only the issue's referenced volume can supply publication fields. No folder input exists here.
  set('Series',volume?.name || (volumeId ? issue.volume?.name : null));
  if (volume) {
    if (/^(18|19|20|21)\d{2}$/.test(scalar(volume.start_year))) set('Volume',volume.start_year);
    set('Publisher',volume.publisher?.name);
  }
  const coverDate=validDate(issue.cover_date), storeDate=validDate(issue.store_date);
  const date=coverDate || storeDate;
  const metadataDate=date ? {basis:coverDate?'cover_date':'store_date',precision:coverDate?'month':'day',value:coverDate?date.slice(0,7):date} : null;
  if(date) { fields.Year=date.slice(0,4); fields.Month=String(Number(date.slice(5,7))); if(!coverDate) fields.Day=String(Number(date.slice(8,10))); }
  // StoreDate (custom ComicInfo element, YYYY-MM-DD): the day the issue went on sale. ComicInfo has no
  // standard field for it; Omnibus reads it back (scanned_books.store_date).
  const fallbackStoreDate=storeDate?null:validDate(otherStoreDate?.value);
  const anyStoreDate=storeDate||fallbackStoreDate;
  if(anyStoreDate) fields.StoreDate=anyStoreDate;
  const summary=plainText(issue.description); if(summary) fields.Summary=summary;
  if (/\bannual\b/i.test(fields.Series || '')) fields.Format='Annual';
  const people=Array.isArray(issue.person_credits)?issue.person_credits:[];
  for(const [field,role] of [['Writer',/writer/i],['Penciller',/pencil/i],['Inker',/inker|inking/i],['Colorist',/color/i],['Letterer',/letter/i],['CoverArtist',/cover/i],['Editor',/editor/i]]) {
    const names=[...new Set(people.filter(p=>p && role.test(scalar(p.role))).map(p=>scalar(p.name)).filter(Boolean))];
    if(names.length) fields[field]=names.join(', ');
  }
  for(const [field,key] of [['Characters','character_credits'],['Teams','team_credits'],['Locations','location_credits']]) {
    const names=[...new Set((Array.isArray(issue[key])?issue[key]:[]).map(p=>scalar(p?.name)).filter(Boolean))];
    if(names.length) fields[field]=names.join(', ');
  }
  return { status:'ready', source:{cvIssueId:expected,fields,date:metadataDate}, volumeId, needsVolume:!volume,
    publicationDate: anyStoreDate || coverDate,
    publicationDateSource:anyStoreDate?'store_date':coverDate?'cover_date':null,
    publicationDatePrecision:anyStoreDate?'day':coverDate?'month':null,
    storeDateSource:storeDate?'comic_vine':fallbackStoreDate?(String(otherStoreDate?.source||'')||'other'):null,
    metadataDateSource:validDate(issue.cover_date)?'cover_date':validDate(issue.store_date)?'store_date':null };
}
// The second source's store date for one issue (2026-11-19): asked only when Comic Vine has none.
// Never blocks or fails metadata work: an error or no answer within timeoutMs means no date.
async function secondSourceStoreDate({ fetchStoreDate, id, issue, logger = null, timeoutMs = 30000 } = {}) {
  if (typeof fetchStoreDate !== 'function' || validDate(issue?.store_date)) return null;
  let timer = null;
  try {
    const value = await Promise.race([Promise.resolve().then(() => fetchStoreDate(id)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    return validDate(value) ? { value, source: 'metron' } : null;
  } catch (error) {
    logger?.warn?.('metadata', `Second-source store date lookup failed for issue ${id}`, error?.message);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
module.exports={adaptCvSource,secondSourceStoreDate};
