'use strict';
const {parseComicInfoEvidence,parseCvIssueId}=require('./evidence');
const DAY=86400000,IDLE=Number.MAX_SAFE_INTEGER,POLICY_VERSION=3;
function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?stamp:null;
}
function issueId(book){return parseCvIssueId(book.cv_issue_id)||parseComicInfoEvidence(book.comicinfo).identity.cvIssueId;}
function dateInfo(book,job={},cached={}){
  // Scheduling uses store dates before cover dates. This never edits ComicInfo.
  for(const [value,basis,precision] of [
    [cached?.store_date,'store_date','day'],
    [job.date_basis==='store_date'?job.publication_date:null,'store_date','day'],
    [cached?.cover_date,'cover_date','month'],
    [job.publication_date,job.date_basis||'cover_date',job.date_precision||'month']
  ]){const stamp=validDate(value);if(stamp!==null)return {stamp,basis,precision};}
  const ci=parseComicInfoEvidence(book.comicinfo),year=ci.fields.year?.[0],month=ci.fields.month?.[0];
  if(!/^\d{4}$/.test(year||'')||!/^\d{1,2}$/.test(month||'')||+month<1||+month>12)return null;
  const stamp=validDate(`${year}-${String(month).padStart(2,'0')}-01`);
  return stamp===null?null:{stamp,basis:'comicinfo',precision:'month'};
}
function planSchedule(book,job={},now=Date.now(),cached={}){
  const date=dateInfo(book,job,cached),known=issueId(book),age=date?now-date.stamp:null;
  const result=(kind,state,due_at,extra={})=>({kind,state,due_at,milestone:null,
    publication_date:date?new Date(date.stamp).toISOString().slice(0,10):null,
    date_basis:date?.basis||null,date_precision:date?.precision||null,...extra});
  if(/\.(cbr|rar|zip)$/i.test(book.filename||''))return result('normalization','queued',now);
  if(job.initial_pending)return result('initial','queued',now);
  // An index ID is enough to exclude historical automatic enrichment, but never
  // sufficient authority to write tags: the shared retagger still verifies it.
  if(!known||(Object.hasOwn(book,'cv_issue_id')&&!parseCvIssueId(book.cv_issue_id))){
    if(job.attempts>0)return result('identification','waiting',IDLE,{reason:'No Comic Vine issue was identified. Choose the matching issue to continue.'});
    return result('identification','queued',now);
  }
  // Unknown dates stay provisionally eligible, with a sparse monthly follow-up.
  // Never invent a release date or restart daily refreshes.
  if(!date)return job.last_success_at
    ?result('date_discovery','scheduled',job.last_success_at+30*DAY)
    :result('date_discovery','queued',now);
  if(date && age<0){
    // Cover months can lead the actual release. Allow one provider check for a
    // near-future fallback, instead of blocking it before seeing a store date.
    if(date.basis!=='store_date'&&age>=-120*DAY&&!job.last_success_at)return result('date_check','queued',now);
    return job.last_success_at?result('upcoming','scheduled',date.stamp+7*DAY,{milestone:7}):result('upcoming','scheduled',date.stamp);
  }
  if(date && age<=90*DAY){
    if(!job.last_success_at)return result('recent','queued',now);
    const milestone=[7,30,90].find(days=>date.stamp+days*DAY>job.last_success_at);
    if(milestone)return result('recent','scheduled',date.stamp+milestone*DAY,{milestone});
    return result('recent','complete',IDLE);
  }
  // A deferred final milestone remains one pending check; do not silently lose
  // it when provider unavailability takes it just beyond day 90.
  if(date && job.milestone===90 && job.last_success_at && job.last_success_at<date.stamp+90*DAY)
    return result('recent','queued',date.stamp+90*DAY,{milestone:90});
  return result('idle','complete',IDLE);
}
module.exports={dateInfo,issueId,planSchedule,DAY,IDLE,POLICY_VERSION};
