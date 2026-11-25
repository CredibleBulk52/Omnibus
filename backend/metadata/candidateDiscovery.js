'use strict';
const {candidateMatches,bookFolderName,titleKey,sameTitle,dropSubtitleThe}=require('./candidate');
const {parseCvIssueId}=require('./evidence');
const norm=titleKey;
function completeRows(response){
  const data=response?.data,rows=data?.results;
  if(!Array.isArray(rows)||rows.length>=10||Number(data.number_of_total_results)>rows.length)return null;
  return rows;
}
function createCandidateDiscovery({apiGet,getKey,readFolder}){
  const get=(resource,params)=>apiGet('https://comicvine.gamespot.com/api/'+resource,{params:{api_key:getKey(),format:'json',...params},timeout:15000});
  // Comic Vine writes a half issue as "1/2", "½" or "0.5" (Wizard ½ issues):
  // try each until one is found.
  // Suffixed issues: Comic Vine writes "16.NOW" or "16NOW". Marvel NOW! branding
  // is often listed as the plain number (Iron Man 2013 #23.NOW is "23"), so that
  // is tried last. Tie-in suffixes (AU, INH) are separate issues: no fallback.
  const numberForms=n=>n==='1/2'?['1/2','½','0.5']:/^-?\d+\.[a-z]+$/i.test(n)?[n,n.replace('.',''),...(/\.now$/i.test(n)?[n.replace(/\.now$/i,'')]:[])]:[n];
  // Issue lists by volume (2026-11-25). Each book used to cost one Comic Vine /issues request
  // (volume + issue number), so a 300-issue import used 300 of the hourly 200 on that path.
  // Once a volume has had as many lookups within an hour as its full list takes pages (100 issues
  // a page), the whole list is read once and later books are matched from it. The list asks for
  // the same fields as the single lookup, so the cover and store dates used to check the year are
  // the same; the store date written to the file still comes from the book's own /issue request
  // (and Metron only when that has none), which this does not touch. A number the list does not
  // have (a new issue, an odd form) is asked as before.
  const ISSUE_FIELDS='id,issue_number,cover_date,store_date,volume',LIST_TTL=3600000,MAX_PAGES=10;
  const byVolume=new Map();   // volume id -> {asked: Map(number -> time), list, at, loading}
  const sameNumber=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
  const pagesFor=volume=>{const n=Number(volume?.count_of_issues);return n>0?Math.ceil(n/100):null;};
  async function readList(id,pages){
    const list=[];let total=null;
    for(let offset=0;offset<pages*100;offset+=100){
      const data=(await get('issues/',{filter:'volume:'+id,field_list:ISSUE_FIELDS,limit:100,offset}))?.data;
      const page=Array.isArray(data?.results)?data.results:null;
      if(!page)return null;
      list.push(...page);total=Number(data.number_of_total_results);
      if(page.length<100||list.length>=total)break;
    }
    return Number.isFinite(total)&&list.length===total?list:null;   // incomplete: not used
  }
  async function volumeList(volume,number){
    const pages=pagesFor(volume);
    if(!pages||pages>MAX_PAGES)return null;
    const id=String(volume.id),now=Date.now();
    if(byVolume.size>500)byVolume.clear();
    let v=byVolume.get(id);if(!v){v={asked:new Map(),list:null,at:0,loading:null};byVolume.set(id,v);}
    if(v.at&&now-v.at<LIST_TTL)return v.list;
    if(v.loading)return v.loading;
    for(const [n,t] of v.asked)if(now-t>=LIST_TTL)v.asked.delete(n);
    v.asked.set(String(number),now);
    if(v.asked.size<pages)return null;
    v.loading=readList(id,pages).then(list=>{v.list=list;v.at=Date.now();return list;},()=>null).finally(()=>{v.loading=null;});
    return v.loading;
  }
  async function issuesFor(volume,hint,related=false,parentStartYear=null){
    if(!volume||(!related&&!sameTitle(volume.name,hint.name)))return [];
    let rows=[];
    const listed=await volumeList(volume,hint.number);
    const fromList=listed&&numberForms(hint.number).map(n=>listed.filter(i=>sameNumber(i.issue_number,n))).find(r=>r.length);
    if(fromList)rows=fromList.length>=10?null:fromList;
    else for(const n of numberForms(hint.number)){
      rows=completeRows(await get('issues/',{filter:'volume:'+volume.id+',issue_number:'+n,field_list:ISSUE_FIELDS,limit:10}));
      if(rows===null||rows.length)break;
    }
    return rows?.map(issue=>related?{issue,volume,relatedTitle:true,parentStartYear}:{issue,volume})??null;
  }
  // Volumes whose title contains the book's title, from Comic Vine's name filter
  // (a contains match), oldest first, stopping past the wanted start year.
  // Search ranking alone missed "Peter Parker, the Spectacular Spider-Man"
  // behind 50 better-ranked "Spectacular Spider-Man" volumes. Cached for an
  // hour so a run of books from one folder costs one lookup.
  const titleVolumes=new Map();
  // A continuation volume starts within this many years of the folder volume
  // ("Peter Parker, the Spectacular Spider-Man" 1980 holds #49-132 of the
  // 1976 run).
  const RELATED_SPAN=10;
  async function volumesContaining(name,startYear){
    const key=norm(name)+'|'+startYear,hit=titleVolumes.get(key);
    if(hit&&hit.at>Date.now()-3600000)return hit.rows;
    const rows=[];
    for(let offset=0;offset<300;offset+=100){
      const data=(await get('volumes/',{filter:'name:'+name,field_list:'id,name,start_year,publisher,count_of_issues',sort:'start_year:asc',limit:100,offset}))?.data;
      const page=Array.isArray(data?.results)?data.results:[];
      rows.push(...page);
      if(page.length<100||page.some(v=>Number(v.start_year)>Number(startYear)+RELATED_SPAN))break;
    }
    titleVolumes.set(key,{at:Date.now(),rows});
    return rows;
  }
  const containsTitle=(name,want)=>(' '+norm(name)+' ').includes(' '+norm(want)+' ');
  // Each result carries a short trace of where Omnibus looked, so a failed
  // match can say what it searched instead of only "no match".
  const label=v=>`${v.name}${v.start_year?' ('+v.start_year+')':''}`;
  const seen=rows=>rows.map(c=>`#${c.issue.issue_number}${c.issue.cover_date?' '+String(c.issue.cover_date).slice(0,7):''}`).join(', ');
  return async (hint,book)=>{
    const trace=[];const done=list=>Object.defineProperty(list,'trace',{value:trace,enumerable:false});
    const folder=await readFolder(book),id=parseCvIssueId(folder?.metadata?.comicid??folder?.comicid);
    let folderLacksIssue=null;
    if(id){
      const volume=(await get('volume/4050-'+id+'/',{field_list:'id,name,start_year,publisher,count_of_issues'}))?.data?.results;
      if(String(volume?.id)===id){
        const proposed=await issuesFor(volume,hint);
        const accepted=proposed?.filter(c=>candidateMatches({filename:book.filename,comicInfoXml:book.comicinfo,folderName:bookFolderName(book),...c}));
        trace.push(!sameTitle(volume.name,hint.name)?`folder volume ${label(volume)} has a different title`
          :proposed===null?`folder volume ${label(volume)}: too many issue #${hint.number} results`
          :!proposed.length?`folder volume ${label(volume)} has no issue #${hint.number}`
          :accepted.length?`folder volume ${label(volume)} matched`:`folder volume ${label(volume)} found ${seen(proposed)} but it did not agree with the book (year or annual)`);
        // Folder evidence narrows discovery only when the provider publication
        // independently agrees with the book. Never promote the folder ID itself.
        if(accepted?.length)return done(accepted);
        if(Array.isArray(proposed)&&!proposed.length&&sameTitle(volume.name,hint.name))folderLacksIssue=volume;
      } else trace.push(`folder Comic Vine volume ${id} was not found`);
    }
    // Common titles (Batman, Avengers) return many volumes. Keep only volumes
    // whose title matches exactly, started by the book's year, newest first;
    // number and year must still corroborate and the runtime requires one match.
    const search=async q=>(await get('search/',{resources:'volume',query:q,field_list:'id,name,start_year,publisher,count_of_issues',limit:50}))?.data?.results;
    let found=await search(hint.name);
    if(!Array.isArray(found)){trace.push('Comic Vine search returned nothing');return done([]);}
    const year=Number(hint.volumeYear||hint.year)||null;
    const titled=list=>list.filter(v=>sameTitle(v.name,hint.name)&&(!year||!Number(v.start_year)||Number(v.start_year)<=year+1))
      .sort((a,b)=>(Number(b.start_year)||0)-(Number(a.start_year)||0)).slice(0,6);
    let volumes=titled(found);
    // "Convergence - The New Teen Titans": search Comic Vine's form too.
    const alt=dropSubtitleThe(hint.name);
    if(!volumes.length&&alt!==hint.name){
      const more=await search(alt);
      if(Array.isArray(more)){found=[...found,...more];volumes=titled(more);}
    }
    const results=[];
    for(const volume of volumes){const rows=await issuesFor(volume,hint);if(rows===null){trace.push(`too many issue #${hint.number} results in ${label(volume)}`);return done([]);}results.push(...rows);}
    trace.push(volumes.length?`searched ${volumes.map(label).join(', ')}${results.length?' and found '+seen(results):' — none has issue #'+hint.number}`:`no Comic Vine volume is titled exactly "${hint.name}"`);
    // Comic Vine sometimes splits one run across titles ("Peter Parker, the
    // Spectacular Spider-Man" #1-133, "The Spectacular Spider-Man" after). When
    // the folder's own volume lacks the issue, try volumes that contain the
    // whole title, from the same publisher, starting within ten years after it.
    if(!results.length&&folderLacksIssue){
      const start=Number(folderLacksIssue.start_year);
      const relatedTo=v=>!sameTitle(v.name,hint.name)&&containsTitle(v.name,hint.name)
        &&String(v.publisher?.id??'')===String(folderLacksIssue.publisher?.id??'')
        &&Number(v.start_year)>=start&&Number(v.start_year)<=start+RELATED_SPAN;
      const nearest=list=>list.filter(relatedTo).sort((a,b)=>Number(a.start_year)-Number(b.start_year)).slice(0,3);
      let related=nearest(found);
      if(!related.length)related=nearest(await volumesContaining(hint.name,folderLacksIssue.start_year));
      for(const volume of related){const rows=await issuesFor(volume,hint,true,folderLacksIssue.start_year);if(rows)results.push(...rows);}
      if(related.length)trace.push(`related volume${related.length>1?'s':''} ${related.map(label).join(', ')}${results.length?' had '+seen(results):' — none has issue #'+hint.number}`);
    }
    return done(results);
  };
}
module.exports={createCandidateDiscovery};
