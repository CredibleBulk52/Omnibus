import { currentColors } from '../components/appearance.js';   // extensions: Node runs this file in tests/readingPalettes.test.mjs
import { characterColors as definitions } from './characterColors.js';
export const normalizeTitle=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export const readingPalettes=definitions.map(([name,main,secondary,highlight,aliases])=>({name,main,secondary,highlight,aliases:aliases.split('|')}));
export function identifyPalette(title){
 const words=' '+normalizeTitle(title)+' ';
 // Suppress misleading words only inside known unrelated titles. A separate
 // character mention outside that phrase must still count as a crossover.
 const exclusions={Apocalypse:['scooby apocalypse'],Rogue:['rogue one'],Storm:['the wild storm','hellboy the storm'],Cyclops:['night of the cyclops']};
 const matches=[];
 for(const p of readingPalettes){
   const masked=(exclusions[p.name]||[]).reduce((s,phrase)=>s.replaceAll(phrase,' '.repeat(phrase.length)),words);
   for(const alias of p.aliases){
     let from=0,index;
     while((index=masked.indexOf(' '+alias+' ',from))!==-1){matches.push({name:p.name,start:index+1,end:index+1+alias.length});from=index+1;}
   }
 }
 // Long explicit titles consume only their own overlapping shorter aliases.
 // E.g. Robin: Son of Batman resolves to Robin, but adding Superman stays mixed.
 const names=new Set(matches.filter(m=>!matches.some(other=>other.start<=m.start&&other.end>=m.end&&(other.start<m.start||other.end>m.end))).map(m=>m.name));
 let found=readingPalettes.filter(p=>names.has(p.name));
 // Kate's surname is not the X-Man. An independently named Bishop still counts.
 if(words.includes(' kate bishop ')&&!words.replace(/ kate bishop /g,' ').includes(' bishop '))found=found.filter(p=>p.name!=='Bishop');
 // This is Iron Man's series title, not a crossover with Invincible.
 if(words.includes(' invincible iron man '))found=found.filter(p=>p.name!=='Invincible');
 // Franchise subtitles may name a specific identity; retain other identities.
 if(found.some(p=>['Darth Vader','Doctor Aphra'].includes(p.name)))found=found.filter(p=>p.name!=='Star Wars');
 // A named legacy bearer beats the default only when the other bearer is absent.
 if(found.some(p=>p.name==='Blue Beetle (Ted Kord)')&&!words.includes(' jaime reyes '))found=found.filter(p=>p.name!=='Blue Beetle');
 if(found.some(p=>p.name==='Nova (Sam Alexander)')&&!words.includes(' richard rider '))found=found.filter(p=>p.name!=='Nova (Richard Rider)');
 // "Green Lantern" occurs inside the team name. Keep any separately named Lantern
 // as a real mixed identity instead of swallowing that additional match.
 if(found.some(p=>p.name==='Green Lantern Corps')){
   const remainder=words.replace(/ green lantern corps /g,' ');
   const lantern=readingPalettes.find(p=>p.name==='Green Lantern');
   if(!lantern.aliases.some(a=>remainder.includes(' '+a+' ')))found=found.filter(p=>p.name!=='Green Lantern');
 }
 // Specific alter egos and compound names override their generic title.
 const overrides={'Miles Morales':['Spider-Man'],'Scarlet Spider':['Spider-Man'],'Spider-Gwen':['Spider-Man'],'She-Hulk':['Hulk'],'Reverse-Flash':['Flash']};
 const ignored=new Set(found.flatMap(p=>overrides[p.name]||[]));
 found=found.filter(p=>!ignored.has(p.name));
 // A title explicitly naming several characters is a mixed list, not a guess.
 return found.length===1?found[0]:null;
}
const rgb=hex=>hex.replace('#','').match(/../g).map(x=>parseInt(x,16));
const hex=values=>'#'+values.map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');
export const mix=(a,b,amount)=>hex(rgb(a).map((v,i)=>v*(1-amount)+rgb(b)[i]*amount));
const luminance=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
export function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const inkFor=bg=>contrast('#ffffff',bg)>=contrast('#000000',bg)?'#ffffff':'#000000';
function readable(color,background){let value=color;for(let i=0;i<30&&contrast(value,background)<4.5;i++)value=mix(value,'#ffffff',.12);return value;}
// The user's own scheme as a reading palette (used when page colours are switched off).
export function schemePalette(rootColors){const c=rootColors||currentColors();return {main:c.secondary,secondary:c.action||c.secondary,highlight:c.highlight};}
export function paletteTokens(palette,rootColors){
 const p=palette||{main:'#617b91',secondary:'#435568',highlight:'#bdd4e4'};
 // Foundations follow the user's base and text colours (components/appearance.js);
 // identity belongs to accents and banners.
 const root=rootColors||currentColors(),panel=root.base,surface=mix(root.base,'#000000',.3);
 // Darken banners enough that one light foreground also works over their dots.
 let banner=p.main;for(let i=0;i<30&&contrast('#f5f7f2',banner)<4.8;i++)banner=mix(banner,'#101510',.1);
 const accent=readable(p.highlight,panel),text=root.text,muted=mix(root.text,root.base,.25),line=mix(root.base,'#ffffff',.15);
 // The accent as lettering on the button and banner colours (2026-10-28): the accent where it reads
 // (3:1, large comic lettering), else plain ink. X-Men's yellow button with a yellow accent was blank.
 const onButtonAccent=contrast(accent,p.secondary)>=3?accent:inkFor(p.secondary),bannerAccent=contrast(accent,banner)>=3?accent:'#f5f7f2';
 return {'--rl-theme-on-button-accent':onButtonAccent,'--rl-theme-banner-accent':bannerAccent,'--rl-theme-bg':surface,'--rl-theme-panel':panel,'--rl-theme-banner':banner,'--rl-theme-on-banner':'#f5f7f2','--rl-theme-accent':accent,'--rl-theme-on-accent':inkFor(accent),'--rl-theme-button':p.secondary,'--rl-theme-on-button':inkFor(p.secondary),'--rl-theme-text':text,'--rl-theme-muted':muted,'--rl-theme-line':line,'--rl-theme-main':p.main,'--rl-theme-main-rgb':rgb(p.main).join(', '),'--cover-rgb':rgb(accent).join(', ')};
}

