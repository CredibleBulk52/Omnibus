'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {publicationHint,candidateMatches}=require('./candidate');
const {decideIdentity}=require('./identity');
const {planBookMetadata}=require('./metadataService');
const {applyComicInfoPlan}=require('./comicInfoPatch');
const {parseComicInfoEvidence}=require('./evidence');
const issue={id:'123',issue_number:'2',volume:{id:'10'},cover_date:'2026-04-01'};
const volume={id:'10',name:'Example',start_year:'2025',publisher:{name:'Publisher'}};
test('provider candidate needs full title, exact number and corroborating year',()=>{
 const base={filename:'Example 002 (2026).cbz',issue,volume};assert.equal(candidateMatches(base),true);
 for(const filename of ['Other 002 (2026).cbz','Example 002b (2026).cbz','Example 002 (2026) (Other #1).cbz','Example 002-003 (2026).cbz','Example 002.cbz','Example 002 (1988).cbz','Example Annual 002 (2026).cbz'])assert.equal(candidateMatches({...base,filename}),false,filename);
 assert.equal(candidateMatches({...base,issue:{...issue,issue_number:'2.1'}}),false);assert.equal(candidateMatches({...base,volume:{...volume,id:'11'}}),false);
});
test('embedded publication disagreement cannot be bypassed by a filename or folder hint',()=>{
 assert.equal(publicationHint('Example 002 (2026).cbz','<ComicInfo><Series>Other</Series><Number>2</Number></ComicInfo>'),null);
 const input={bookId:'one',arrival:'import',filename:'Other 002 (2026).cbz',folderMetadata:{name:'Example',comicid:'10'},candidate:{issue,volume}};
 assert.notEqual(decideIdentity(input).status,'accepted');
 assert.equal(decideIdentity({...input,filename:'Example 002 (2026).cbz'}).cvIssueId,'123');
});
for(const currentXml of [null,'<ComicInfo/>','<ComicInfo><Web>https://example.org/book</Web><Notes>Personal note</Notes><Extra flag="yes">keep</Extra><Pages><Page Image="0"/></Pages></ComicInfo>'])test('initial identity patch preserves existing XML and is repeatable: '+String(currentXml).slice(0,35),()=>{
 const metadata=planBookMetadata({bookId:'one',arrival:'import',filename:'Example.cbz',explicitIssueId:'123',currentXml,source:{issue,volume}});
 const first=applyComicInfoPlan({...metadata,currentXml});assert.equal(parseComicInfoEvidence(first.xml).identity.cvIssueId,'123');
 if(currentXml?.includes('Personal note')){assert.ok(first.xml.includes('<Notes>Personal note</Notes>'));assert.ok(first.xml.includes('https://example.org/book'));assert.equal((first.xml.match(/<Web>/g)||[]).length,1);assert.ok(first.xml.includes('<Pages><Page Image="0"/></Pages>'));}
 const next=planBookMetadata({bookId:'one',filename:'Example.cbz',currentXml:first.xml,source:{issue,volume}});
 assert.equal(applyComicInfoPlan({...next,currentXml:first.xml}).xml,first.xml);
});
test('an explicit issue corrects a conflicting identity instead of initializing beside it',()=>{
 const currentXml='<ComicInfo><Notes>CVDB999</Notes></ComicInfo>';
 const metadata=planBookMetadata({bookId:'one',filename:'Example.cbz',currentXml,explicitIssueId:'123',source:{issue,volume}});
 assert.equal(metadata.plan.identityCorrection,true);
 const out=applyComicInfoPlan({...metadata,currentXml});assert.match(out.xml,/CVDB123/);assert.doesNotMatch(out.xml,/999/);
});
test('manga candidate uses the numbered volume and actual year without accepting ranges or a title substring',()=>{
 const base={filename:'Example v002 (2026).cbz',issue,volume};assert.equal(candidateMatches(base),true);
 assert.equal(candidateMatches({...base,comicInfoXml:'<ComicInfo><Series>Example</Series><Volume>002</Volume><Year>2026</Year><Manga>YesAndRightToLeft</Manga></ComicInfo>'}),true);
 for(const filename of ['Other Example v002 (2026).cbz','Example v002-003 (2026).cbz','Example v002.cbz','Example v003 (2026).cbz'])assert.equal(candidateMatches({...base,filename}),false,filename);
 assert.equal(candidateMatches({...base,comicInfoXml:'<ComicInfo><Number>2</Number><Volume>3</Volume></ComicInfo>'}),false);
});
test('shared manga merge preserves ordinal volume, reading direction and personal metadata on later refresh',()=>{
 const currentXml='<ComicInfo><Series>Example</Series><Volume>002</Volume><Year>2026</Year><Manga>YesAndRightToLeft</Manga><Notes>Personal note</Notes></ComicInfo>';
 const request={bookId:'one',filename:'Example v002 (2026).cbz',currentXml,candidate:{issue,volume},source:{issue,volume},profile:'manga'};
 const metadata=planBookMetadata(request),first=applyComicInfoPlan({...metadata,currentXml});
 assert.match(first.xml,/<Volume>002<\/Volume>/);assert.match(first.xml,/<Manga>YesAndRightToLeft<\/Manga>/);assert.match(first.xml,/Personal note/);assert.match(first.xml,/<Number>2<\/Number>/);
 const refresh=planBookMetadata({...request,currentXml:first.xml,profile:null});assert.equal(applyComicInfoPlan({...refresh,currentXml:first.xml}).xml,first.xml);
});


