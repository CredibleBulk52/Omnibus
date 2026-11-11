'use strict';
// Annual identification (Phase 6.5). Annual file names rarely follow the
// "Title 001 (1999)" grammar candidate.js accepts: "Uncanny X-Men 1995 Annual
// 19", "Wolverine Annual 1997", "X-Force - Cable Annual (1995)". Comic Vine
// files many 1995-2001 annuals as year-named one-shots ("Wolverine '97",
// "Avengers 1999", #1) or crossovers ("Hulk / Sub-Mariner '98"). This module
// proposes a provider candidate for an annual file; annualCandidateMatches is
// the deterministic recheck used by retagRuntime and identity.js before any
// archive write. Claude only chooses among real Comic Vine candidates.
const {parseCvIssueId}=require('./evidence');

const YEAR_RE=/^(19|20)\d\d$/;
function parseAnnualName(filename){
  const base=String(filename||'').split(/[\\/]/).pop().replace(/\.(cbz|cbr|zip|rar|pdf)$/i,'').replace(/_/g,' ').replace(/\s+/g,' ').trim();
  const insert=/#\s*\d+[a-z](?=[\s.(\-_]|$)/i.test(base);
  let year=null;
  const y1=base.match(/\((19\d\d|20\d\d)\)/);
  const y2=base.match(/\bAnnual\s+(19\d\d|20\d\d)\b/i)||base.match(/\b(19\d\d|20\d\d)\s+Annual\b/i);
  const y3=base.match(/'(\d\d)(?!\d)/);
  if(y2)year=+y2[1];else if(y1)year=+y1[1];else if(y3)year=(+y3[1]>30?1900:2000)+ +y3[1];
  const core=base.replace(/\[[^\]]*\]/g,' ').replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
  let number=null;
  const n=core.match(/\bAnnual\s+(?:Annual\s+)?#?(\d{1,4})(?!\d)/i);
  if(n&&!YEAR_RE.test(n[1]))number=String(parseInt(n[1],10));
  const at=core.search(/\bannual\b/i);
  const series=(at>=0?core.slice(0,at):core).replace(/'\d\d\b/g,' ').replace(/\b(19|20)\d\d\b/g,' ')
    .replace(/\b[vV]\d+\b/g,' ').replace(/^the\s+/i,'').replace(/\s+-\s+/g,' ').replace(/\s+/g,' ').trim();
  return {annual:at>=0,base,year,number,series,insert};
}
const STOP=new Set(['the','annual','and','of','a','an','comics','marvel','dc']);
function nameTokens(s){
  return String(s||'').normalize('NFKC').toLowerCase().replace(/'\d\d\b/g,' ').replace(/\b(19|20)\d\d\b/g,' ').replace(/\bv\d+\b/g,' ')
    .replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').split(' ').filter(w=>w&&!STOP.has(w));
}
const sameName=(a,b)=>{const x=nameTokens(a).join(' '),y=nameTokens(b).join(' ');return !!x&&x===y;};
function volYear(name){
  const a=String(name||'').match(/'(\d\d)(?!\d)/);if(a)return (+a[1]>30?1900:2000)+ +a[1];
  const b=String(name||'').match(/\b((?:19|20)\d\d)\b/);return b?+b[1]:null;
}
const hasAnnualWord=name=>/\bannual\b/i.test(name||'');
// A year-named one-shot volume ("Wolverine '97", "Avengers 1999") is how
// Comic Vine records many annuals; it counts as an annual for annual files.
const isYearNamedVolume=name=>!hasAnnualWord(name)&&volYear(name)!=null;
function normNum(s){
  const raw=String(s??'').trim();if(!raw)return '';
  const dot=raw.indexOf('.');
  if(dot===-1)return String(parseInt(raw,10)||0)+raw.replace(/^\d+/,'').toLowerCase();
  return String(parseInt(raw.slice(0,dot),10)||0)+raw.slice(dot).toLowerCase();
}
const yearOf=d=>parseInt(String(d||'').slice(0,4),10)||null;
const issueYears=issue=>[yearOf(issue?.cover_date),yearOf(issue?.store_date)].filter(Boolean);

// Deterministic recheck: rules only, plus a bounded acceptance of a Claude
// pick (provider ids coherent, annual-type volume, year agrees).
function annualCandidateMatches({filename,issue,volume,annualMatch}){
  const p=parseAnnualName(filename);
  if(!p.annual||p.insert||!p.series)return false;
  const issueId=parseCvIssueId(issue?.id),volumeId=parseCvIssueId(volume?.id);
  if(!issueId||!volumeId||parseCvIssueId(issue?.volume?.id)!==volumeId)return false;
  const name=volume.name||'',annualVol=hasAnnualWord(name),years=issueYears(issue);
  const near=(slack)=>!p.year||years.some(y=>Math.abs(y-p.year)<=slack);
  const numberOk=!p.number||normNum(issue.issue_number)===normNum(p.number);
  if(sameName(name,p.series)){
    if(annualVol&&p.number&&numberOk&&near(1))return true;                    // "Punisher Annual 004 (1991)"
    if(annualVol&&!p.number&&p.year&&years.includes(p.year))return true;       // "Thor Annual (2021)"
    if(isYearNamedVolume(name)&&p.year&&volYear(name)===p.year&&normNum(issue.issue_number)==='1')return true; // "Wolverine '97"
  }
  if(annualMatch?.rule==='ai'&&p.year&&(annualVol||isYearNamedVolume(name))){
    if(isYearNamedVolume(name))return volYear(name)===p.year;
    return near(1);
  }
  return false;
}

function createAnnualDiscovery({apiGet,getKey,askClaude=null}){
  const get=(resource,params)=>apiGet('https://comicvine.gamespot.com/api/'+resource,{params:{api_key:getKey(),format:'json',...params},timeout:15000});
  const searchCache=new Map(),issueCache=new Map(),DAY=24*3600*1000;
  async function search(query){
    const hit=searchCache.get(query);if(hit&&Date.now()-hit.at<DAY)return hit.list;
    if(searchCache.size>500)searchCache.clear();
    const list=(await get('search/',{resources:'volume',query,limit:20,field_list:'id,name,start_year,publisher,count_of_issues'}))?.data?.results||[];
    searchCache.set(query,{at:Date.now(),list});return list;
  }
  async function volumeIssues(id){
    const hit=issueCache.get(id);if(hit&&Date.now()-hit.at<DAY)return hit.list;
    if(issueCache.size>500)issueCache.clear();
    const list=[];
    for(let offset=0;offset<300;offset+=100){
      const data=(await get('issues/',{filter:'volume:'+id,field_list:'id,issue_number,cover_date,store_date,volume',limit:100,offset}))?.data;
      const page=data?.results||[];list.push(...page);
      if(page.length<100||list.length>=(Number(data?.number_of_total_results)||0))break;
    }
    issueCache.set(id,{at:Date.now(),list});return list;
  }
  return async function discoverAnnual(book){
    const p=parseAnnualName(book.filename);
    if(!p.annual)return {candidate:null,reason:null};
    if(p.insert)return {candidate:null,reason:'Reading-order insert; choose the issue by hand.'};
    if(!p.series||(!p.year&&!p.number))return {candidate:null,reason:'Annual file name has no series, year or number to search with.'};
    const segments=String(book.path||'').toLowerCase().split(/[\\/]/);
    const publisherOk=v=>{const first=String(v.publisher?.name||'').toLowerCase().split(/\s+/)[0];return !first||segments.some(s=>s.split(/\s+/).includes(first));};
    async function volumes(wide){
      const queries=[p.series+' Annual'];
      if(wide&&p.year)queries.push(p.series+" '"+String(p.year).slice(2),p.series+' '+p.year);
      const seen=new Map();
      for(const q of queries)for(const v of await search(q))seen.set(String(v.id),v);
      let list=[...seen.values()].filter(v=>hasAnnualWord(v.name)||isYearNamedVolume(v.name)).filter(publisherOk);
      if(p.year)list=list.filter(v=>!v.start_year||+v.start_year<=p.year+1)
        .filter(v=>hasAnnualWord(v.name)||volYear(v.name)===p.year);
      list.sort((a,b)=>(sameName(b.name,p.series)-sameName(a.name,p.series))||(p.year?Math.abs((+a.start_year||0)-p.year)-Math.abs((+b.start_year||0)-p.year):0));
      return list.slice(0,wide?6:4);
    }
    async function collect(vols){
      const out=[];
      for(const v of vols)for(const i of await volumeIssues(String(v.id)))
        out.push({issue:{id:i.id,issue_number:i.issue_number,cover_date:i.cover_date||null,store_date:i.store_date||null,volume:{id:v.id}},
          volume:{id:v.id,name:v.name,start_year:v.start_year,publisher:v.publisher}});
      return out;
    }
    const ruleHits=list=>{
      const ok=list.filter(c=>annualCandidateMatches({filename:book.filename,...c}));
      // Prefer exact cover year when several annual numbers fit within ±1.
      const exact=p.year?ok.filter(c=>issueYears(c.issue).includes(p.year)||volYear(c.volume.name)===p.year):ok;
      const pool=exact.length?exact:ok;
      return [...new Map(pool.map(c=>[String(c.issue.id),c])).values()];
    };
    let all=await collect(await volumes(false)),hits=ruleHits(all);
    if(hits.length!==1){all=await collect(await volumes(true));hits=ruleHits(all);}
    if(hits.length===1)return {candidate:{...hits[0],annualMatch:{rule:'rules'}},reason:null};
    if(!all.length)return {candidate:null,reason:`No Comic Vine annual volume found for "${p.series}".`};
    if(!askClaude)return {candidate:null,reason:`${hits.length?'Several':'No'} Comic Vine annuals fit; choose the issue.`};
    const near=all.filter(c=>!p.year||issueYears(c.issue).some(y=>Math.abs(y-p.year)<=1)||volYear(c.volume.name)===p.year);
    let pool=near.length>30&&p.number?near.filter(c=>normNum(c.issue.issue_number)===normNum(p.number)):near;
    pool=pool.slice(0,30);
    if(!pool.length)return {candidate:null,reason:`No Comic Vine annual near ${p.year||'that year'} for "${p.series}".`};
    const choices=pool.map(c=>({issue_id:String(c.issue.id),volume:c.volume.name,volume_start_year:c.volume.start_year,issue_number:c.issue.issue_number,cover_date:c.issue.cover_date}));
    const answer=await askClaude(annualPrompt(book,p,choices));
    const s=answer?.indexOf?.('{'),e=answer?.lastIndexOf?.('}');
    if(s==null||s<0||e<0)return {candidate:null,reason:'Claude could not choose a match; choose the issue.'};
    let picked;try{picked=JSON.parse(answer.slice(s,e+1));}catch{return {candidate:null,reason:'Claude could not choose a match; choose the issue.'};}
    const choice=picked?.issue_id&&pool.find(c=>String(c.issue.id)===String(picked.issue_id));
    if(!choice)return {candidate:null,reason:'No match found'+(picked?.reason?': '+String(picked.reason).slice(0,300):'.')};
    const candidate={...choice,annualMatch:{rule:'ai',reason:String(picked.reason||'').slice(0,300)}};
    if(!annualCandidateMatches({filename:book.filename,...candidate}))return {candidate:null,reason:'Claude suggested '+choice.volume.name+' #'+choice.issue.issue_number+', but its year does not fit this file; choose the issue.'};
    return {candidate,reason:null};
  };
}

function annualPrompt(book,p,choices){
  return `A comic file needs its Comic Vine issue. Pick the ONE candidate that is this exact issue, or null if none is.

File name: "${book.filename}"
Folder: "${String(book.path||'').split(/[\\/]/).slice(-2,-1)[0]||''}"
Parsed: series "${p.series}", year ${p.year||'unknown'}, annual number ${p.number||'unknown'}

Candidates (Comic Vine):
${JSON.stringify(choices,null,1)}

How annuals are filed on Comic Vine (important):
- From about 1995 to 2001 Marvel published each series' annual as a one-shot volume named with the year ("Uncanny X-Men '95", "Avengers 1999"), numbered #1. File names often still carry the series' RUNNING annual number ("Uncanny X-Men 1995 Annual 19") — that number will NOT match the one-shot's #1, and that is expected.
- Some years the series' annual was a crossover one-shot with a combined name: e.g. X-Force's 1995 annual is "X-Force / Cable '95", 1998 "X-Force / Champions '98"; Captain America 1998 "Captain America / Citizen V '98"; Generation X 1998 "Generation X / Dracula '98"; Hulk 1998 "Hulk / Sub-Mariner '98". A crossover whose name includes this series and whose year matches the file's year IS the right answer when no plain one-shot of that series exists for that year.
- A series may have been retitled ("The Incredible Hulk" → "Hulk" in 1999; "Spider-Man" ↔ "Peter Parker: Spider-Man").
- Comic Vine cover dates are often a year later than the year in the volume name; trust the year in the volume name.
- When two candidates are halves of a two-part crossover (title order swapped), pick the one whose title order matches the file name.
Return null only when no candidate fits these patterns.
Respond with ONLY JSON: {"issue_id": "<id or null>", "reason": "<short reason>"}`;
}

module.exports={parseAnnualName,annualCandidateMatches,createAnnualDiscovery,isYearNamedVolume,sameName,volYear};
