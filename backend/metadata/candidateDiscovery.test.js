'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {publicationHint,candidateMatches}=require('./candidate');
const {createCandidateDiscovery}=require('./candidateDiscovery');
const book={filename:'Doctor Fate 001 (1988) (Digital) (AnHeroGold-Empire).cbz',comicinfo:null};
const volume={id:3995,name:'Doctor Fate',start_year:'1988'},issue={id:30385,issue_number:'1',cover_date:'1988-12-01',volume:{id:3995}};
const list=results=>({data:{results,number_of_total_results:results.length}});
function fixture({folder={metadata:{comicid:'3995'}},hinted=volume,issues=[issue],search=[volume]}={}){
 const calls=[];const discovery=createCandidateDiscovery({getKey:()=>null,readFolder:()=>folder,apiGet:async(url,{params})=>{
 calls.push({url,params});if(url.includes('/volume/'))return {data:{results:hinted}};if(url.includes('/search/'))return list(search);return list(issues);
 }});return {calls,run:()=>discovery(publicationHint(book.filename),book)};
}
test('Doctor Fate release suffixes produce an independently corroborated publication',()=>{
 assert.deepEqual(publicationHint(book.filename),{name:'Doctor Fate',number:'1',year:'1988',volumeYear:null,manga:false,annual:false});
 assert.equal(candidateMatches({...book,issue,volume}),true);
 for(const suffix of ['(Digital) (Zone-Empire)','[Digital] [Pyrate-DCP]','(Digital-HD) (1920px)','(Minutemen)'])assert.ok(publicationHint('Doctor Fate 001 (1988) '+suffix+'.cbz'));
 assert.deepEqual(publicationHint('Cosmic Boy 002(1987)(Digital)(TLK-EMPIRE-HD).cbz'),{name:'Cosmic Boy',number:'2',year:'1987',volumeYear:null,manga:false,annual:false});
 for(const name of ['Doctor Fate 001-002 (1988) (Digital).cbz','Doctor Fate 001 (1988) (Other #2) (Digital).cbz','Doctor Fate 001 (1988) (Other title).cbz'])assert.equal(publicationHint(name),null,name);
 assert.equal(publicationHint(book.filename,'<ComicInfo><Series>Batman</Series><Number>1</Number></ComicInfo>'),null);
 assert.equal(candidateMatches({...book,issue:{...issue,issue_number:'2'},volume}),false);
 assert.equal(candidateMatches({...book,issue:{...issue,cover_date:'1999-01-01'},volume:{...volume,start_year:'1999'}}),false);
});
test('nested and flat folder IDs avoid a broad search when independently corroborated',async()=>{
 for(const folder of [{metadata:{comicid:'3995'}},{comicid:3995}]){const f=fixture({folder});assert.equal((await f.run())[0].issue.id,30385);assert.equal(f.calls.length,2);assert.equal(f.calls[1].params.filter,'volume:3995,issue_number:1');}
});
test('wrong or missing folder volumes fall back to title discovery',async()=>{
 for(const options of [{hinted:{...volume,name:'Batman'}},{hinted:null},{folder:null},{folder:{comicid:'invalid'}}]){
 const f=fixture(options);assert.equal((await f.run())[0].issue.id,30385);assert.ok(f.calls.some(c=>c.url.includes('/search/')));
 }
});
test('folder hint never hides multiple matching issues or incomplete issue results',async()=>{
 let f=fixture({issues:[issue,{...issue,id:30386}]});assert.equal((await f.run()).length,2);
 f=fixture({issues:Array.from({length:10},(_,i)=>({...issue,id:30385+i}))});assert.deepEqual(await f.run(),[]);
});
test('provider timeouts propagate instead of being treated as a failed identity match',async()=>{
 const error=Object.assign(Error('timeout'),{code:'ECONNABORTED'});
 const discover=createCandidateDiscovery({readFolder:()=>({comicid:3995}),getKey:()=>null,apiGet:async()=>{throw error;}});
 await assert.rejects(discover(publicationHint(book.filename),book),e=>e===error);
});