test('folder title and start year fill missing filename evidence without overriding file details',()=>{
 const {bookFolderName}=require('./candidate');
 assert.equal(bookFolderName({path:'/comics/Example (2025)/002.cbz'}),'Example (2025)');
 assert.equal(bookFolderName({path:'D:\\Comics\\Example (2025)\\002.cbz'}),'Example (2025)');
 for(const filename of ['002.cbz','Example 002.cbz','002 (Digital) (Zone-Empire).cbz']){
  const input={filename,folderName:'Example (2025)',issue,volume};assert.equal(candidateMatches(input),true,filename);
  assert.equal(candidateMatches({...input,volume:{...volume,start_year:'2026'}}),false,'folder year must be volume start year');
 }
 assert.equal(candidateMatches({filename:'002 (2026).cbz',folderName:'Example',issue,volume}),true);
 assert.equal(candidateMatches({filename:'Example 002 (2026).cbz',folderName:'Example (2025)',issue,volume}),true,'issue and volume years can differ');
 assert.equal(publicationHint('Other 002.cbz',null,'Example (2025)'),null);
 assert.equal(publicationHint('002-003.cbz',null,'Example (2025)'),null);
 assert.equal(publicationHint('Example Annual 002.cbz',null,'Example (2025)'),null);
 assert.equal(publicationHint('002.cbz','<ComicInfo><Number>3</Number></ComicInfo>','Example (2025)'),null);
 // A misplaced folder cannot defeat complete independent publication evidence.
 assert.equal(candidateMatches({filename:'Example 002 (2026).cbz',folderName:'Other (1999)',issue,volume}),true);
});
test('folder-supported identity survives shared metadata planning and records its evidence',()=>{
 const request={bookId:'folder-book',filename:'002.cbz',folderName:'Example (2025)',currentXml:null,candidate:{issue,volume},source:{issue,volume}};
 const plan=planBookMetadata(request);assert.equal(plan.cvIssueId,'123');
 assert.throws(()=>planBookMetadata({...request,folderName:'Other (2025)'}),e=>e.code==='IDENTITY_REVIEW_REQUIRED');
});

test('story titles after the number and scanner handles after the year still give a hint (Showcase pack, 2026-10-15)', () => {
  const hint = f => { const h = publicationHint(f, null, null); return h ? `${h.name}|${h.number}|${h.year}` : null; };
  assert.equal(hint('Showcase v1 001 (1956) (c2c) (Flattermann) - Fire Fighters.cbr'), 'Showcase|1|1956');
  assert.equal(hint('Showcase v1 015 (1958) (Punkrat) - Space Ranger.cbr'), 'Showcase|15|1958');
  assert.equal(hint('Showcase v1 053 (1964) - GI Joe.cbz'), 'Showcase|53|1964');
  // Unchanged: digits in the title, edition or two-word groups.
  for (const f of ['Showcase v1 093 (1970) - Manhunter 2070.cbr', 'X 001 (2020) - Part 2.cbz', "Example 002 (2026) (Director's Cut).cbz",
    'Example 002 (2026) (Variant).cbz', 'Example 002 (2026) (Other title).cbz'])
    assert.equal(hint(f), null, f);
});

test('unclosed tag groups and "(-1)" issue numbers still give a hint (sweeper, 2026-10-15)', () => {
  const hint = f => { const h = publicationHint(f, null, null); return h ? `${h.name}|${h.number}|${h.year}` : null; };
  assert.equal(hint('Doctor Strange 067 (1984) (Digital (Shadowcat-Empire).cbz'), 'Doctor Strange|67|1984');
  assert.equal(hint('Cable (-1) (1997) (Digital) (Shadowcat-Empire).cbz'), 'Cable|-1|1997');
  assert.equal(hint('Captain America 016.NOW (2014) (Digital) (Zone-Empire).cbz'), 'Captain America|16.NOW|2014');
  assert.equal(hint('Cable (1) (1997).cbz'), null);   // only Minus 1 is read out of parentheses
});

// "Earth 2 - Society (2015-2016)": a folder with a run of years gives its start year (2026-10-16).
test('folder year ranges supply the start year', () => {
  const { publicationHint } = require('./candidate');
  const h = publicationHint('Earth 2 - Society 010.cbz', null, 'Earth 2 - Society (2015-2016)');
  assert.equal(h.name, 'Earth 2 - Society'); assert.equal(h.number, '10'); assert.equal(h.year, '2015');
  assert.equal(publicationHint('X 001.cbz', null, 'X (2019-)').year, '2019');
  assert.equal(publicationHint('X 001.cbz', null, 'X'), null);
});

// Bare folder years (2026-10-16): "The Shadow 2012-2014", "James Bond 2017"; "Spider-Man 2099" is a title.
test('folder years without parentheses', () => {
  const { publicationHint } = require('./candidate');
  assert.equal(publicationHint('The Shadow 001.cbz', null, 'The Shadow 2012-2014').year, '2012');
  assert.equal(publicationHint('James Bond 006.cbz', null, 'James Bond 2017').year, '2017');
  assert.equal(publicationHint('Spider-Man 2099 005.cbz', null, 'Spider-Man 2099'), null);
});
