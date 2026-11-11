'use strict';
const {parseComicInfoEvidence,parseIssueNumberEvidence,filenameEvidence,parseCvIssueId,stripIssueCount}=require('./evidence');
const {annualCandidateMatches}=require('./annualIdentification');
// Title key: case/punctuation-insensitive, '&' = 'and', a leading "The" ignored
// ("Punisher" = "The Punisher"). Number and year must still corroborate.
const title=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/^the /,'');
// Same title, also when one adds "The" after a subtitle separator: the file
// "Convergence - The New Teen Titans" is Comic Vine's "Convergence: New Teen
// Titans". Only right after ":" or " - ", never inside a title.
const dropSubtitleThe=value=>String(value||'').replace(/(:|\s[-–—])\s+the\s+/gi,'$1 ');
const sameTitle=(a,b)=>title(a)===title(b)||title(dropSubtitleThe(a))===title(dropSubtitleThe(b));
// Recognize release decorations only; retain unknown annotations for review.
// The original filename is still checked for conflicting issue numbers.
const MONTH='(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
function publicationBasename(filename){
  let raw=String(filename||'').replace(/\.(cbz|cbr|zip|rar)$/i,'');
  // "Exiles_Days_of_Then_and_Now_(2008)_(Digital)": underscores stand for
  // spaces when the name has none of its own.
  if(!/\s/.test(raw)&&raw.includes('_'))raw=raw.replace(/_+/g,' ').replace(/\s+/g,' ').trim();
  // A leading story label "(prelude) Action Comics 598 (1988)" is not part of the title.
  raw=raw.replace(/^\(\s*(?:prelude|epilogue|tie[- ]?in|crossover)\s*\)\s*/i,'');
  // A group missing its ")" before the next group: "(Digital (Shadowcat-Empire)",
  // "(1970 (c2c)". Close it so the tags can be read.
  raw=raw.replace(/\(([^()[\]]+?)\s+\((?=[^()]*\))/g,'($1) (');
  // Marvel's "Minus 1" issues written in parentheses: "Cable (-1) (1997)".
  raw=raw.replace(/^(.*\S)\s+\(\s*(-1)\s*\)(?=\s*\((?:19|20)\d{2}\))/,'$1 $2');
  let base=stripIssueCount(raw)
    // "(Nov 2011)" and "(2011-11)" are dates; keep only the year.
    .replace(new RegExp('\\(\\s*'+MONTH+'\\s+((?:19|20)\\d{2})\\s*\\)','gi'),'($1)')
    .replace(/\(((?:19|20)\d{2})-(?:0[1-9]|1[0-2])\)/g,'($1)')
    // "Deathlok 016[1992-10]": a bracketed date, with or without a space.
    .replace(/\s*\[((?:19|20)\d{2})-(?:0[1-9]|1[0-2])\]/g,' ($1)')
    // Dated releases "The Ray, 1994-04-00 (_02)": the number is in "(_NN)",
    // the year in the date.
    .replace(/^(.+?),\s*((?:19|20)\d{2})-(?:0\d|1[0-2])-\d{2}\s*\(_(\d+)\)/,'$1 $3 ($2)');
  // A story title after the number: "Showcase v1 004 (1956) (c2c) - The Flash".
  // Only a title without digits, after a part that has the number, so
  // "Ghost Rider - Vengeance Unbound 76" and "X 001 - Part 2" are unchanged.
  base=base.replace(/^(.*\d.*?\S)\s+-\s+([^()[\]\d]+)$/,'$1');
  // Strip known scan/release tags from the end. Unknown trailing groups are kept
  // (they may name another issue). Spaces before a group are optional:
  // "Cosmic Boy 002(1987)(Digital)(TLK-EMPIRE-HD)".
  for(;;){
    const tail=/\s*(?:\(([^()[\]]+)\)|\[([^()[\]]+)\])$/.exec(base);
    if(!tail||tail.index===0)break;
    const value=(tail[1]||tail[2]).trim();
    // Scan groups: a known collective anywhere in the tag ("Minutemen-Faessla",
    // "AnPymGold - Empire", "Glorith-Novus-HD"); "(F)" is short for fixed.
    const known=/^(?:digital(?:[- ]hd)?|digital[- ]?rip|webrip|scan|scanned|rescan|c2c|noads|hd|fixed|f|repaired|\d+ covers?|\d{3,4}px|(?:[a-z0-9'.&]+\s*[- ]\s*)*(?:empire|dcp|minutemen|novus)(?:\s*[- ]\s*[a-z0-9'.&]+)*|[a-z0-9]+(?:[- ][a-z0-9]+)*-(?:hd|sd))$/i.test(value);
    // A scanner's handle after the (year): "(Flattermann)", "(Punkrat)".
    // One word, no digits, not an edition word, so "(Other #1)", "(Other
    // title)" and "(Variant)" still stop here.
    const handle=/^[a-z][a-z'.&-]*$/i.test(value)
      &&!/\b(?:variant|cut|edition|special|annual|preview|ashcan|facsimile|reprint|print(?:ing)?|cover|sketch|blank|virgin|deluxe|director'?s|giant|king|treasury|of)\b/i.test(value)
      &&/\(\s*(?:19|20)\d{2}\s*\)/.test(base.slice(0,tail.index));
    if(!known&&!handle)break;
    base=base.slice(0,tail.index);
  }
  return base;
}
// "Earth 2 - Society (2015-2016)": a run of years names the start year
// (208 library folders use a range; 2026-10-16).
function folderPublication(folderName){
  const m=/^([^()[\]]+?)(?:\s*\(((?:19|20)\d{2})(?:\s*-\s*(?:(?:19|20)\d{2}|present|current|ongoing)?)?\))?$/i.exec(String(folderName||'').trim());
  if(!m)return null;
  // Bare years without parentheses: "The Shadow 2012-2014", "James Bond 2017".
  // Only a 4-digit year (or range) at the very end after a space.
  if(!m[2]){const b=/^(.+?\S)\s+((?:19|20)\d{2})(?:\s*-\s*(?:19|20)\d{2})?$/.exec(m[1].trim());if(b&&+b[2]<=new Date().getFullYear()+1)return {name:b[1].trim(),year:b[2]};}
  return {name:m[1].trim(),year:m[2]||null};
}
function bookFolderName(book){return String(book?.path||'').split(/[\\/]/).slice(-2,-1)[0]||null;}
function publicationHint(filename,xml=null,folderName=null) {
  const ci=parseComicInfoEvidence(xml),one=key=>ci.fields[key]?.length===1?ci.fields[key][0]:null;
  const base=publicationBasename(filename);
  const mangaMatch=/^(.+?)\s+v(?:ol(?:ume)?)?\.?\s*(\d+)(?:\s*\(((?:19|20)\d{2})\))?$/i.exec(base);
  const manga=!!mangaMatch||/^yes/i.test(one('manga')||'');
  const m=mangaMatch||/^(.+?)\s+#?(0+-\d+|-?\d+(?:\.\d+)?(?:\.?[a-z]+)?|½)(?:\s*\(((?:19|20)\d{2})\))?$/i.exec(base);
  const bare=!m&&/^#?(0+-\d+|-?\d+(?:\.\d+)?(?:\.?[a-z]+)?|½)(?:\s*\(((?:19|20)\d{2})\))?$/i.exec(base);
  // "Batman v2 001" / "Batman Vol. 2 001": the volume marker is not part of the title.
  if(m&&!mangaMatch)m[1]=m[1].replace(/\s+v(?:ol(?:ume)?)?\.?\s*\d{1,2}$/i,'').replace(/\s+v\d{1,2}(?=\s)/i,'');
  // One-shot with no number ("Exiles Days of Then and Now (2008)", "Cable
  // King-Size Spectacular (2008)"): Comic Vine files these as issue #1 of a
  // volume with that exact title. Only when nothing else in the name looks like
  // an issue number.
  const oneShot=!manga&&!m&&!filenameEvidence(filename).candidates.length&&!/\d/.test(base.replace(/\s*\(((?:19|20)\d{2})\)$/,'').split(/\s+/).pop())
    &&/^([^#]*?[^\d\s#][^#]*?)\s*\(((?:19|20)\d{2})\)$/.exec(base);
  const filenameIssue=(m||bare||oneShot)&&parseIssueNumberEvidence(m?m[2]:bare?bare[1]:'1');
  const ciNumber=one('number')||(manga?one('volume'):null);
  const ciIssue=ciNumber&&parseIssueNumberEvidence(ciNumber);
  if(manga&&one('volume')&&ciIssue&&parseIssueNumberEvidence(one('volume')).normalized!==ciIssue.normalized)return null;
  if(ci.status==='invalid'||filenameEvidence(filename).requiresReview||filenameIssue?.requiresReview||ciIssue?.requiresReview)return null;
  let ciSeries=one('series');
  if(oneShot&&ciSeries&&title(oneShot[1])!==title(ciSeries))return null;
  if(m&&ciSeries&&title(m[1])!==title(ciSeries)){
    // A series label from another source (e.g. Comixology "1957 --Family Ties")
    // yields to the filename only when the folder name says the same thing and
    // the ComicInfo carries no Comic Vine identity of its own.
    const folderName0=folderPublication(folderName)?.name;
    if(ci.identity.ids.length||!folderName0||title(folderName0)!==title(m[1]))return null;
    ciSeries=null;
  }
  if(filenameIssue&&ciIssue&&filenameIssue.normalized!==ciIssue.normalized)return null;
  const folder=folderPublication(folderName);
  let fileName=ciSeries||m?.[1]||oneShot?.[1];
  const namedYear=(manga?null:one('volume'))||one('year')||m?.[3]||bare?.[2]||oneShot?.[2];
  // A filename with no year may abbreviate its folder's title ("Power Man 100"
  // in "Power Man and Iron Fist (1978)") or add a story subtitle ("Ghost Rider -
  // Vengeance Unbound 76" in "Ghost Rider (1990)"). The folder title and year
  // are used then; the number must still exist in that Comic Vine volume.
  if(m&&!ciSeries&&!namedYear&&folder?.year&&!ci.identity.ids.length){
    const t=title(m[1]),f=title(folder.name),story=title(m[1].split(/\s+-\s+/)[0]);
    if((f.startsWith(t+' '))||(/\s+-\s+/.test(m[1])&&story===f))fileName=folder.name;
  }
  // Folder evidence can fill missing fields, but never replace a different title.
  const supporting=folder&&(!fileName||title(fileName)===title(folder.name))?folder:null;
  const name=fileName||((bare||ciIssue)?supporting?.name:null),number=ciIssue?.normalized||filenameIssue?.normalized;
  const fileYear=namedYear;
  const year=fileYear||supporting?.year;
  if(!name||!number||!year||!/^\d{4}$/.test(year))return null;
  return {name,number,year,volumeYear:manga?null:one('volume')||(!fileYear?supporting?.year:null)||null,manga,annual:/\bannual\b/i.test(name)||/\bannual\b/i.test(one('format')||'')};
}
function candidateMatches(args) {
  // Annual files have their own corroboration rules (Phase 6.5).
  if(/\bannual\b/i.test(args?.filename||'')&&!parseComicInfoEvidence(args.comicInfoXml).identity.ids.length&&annualCandidateMatches(args))return true;
  const {filename,comicInfoXml,folderName,issue,volume}=args||{};
  const h=publicationHint(filename,comicInfoXml,folderName);
  if(!h||!parseCvIssueId(issue?.id)||parseCvIssueId(volume?.id)!==parseCvIssueId(issue?.volume?.id))return false;
  const n=parseIssueNumberEvidence(issue.issue_number);
  const issueYears=[String(volume.start_year||''),...['cover_date','store_date'].map(k=>String(issue[k]||'').slice(0,4))];
  const years=h.volumeYear?[String(volume.start_year||'')]:issueYears;
  // A ComicInfo <Volume> year from another scraper can be a year off (Comixology
  // "Morbius (2019)" vs Comic Vine 2020). Without a Comic Vine ID in the file,
  // the filename's own (year) may still corroborate the issue.
  const nameYear=/\(((?:19|20)\d{2})\)$/.exec(publicationBasename(filename))?.[1];
  const noFileIdentity=!parseComicInfoEvidence(comicInfoXml).identity.ids.length;
  // Cover dates run two or three months ahead of the on-sale date, so a file
  // dated by sale ("Azrael, 1994-12-00" = Azrael #1, cover February 1995)
  // carries the year before a January-March cover. Only without a CV ID in the file.
  const cover=/^((?:19|20)\d{2})-(\d{2})/.exec(String(issue.cover_date||''));
  const saleYear=!h.volumeYear&&noFileIdentity&&cover&&Number(cover[2])<=3&&String(Number(cover[1])-1)===h.year;
  // A continuation volume found for a folder whose own volume lacks the issue
  // keeps the folder volume's start year as the run's year.
  const continuesRun=args.relatedTitle===true&&!!args.parentStartYear&&String(args.parentStartYear)===h.year
    &&Number(volume.start_year)>=Number(args.parentStartYear);
  const yearAgrees=years.includes(h.year)||saleYear||continuesRun||(!!h.volumeYear&&!!nameYear&&noFileIdentity&&issueYears.includes(nameYear));
  // A related volume (Comic Vine files early Spectacular Spider-Man issues as
  // "Peter Parker, the Spectacular Spider-Man") must contain the whole title.
  const titleAgrees=sameTitle(volume.name,h.name)||(args.relatedTitle===true&&(' '+title(volume.name)+' ').includes(' '+title(h.name)+' '));
  return !n.requiresReview&&n.normalized===h.number&&titleAgrees&&yearAgrees&&h.annual===/\bannual\b/i.test(volume.name);
}
function isMangaPublication(filename,xml){
  const ci=parseComicInfoEvidence(xml);
  return ci.fields.manga?.some(v=>/^yes/i.test(v))||/\s+v(?:ol(?:ume)?)?\.?\s*\d+(?:\s*\((?:19|20)\d{2}\))?\.(?:cbz|cbr|zip|rar)$/i.test(filename||'');
}
module.exports={publicationHint,candidateMatches,isMangaPublication,folderPublication,bookFolderName,titleKey:title,sameTitle,dropSubtitleThe};
