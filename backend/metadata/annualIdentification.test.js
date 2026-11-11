'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseAnnualName,annualCandidateMatches,createAnnualDiscovery,isYearNamedVolume}=require('./annualIdentification');
const {candidateMatches}=require('./candidate');
const vol=(id,name,start_year,publisher='Marvel')=>({id,name,start_year,publisher:{name:publisher}});
const iss=(id,volumeId,issue_number,cover_date)=>({id,issue_number,cover_date,store_date:null,volume:{id:volumeId}});
const MARVEL='/comics/Marvel Comics/2. Modern Age';

test('parses the annual name shapes found in the library',()=>{
  const cases={
    'Uncanny X-Men 1995 Annual 19.cbr':['Uncanny X-Men',1995,'19'],
    'Wolverine Annual 1997 (1997) (noads) (DarthMedio-DCP).cbz':['Wolverine',1997,null],
    "X-Man '97 Annual (1997) (Minutemen-Meganubis).cbz":['X-Man',1997,null],
    'X-Force - Cable Annual (1995) (Digital) (Shadowcat-Empire).cbz':['X-Force Cable',1995,null],
    'Iron Man v3 Annual (2000).cbz':['Iron Man',2000,null],
    'The Punisher Annual 004 (1991).cbz':['Punisher',1991,'4'],
    'Titans 2025 Annual 001.cbz':['Titans',2025,'1'],
    "Gambit Annual 001 '99 (1999) (Digital).cbz":['Gambit',1999,'1'],
  };
  for(const [f,[series,year,number]] of Object.entries(cases)){const p=parseAnnualName(f);assert.deepEqual([p.series,p.year,p.number],[series,year,number],f);}
  assert.equal(parseAnnualName('The Incredible Hulk #350b (Avengers Annual #17).cbz').insert,true);
  assert.equal(parseAnnualName('Doctor Fate 001 (1988).cbz').annual,false);
});

test('deterministic rules: annual volume, year-named one-shot, and rejections',()=>{
  const ux=vol(1,'Uncanny X-Men Annual',1970),ux95=vol(2,"Uncanny X-Men '95",1995),xm95=vol(3,"X-Men '95",1995);
  assert.equal(annualCandidateMatches({filename:'Uncanny X-Men 1994 Annual 18.cbr',issue:iss(10,1,'18','1994-01-01'),volume:ux}),true);
  assert.equal(annualCandidateMatches({filename:'Uncanny X-Men 1995 Annual 19.cbr',issue:iss(20,2,'1','1995-12-01'),volume:ux95}),true,'year-named one-shot ignores running number');
  assert.equal(annualCandidateMatches({filename:'Uncanny X-Men 1995 Annual 19.cbr',issue:iss(21,3,'1','1995-12-01'),volume:xm95}),false,'different title');
  assert.equal(annualCandidateMatches({filename:'Wolverine Annual 1997 (1997).cbz',issue:iss(30,4,'1','1998-01-01'),volume:vol(4,"Wolverine '97",1997)}),true,'cover date a year later');
  assert.equal(annualCandidateMatches({filename:'Wolverine Annual 1997 (1997).cbz',issue:iss(31,5,'1','1996-01-01'),volume:vol(5,"Wolverine '96",1996)}),false,'wrong year');
  assert.equal(annualCandidateMatches({filename:'The Punisher Annual 004 (1991).cbz',issue:iss(40,6,'4','1991-06-30'),volume:vol(6,'The Punisher Annual',1988)}),true,'"The" ignored');
  assert.equal(annualCandidateMatches({filename:'The Punisher Annual 004 (1991).cbz',issue:iss(41,6,'5','1992-06-30'),volume:vol(6,'The Punisher Annual',1988)}),false,'wrong number');
  assert.equal(annualCandidateMatches({filename:'The Punisher Annual 004 (1991).cbz',issue:iss(40,7,'4','1991-06-30'),volume:vol(6,'The Punisher Annual',1988)}),false,'volume id mismatch');
  // Claude pick: bounded by year and annual-type volume.
  const cross=vol(8,"Hulk / Sub-Mariner '98",1998);
  assert.equal(annualCandidateMatches({filename:'Incredible Hulk v2 Annual 1998 (22) (scan).cbr',issue:iss(50,8,'1','1998-08-01'),volume:cross,annualMatch:{rule:'ai'}}),true);
  assert.equal(annualCandidateMatches({filename:'Incredible Hulk v2 Annual 1998 (22) (scan).cbr',issue:iss(50,8,'1','1998-08-01'),volume:cross}),false,'not without the AI pick');
  assert.equal(annualCandidateMatches({filename:'Incredible Hulk v2 Annual 1999 (scan).cbr',issue:iss(50,8,'1','1998-08-01'),volume:cross,annualMatch:{rule:'ai'}}),false,'AI pick with the wrong year');
  assert.equal(annualCandidateMatches({filename:'Hulk Annual 1999.cbz',issue:iss(51,9,'12','1999-08-01'),volume:vol(9,'Hulk',1999),annualMatch:{rule:'ai'}}),false,'AI pick of a regular volume');
  assert.equal(isYearNamedVolume("Wolverine '97"),true);assert.equal(isYearNamedVolume('Wolverine Annual'),false);
});

