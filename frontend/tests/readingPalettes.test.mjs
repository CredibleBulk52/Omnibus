import test from 'node:test';
import assert from 'node:assert/strict';
import {readingPalettes,identifyPalette,paletteTokens,contrast} from '../src/themes/readingPalettes.js';

test('every catalog identity resolves for a future list without IDs or metadata',()=>{
 for(const p of readingPalettes)assert.equal(identifyPalette(`${p.name}: Essential Reading`)?.name,p.name,p.name);
});
test('aliases and specific identities are recognized; mixed titles use artwork',()=>{
 for(const [title,name] of [['GREEN LANTERN: Hal Jordan','Green Lantern'],['Spider-Man: Miles Morales','Miles Morales'],['She Hulk','She-Hulk'],['Reverse Flash','Reverse-Flash'],['The Invincible Iron Man','Iron Man'],['Dr. Doom','Doctor Doom'],['Ra’s al Ghul','Ra’s al Ghul']])assert.equal(identifyPalette(title)?.name,name);
 for(const title of ['',null,'Superman / Batman','Captain Marvel','Supermanship','The Sandman'])assert.equal(identifyPalette(title),null,String(title));
});
test('all generated text and button pairs meet 4.5:1 contrast',()=>{
 for(const palette of [...readingPalettes,null,{main:'#ffffff',secondary:'#777777',highlight:'#000000'},{main:'#000000',secondary:'#000000',highlight:'#ffffff'}]){
  const t=paletteTokens(palette);
  for(const [fg,bg] of [['on-banner','banner'],['on-button','button'],['on-accent','accent'],['text','panel'],['muted','panel'],['accent','panel'],['text','bg'],['muted','bg'],['accent','bg']])assert.ok(contrast(t[`--rl-theme-${fg}`],t[`--rl-theme-${bg}`])>=4.5,`${palette?.name}: ${fg}/${bg}`);
 }
});

test('Batman and Robin is a named duo without swallowing other crossovers',()=>{
 for(const title of ['Batman and Robin','Batman & Robin (2009)','Batman/Robin',
  'Batman and Robin Eternal','Robin & Batman (2022)','All-Star Batman & Robin, the Boy Wonder']){
  assert.equal(identifyPalette(title)?.name,'Batman and Robin',title);
 }
 assert.equal(identifyPalette('Batman: Essential Reading')?.name,'Batman');
 assert.equal(identifyPalette('Robin: Essential Reading')?.name,'Robin');
 for(const title of ['Batman and Robin / Superman','Batman and Robin / Nightwing',
  'Batman / Superman'])assert.equal(identifyPalette(title),null,title);
 assert.equal(identifyPalette('Batman and Robins')?.name,'Batman');
});

test('every accepted alias resolves, including Kate Bishop without the unrelated X-Man',()=>{
 for(const palette of readingPalettes)for(const alias of palette.aliases)
  assert.equal(identifyPalette(alias)?.name,palette.name,alias);
 assert.equal(identifyPalette('Hawkeye: Kate Bishop')?.name,'Hawkeye');
 assert.equal(identifyPalette('Kate Bishop / Bishop'),null);
});

test('expanded identities handle legacy bearers and team-name overlaps',()=>{
 for(const [title,name] of [
  ['Batwoman: Elegy','Batwoman'],['Hellblazer','John Constantine / Hellblazer'],
  ['Shadowcat: Essential Reading','Kitty Pryde / Shadowcat'],['Static Shock','Static'],
  ['Blue Beetle','Blue Beetle'],['Blue Beetle: Jaime Reyes','Blue Beetle'],
  ['Blue Beetle: Ted Kord','Blue Beetle (Ted Kord)'],
  ['Nova','Nova (Richard Rider)'],['Nova: Richard Rider','Nova (Richard Rider)'],
  ['Nova: Sam Alexander','Nova (Sam Alexander)'],
  ['Green Lantern Corps: Recharge','Green Lantern Corps'],
  ['JSA','Justice Society of America'],['Legion of Superheroes','Legion of Super-Heroes'],
  ['Uncanny X-Force','X-Force'],['X Factor Investigations','X-Factor'],
  ['Mighty Morphin Power Rangers','Power Rangers'],['Walking Dead','The Walking Dead'],
 ])assert.equal(identifyPalette(title)?.name,name,title);
 for(const title of ['Ted Kord / Jaime Reyes','Nova: Richard Rider and Sam Alexander',
  'Green Lantern Corps / Hal Jordan','Green Lantern / Green Lantern Corps',
  'Raven / Starfire','Justice Society / Justice League',
  'A Question of Justice','Alias','The Legion'])assert.equal(identifyPalette(title),null,title);
});

test('library aliases and explicit partnerships resolve without swallowing crossovers',()=>{
 for(const [title,name] of [
  ['Action Comics (2016)','Superman'],['Detective Comics','Batman'],['JLA Year One','Justice League'],
  ['Legionnaires','Legion of Super-Heroes'],['Robin - Son of Batman','Robin'],
  ['Batman & the Outsiders','Outsiders'],['Batgirl and the Birds of Prey','Birds of Prey'],
  ['Hal Jordan and the Green Lantern Corps','Green Lantern Corps'],
  ['Power Man & Iron Fist','Power Man and Iron Fist'],['Cable & Deadpool','Cable and Deadpool'],
  ['Rogue & Gambit','Rogue and Gambit'],['Star Wars: Darth Vader','Darth Vader'],
  ['Star Wars: Doctor Aphra','Doctor Aphra'],['Hellboy The Storm','Hellboy'],
  ['Hellboy and the B.P.R.D. Night of the Cyclops','Hellboy'],
 ])assert.equal(identifyPalette(title)?.name,name,title);
 for(const title of ['Scooby Apocalypse','The Wild Storm','Rogue One','Chew','Saga',
  'Batman and Robin / Bruce Wayne','Rogue & Gambit / Storm','Star Wars: Darth Vader / Doctor Aphra',
  'Action Comics / Batman','Batman and the Outsiders / Superman'])assert.equal(identifyPalette(title),null,title);
 assert.equal(identifyPalette('Star Wars Rogue One - Jyn Erso')?.name,'Star Wars');
 assert.equal(identifyPalette('The Wild Storm / Storm')?.name,'Storm');
 assert.equal(identifyPalette('Scooby Apocalypse / Apocalypse')?.name,'Apocalypse');
});

test('catalog identities and aliases remain unique and well-formed',()=>{
 assert.equal(new Set(readingPalettes.map(p=>p.name)).size,readingPalettes.length);
 const aliases=new Set();
 for(const p of readingPalettes){
  for(const key of ['main','secondary','highlight'])assert.match(p[key],/^#[0-9a-f]{6}$/i);
  for(const alias of p.aliases){assert.ok(!aliases.has(alias),alias);aliases.add(alias);}
 }
});