// Phase 6.6: leading "The" and common titles with many Comic Vine volumes.
test('a leading "The" does not block the folder volume or the title match',async()=>{
 const b={filename:'Punisher 001 (1987).cbz',comicinfo:null,path:'/comics/Marvel/The Punisher (1987)/Punisher 001 (1987).cbz'};
 const v={id:7,name:'The Punisher',start_year:'1987'},i={id:70,issue_number:'1',cover_date:'1987-07-01',volume:{id:7}};
 const discover=createCandidateDiscovery({getKey:()=>null,readFolder:()=>({comicid:'7'}),apiGet:async url=>url.includes('/volume/')?{data:{results:v}}:list([i])});
 const found=await discover(publicationHint(b.filename),b);assert.equal(found.length,1);assert.equal(found[0].issue.id,70);
 assert.equal(candidateMatches({...b,issue:i,volume:v}),true);
 assert.equal(candidateMatches({...b,issue:i,volume:{...v,name:'Punisher War Journal'}}),false);
});
test('a common title with many search results still finds the one corroborated issue',async()=>{
 const b={filename:'Batman 450 (1990).cbz',comicinfo:null,path:'/comics/DC/Batman/Batman 450 (1990).cbz'};
 const volumes=[{id:1,name:'Batman',start_year:'1940'},{id:2,name:'Batman',start_year:'2011'},{id:3,name:'Batman',start_year:'2016'},
   ...Array.from({length:40},(_,n)=>({id:100+n,name:'Batman: Other '+n,start_year:'1990'}))];
 const calls=[];
 const discover=createCandidateDiscovery({getKey:()=>null,readFolder:()=>null,apiGet:async(url,{params})=>{calls.push(params);
   if(url.includes('/search/'))return {data:{results:volumes,number_of_total_results:300}};
   return params.filter==='volume:1,issue_number:450'?list([{id:4500,issue_number:'450',cover_date:'1990-07-01',volume:{id:1}}]):list([]);}});
 const found=await discover(publicationHint(b.filename),b);
 assert.deepEqual(found.map(c=>c.issue.id),[4500]);
 assert.ok(!calls.some(p=>/volume:(2|3),/.test(p.filter||'')),'volumes started after the issue year are not queried');
 assert.equal(candidateMatches({...b,...found[0]}),true);
});