test('candidateMatches accepts annual rules only for annual files without an embedded identity',()=>{
  const c={issue:iss(20,2,'1','1995-12-01'),volume:vol(2,"Uncanny X-Men '95",1995)};
  assert.equal(candidateMatches({filename:'Uncanny X-Men 1995 Annual 19.cbr',...c}),true);
  assert.equal(candidateMatches({filename:'Uncanny X-Men 1995 Annual 19.cbr',comicInfoXml:'<ComicInfo><Web>https://comicvine.gamespot.com/x/4000-999/</Web></ComicInfo>',...c}),false);
  assert.equal(candidateMatches({filename:'Uncanny X-Men 19 (1995).cbr',...c}),false);
});

function provider({searches={},issues={}}){
  const calls=[];
  return {calls,apiGet:async(url,{params})=>{calls.push({url,params});
    if(url.includes('/search/'))return {data:{results:searches[params.query]||[]}};
    const id=String(params.filter).replace('volume:','');const list=issues[id]||[];
    return {data:{results:list.slice(params.offset,params.offset+100),number_of_total_results:list.length}};}};
}
test('discovery: narrow search, then year-named widening, then Claude among real candidates',async()=>{
  const ux=vol(1,'Uncanny X-Men Annual',1970),ux96=vol(2,"Uncanny X-Men '96",1996),xm96=vol(3,"X-Men '96",1996);
  const p=provider({searches:{'Uncanny X-Men Annual':[ux],"Uncanny X-Men '96":[ux96,xm96]},issues:{1:[iss(118,1,'18','1994-01-01')],2:[iss(1096,2,'1','1996-11-01')],3:[iss(1196,3,'1','1996-11-01')]}});
  let asked=0;const discover=createAnnualDiscovery({apiGet:p.apiGet,getKey:()=>'k',askClaude:async()=>{asked++;return null;}});
  const r=await discover({filename:'Uncanny X-Men 1996 Annual 20.cbr',path:'/comics/Marvel Comics/1. Classic Era/The Uncanny X-Men (1981)/Uncanny X-Men 1996 Annual 20.cbr'});
  assert.equal(String(r.candidate.issue.id),'1096');assert.equal(r.candidate.annualMatch.rule,'rules');assert.equal(asked,0);
  // Crossover: rules find nothing; Claude picks a real candidate.
  const hulk98=vol(8,"Hulk / Sub-Mariner '98",1998),xh98=vol(9,"X-Man / Hulk '98",1998);
  const q=provider({searches:{'Incredible Hulk Annual':[vol(7,'The Incredible Hulk Annual',1976)],"Incredible Hulk '98":[hulk98,xh98],'Incredible Hulk 1998':[]},issues:{7:[iss(70,7,'20','1994-01-01')],8:[iss(800,8,'1','1998-08-01')],9:[iss(900,9,'1','1998-08-01')]}});
  let prompt='';const d2=createAnnualDiscovery({apiGet:q.apiGet,getKey:()=>'k',askClaude:async text=>{prompt=text;return '{"issue_id":"800","reason":"Hulk 1998 annual crossover"}';}});
  const r2=await d2({filename:'Incredible Hulk v2 Annual 1998 (22) (scan).cbr',path:MARVEL+'/The Incredible Hulk (1968)/x.cbr'});
  assert.equal(String(r2.candidate.issue.id),'800');assert.equal(r2.candidate.annualMatch.rule,'ai');assert.match(prompt,/RUNNING annual number/);
  // Claude may not invent an id outside the candidates.
  const d3=createAnnualDiscovery({apiGet:q.apiGet,getKey:()=>'k',askClaude:async()=>'{"issue_id":"123456","reason":"guess"}'});
  const r3=await d3({filename:'Incredible Hulk v2 Annual 1998 (22) (scan).cbr',path:MARVEL+'/x/x.cbr'});
  assert.equal(r3.candidate,null);assert.match(r3.reason,/No match/);
  // Without Claude: unresolved, with a reason.
  const d4=createAnnualDiscovery({apiGet:q.apiGet,getKey:()=>'k'});
  assert.equal((await d4({filename:'Incredible Hulk v2 Annual 1998 (22) (scan).cbr',path:MARVEL+'/x/x.cbr'})).candidate,null);
});
test('discovery: publisher from the library path filters other publishers; inserts and non-annuals are skipped',async()=>{
  const p=provider({searches:{'Thor Annual':[vol(1,'Thor Annual',2021,'DC Comics'),vol(2,'Thor Annual',2021)]},issues:{1:[iss(10,1,'1','2021-09-01')],2:[iss(20,2,'1','2021-09-01')]}});
  const d=createAnnualDiscovery({apiGet:p.apiGet,getKey:()=>'k'});
  const r=await d({filename:'Thor Annual Annual 001 (2021).cbz',path:'/comics/Marvel Comics/4. Fresh Start/Thor (2020)/x.cbz'});
  assert.equal(String(r.candidate.issue.id),'20');
  assert.equal((await d({filename:'The Incredible Hulk #350b (Avengers Annual #17).cbz',path:'/x'})).candidate,null);
  assert.deepEqual(await d({filename:'Doctor Fate 001 (1988).cbz',path:'/x'}),{candidate:null,reason:null});
});
test('discovery: provider errors propagate (deferred by maintenance, not a failed match)',async()=>{
  const error=Object.assign(Error('timeout'),{code:'ECONNABORTED'});
  const d=createAnnualDiscovery({apiGet:async()=>{throw error;},getKey:()=>'k'});
  await assert.rejects(d({filename:'Wolverine Annual 1997 (1997).cbz',path:MARVEL+'/Wolverine (1988)/x.cbz'}),e=>e===error);
});