// Phase 6.7: limited-series counts are not issue numbers.
test('"(of 04)" style counts do not create a second issue number',()=>{
 const {filenameEvidence}=require('./evidence');
 for(const f of ['Kingdom of Earth 01 (of 04) (2026) (digital) (Son of Ultron-Empire).cbr','Kingdom of Earth 01 [of 04] (2026).cbz','Kingdom of Earth 01 of 04 (2026).cbz']){
   const e=filenameEvidence(f);assert.equal(e.requiresReview,false,f);assert.deepEqual(e.candidates.map(c=>c.normalized),['1'],f);
 }
 assert.deepEqual(publicationHint('Kingdom of Earth 01 (of 04) (2026) (digital) (Son of Ultron-Empire).cbr'),{name:'Kingdom of Earth',number:'1',year:'2026',volumeYear:null,manga:false,annual:false});
 assert.equal(filenameEvidence('Batman 001-004 (2016).cbz').requiresReview||publicationHint('Batman 001-004 (2016).cbz')===null,true,'ranges still need review');
});
test('a run Comic Vine splits across titles is found in the related volume',async()=>{
 const book={filename:'Spectacular Spider-Man v1 055.cbz',comicinfo:null,path:'/c/The Spectacular Spider-Man (1976)/Spectacular Spider-Man v1 055.cbz'};
 const pub={id:31,name:'Marvel'};
 const later={id:2870,name:'The Spectacular Spider-Man',start_year:'1976',publisher:pub};
 const early={id:2869,name:'Peter Parker, the Spectacular Spider-Man',start_year:'1976',publisher:pub};
 const other={id:9,name:'Peter Parker, the Spectacular Spider-Man',start_year:'1976',publisher:{id:99}};
 const found={id:555,issue_number:'55',cover_date:'1981-06-01',volume:{id:2869}};
 const discovery=createCandidateDiscovery({getKey:()=>null,readFolder:()=>({metadata:{comicid:'2870'}}),apiGet:async(url,{params})=>{
  if(url.includes('/volume/'))return {data:{results:later}};
  if(url.includes('/search/'))return list([later,early,other]);
  return list(params.filter==='volume:2869,issue_number:55'?[found]:[]);
 }});
 const hint=publicationHint(book.filename,null,'The Spectacular Spider-Man (1976)');
 const r=await discovery(hint,book);
 assert.equal(r.length,1);assert.equal(r[0].issue.id,555);assert.equal(r[0].relatedTitle,true);
 assert.match(r.trace.join(' '),/related volume Peter Parker, the Spectacular Spider-Man \(1976\) had #55/);
 assert.equal(candidateMatches({filename:book.filename,comicInfoXml:null,folderName:'The Spectacular Spider-Man (1976)',...r[0]}),true);
 assert.equal(candidateMatches({filename:book.filename,comicInfoXml:null,folderName:'The Spectacular Spider-Man (1976)',issue:r[0].issue,volume:r[0].volume}),false,'without the related flag the title must match exactly');
});
test('dated releases and scan-group tags with a collective anywhere still give a hint',()=>{
 assert.deepEqual(publicationHint('The Ray, 1994-04-00 (_02) (digital) (Glorith-Novus-HD).cbz',null,'The Ray (1994)'),{name:'The Ray',number:'2',year:'1994',volumeYear:null,manga:false,annual:false});
 for(const f of ['Marvel Knights 012 (2001) (Digital) (AnPymGold - Empire).cbz','Fantastic Four 547 (2007) (digital) (Minutemen-Faessla).cbz','Marvel Knights 006 (2000) (F) (Digital) (AnPymGold-Empire).cbz'])assert.ok(publicationHint(f),f);
 assert.equal(publicationHint('Batman 404 (1987) (Unknown Group).cbz'),null,'unknown groups still hold');
});
test('a split run starting years later is found, also through the name filter when search misses it',async()=>{
 // Real Comic Vine layout (Oct 14): 2870 "The Spectacular Spider-Man" (1976)
 // lacks #49-132 and #134; they are in 139754 "Peter Parker, the Spectacular
 // Spider-Man", which starts in 1980.
 const book={filename:'Spectacular Spider-Man v1 052.cbz',comicinfo:null,path:'/c/The Spectacular Spider-Man (1976)/Spectacular Spider-Man v1 052.cbz'};
 const pub={id:31,name:'Marvel'};
 const later={id:2870,name:'The Spectacular Spider-Man',start_year:'1976',publisher:pub};
 const early={id:139754,name:'Peter Parker, the Spectacular Spider-Man',start_year:'1980',publisher:pub};
 const modern={id:102272,name:'Peter Parker: The Spectacular Spider-Man',start_year:'2017',publisher:pub};
 const found={id:552,issue_number:'52',cover_date:'1981-03-01',volume:{id:139754}};
 for(const searchHasIt of [true,false]){
  const calls=[];
  const discovery=createCandidateDiscovery({getKey:()=>null,readFolder:()=>({metadata:{comicid:'2870'}}),apiGet:async(url,{params})=>{
   calls.push(url.split('/api/')[1]+' '+(params.filter||''));
   if(url.includes('/volume/'))return {data:{results:later}};
   if(url.includes('/search/'))return list(searchHasIt?[later,early,modern]:[later]);
   if(url.includes('/volumes/'))return list([{id:1,name:'Spectacular Spider-Man',start_year:'1968',publisher:pub},later,early,modern]);
   return list(params.filter==='volume:139754,issue_number:52'?[found]:[]);
  }});
  const hint=publicationHint(book.filename,null,'The Spectacular Spider-Man (1976)');
  const r=await discovery(hint,book);
  assert.equal(r.length,1,'search has it: '+searchHasIt);assert.equal(r[0].issue.id,552);assert.equal(r[0].relatedTitle,true);
  assert.equal(candidateMatches({filename:book.filename,comicInfoXml:null,folderName:'The Spectacular Spider-Man (1976)',...r[0]}),true);
  assert.ok(!calls.some(c=>c.includes('volume:102272')),'a volume starting decades later is not tried');
  await discovery(hint,{...book,filename:'Spectacular Spider-Man v1 056.cbz'});
  assert.equal(calls.filter(c=>c.startsWith('volumes/')).length,searchHasIt?0:1,'the name-filter lookup is a cached fallback');
 }
 assert.equal(candidateMatches({filename:book.filename,comicInfoXml:null,folderName:'The Spectacular Spider-Man (1976)',issue:found,volume:early,relatedTitle:true}),false,'without the run start year the 1980 volume does not fit 1976');
});
test('filenames the October 14 review list could not read now give a hint',()=>{
 const cases=[
  ['Exiles_Days_of_Then_and_Now_(2008)_(Digital)_(AnPymGold_-_Empire).cbz','Exiles (2001)',{name:'Exiles Days of Then and Now',number:'1',year:'2008'}],
  ['Cable King-Size Spectacular (2008) (digital-Empire).cbz','Cable (2008)',{name:'Cable King-Size Spectacular',number:'1',year:'2008'}],
  ['Power Man 100.cbz','Power Man and Iron Fist (1978)',{name:'Power Man and Iron Fist',number:'100',year:'1978'}],
  ['Ghost Rider - Vengeance Unbound 76.cbz','Ghost Rider (1990)',{name:'Ghost Rider',number:'76',year:'1990'}],
  ['Deathlok 016[1992-10].cbz','Deathlok (1991)',{name:'Deathlok',number:'16',year:'1992'}],
  ['Captain Britain and MI 13 005 (2008) (K&X-DCP).cbz','Captain Britain and MI:13',{name:'Captain Britain and MI 13',number:'5',year:'2008'}],
  ['Infinity Inc. v1 Special 01 (1987) (c2c) (Comixbear-DCP).cbz','Infinity, Inc.',{name:'Infinity Inc. Special',number:'1',year:'1987'}],
  ['(prelude) Action Comics 598 (1988) (digital) (Glorith-Novus-HD).cbz','Checkmate (1988)',{name:'Action Comics',number:'598',year:'1988'}],
 ];
 for(const [f,folder,want] of cases){const h=publicationHint(f,null,folder);assert.ok(h,f);for(const k of Object.keys(want))assert.equal(h[k],want[k],f+' '+k);}
 // Guard rails: a longer title is not shortened to its folder, and a numbered
 // file never becomes a one-shot.
 assert.equal(publicationHint('Batman Beyond 5.cbz',null,'Batman (2016)'),null);
 assert.equal(publicationHint('Ghost Rider 2099 76.cbz',null,'Ghost Rider (1990)'),null);
 assert.equal(publicationHint('Power Man 100 (1983).cbz',null,'Power Man and Iron Fist (1978)').name,'Power Man');
 assert.equal(publicationHint('Batman 404 (1987) (Unknown Group).cbz'),null,'unknown groups still hold');
});
test('a January-March cover may carry the previous sale year',()=>{
 const volume={id:5000,name:'Azrael',start_year:'1995'};
 const issue={id:41000,issue_number:'1',cover_date:'1995-02-01',volume:{id:5000}};
 const filename='Azrael, 1994-12-00 (_01) (digital) (Glorith-Novus-HD).cbz';
 assert.equal(candidateMatches({filename,comicInfoXml:null,folderName:'Azrael (1995)',issue,volume}),true);
 assert.equal(candidateMatches({filename,comicInfoXml:null,folderName:'Azrael (1995)',issue:{...issue,cover_date:'1995-06-01'},volume}),false,'a mid-year cover still needs its own year');
 assert.equal(candidateMatches({filename:'Azrael 001 (1993).cbz',comicInfoXml:null,folderName:'Azrael (1995)',issue,volume}),false,'two years off still fails');
});
test('a "The" after a subtitle separator and half issues written ½ are found (sweeper, 2026-10-15)',async()=>{
 // "Convergence - The New Teen Titans" is Comic Vine's "Convergence: New Teen Titans".
 const ntt={id:81000,name:'Convergence: New Teen Titans',start_year:'2015',publisher:{id:10}};
 const nttIssue={id:490000,issue_number:'2',cover_date:'2015-07-01',volume:{id:81000}};
 const b1={filename:'Convergence - The New Teen Titans 002 (2015) (2 covers) (digital) (Minutemen-Mollylvr).cbz',comicinfo:null,path:'/c/Convergence (2015)/x.cbz'};
 const d1=createCandidateDiscovery({getKey:()=>null,readFolder:()=>null,apiGet:async(url)=>url.includes('/search/')?list([ntt]):list([nttIssue])});
 const r1=await d1(publicationHint(b1.filename),b1);
 assert.equal(r1.length,1);assert.equal(candidateMatches({...b1,folderName:'Convergence (2015)',...r1[0]}),true);
 // Iron Man #½: the 1/2 filter finds nothing, the ½ form does.
 const im={id:5000,name:'Iron Man',start_year:'1998',publisher:{id:31}};
 const half={id:61000,issue_number:'½',cover_date:'2000-01-01',volume:{id:5000}};
 const b2={filename:'Iron Man 00.5 (2000).cbz',comicinfo:null};
 const filters=[];
 const d2=createCandidateDiscovery({getKey:()=>null,readFolder:()=>null,apiGet:async(url,{params})=>{
  if(url.includes('/search/'))return list([im]);filters.push(params.filter);return list(params.filter.endsWith('½')?[half]:[]);}});
 const r2=await d2(publicationHint(b2.filename),b2);
 assert.deepEqual(filters,['volume:5000,issue_number:1/2','volume:5000,issue_number:½']);
 assert.equal(r2.length,1);assert.equal(candidateMatches({...b2,...r2[0]}),true);
 // Not inside a title: "Batman The Dark Knight" stays different from "Batman Dark Knight".
 assert.equal(candidateMatches({filename:'Batman The Dark Knight 001 (2011).cbz',issue:{...issue,issue_number:'1',cover_date:'2011-01-01'},volume:{...volume,name:'Batman: Dark Knight',start_year:'2011'}}),false);
});
