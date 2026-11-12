import * as m_themes_characterColors from '../themes/characterColors';
import * as m_themes_readingPalettes from '../themes/readingPalettes';
import * as m_appearance from './appearance';
import { DEFAULT_COLORS, PRESETS, checkColors, contrast, readableOn, setAppearance, getAppearance, clearAppearance } from './appearance';

test('every preset is readable', () => {
  for (const p of PRESETS) { expect(contrast(p.colors.text,p.colors.base)).toBeGreaterThanOrEqual(4.5); expect(contrast(p.colors.highlight,p.colors.base)).toBeGreaterThanOrEqual(3); }
});
test('readableOn lifts dark text on a dark base', () => {
  const fixed = readableOn('#222222', DEFAULT_COLORS.base);
  expect(contrast(fixed, DEFAULT_COLORS.base)).toBeGreaterThanOrEqual(4.5);
});
test('setting colours writes the root variables; defaults and sign-out clear them', () => {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  setAppearance({ colors: { ...DEFAULT_COLORS, highlight: '#3ddc97' } }, { save: false });
  expect(document.documentElement.style.getPropertyValue('--om-highlight')).toBe('#3ddc97');
  expect(document.documentElement.style.getPropertyValue('--om-base')).toBe('');
  setAppearance({ colors: { ...DEFAULT_COLORS } }, { save: false });
  expect(getAppearance().colors).toBeNull();
  setAppearance({ colors: { ...DEFAULT_COLORS, base: '#0d1424' }, pageColors: false }, { save: false });
  clearAppearance();
  expect(document.documentElement.style.getPropertyValue('--om-base')).toBe('');
  expect(getAppearance().pageColors).toBe(true);
});

test('curated character skins support text on both backgrounds and buttons', () => {
  const skins = PRESETS.filter(p => p.group === 'all');
  expect(skins).toHaveLength(10);
  expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
  for (const p of skins) {
    expect(contrast(p.colors.text,p.colors.base)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.colors.highlight,p.colors.base)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.colors.bannerText,p.colors.secondary)).toBeGreaterThanOrEqual(3);
  }
});
test('readability warnings catch a highlight that only works on the page background', () => {
  expect(checkColors({base:'#080808',text:'#ffffff',secondary:'#31589d',highlight:'#da5959'}).some(p=>p.key==='secondary')).toBe(true);
});
test('character-page color edits do not regenerate skins or overwrite saved choices', () => {
  const { characterColors } = m_themes_characterColors;
  const row = characterColors.find(r=>r[0]==='Iron Man'), original = row[3];
  const skin = PRESETS.find(p=>p.id==='iron-man');
  const before = {...skin.colors};
  try {
    setAppearance({colors:{...DEFAULT_COLORS,highlight:'#abcdef'}},{save:false});
    row[3]='#00ff00';
    expect(skin.colors).toEqual(before);
    expect(getAppearance().colors.highlight).toBe('#abcdef');
  } finally { row[3]=original; clearAppearance(); }
});
test('revised character pages retain readable banner, button and accent foregrounds', () => {
  const { identifyPalette, paletteTokens } = m_themes_readingPalettes;
  for (const name of ['Captain America','Deadpool','Iron Man','X-Men','Flash']) {
    const p = identifyPalette(name);
    expect(p.name).toBe(name);
    const t=paletteTokens(p,DEFAULT_COLORS);
    expect(contrast(t['--rl-theme-on-banner'],t['--rl-theme-banner'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--rl-theme-on-button'],t['--rl-theme-button'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--rl-theme-accent'],t['--rl-theme-panel'])).toBeGreaterThanOrEqual(4.5);
  }
});
test('optional actions preserve legacy colors, survive loading and clear on reset', async () => {
  const {actionColor,actionInk,loadAppearance,sameColors}=m_appearance;
  clearAppearance();
  expect(actionColor(DEFAULT_COLORS)).toBe(DEFAULT_COLORS.secondary);
  expect(actionInk(DEFAULT_COLORS)).toBe(DEFAULT_COLORS.highlight);
  const colors={...DEFAULT_COLORS,action:'#ffcf26'};
  setAppearance({colors},{save:false});
  expect(getAppearance().colors).toEqual(colors);
  expect(document.documentElement.style.getPropertyValue('--om-action')).toBe('#ffcf26');
  expect(contrast(actionInk(colors),colors.action)).toBeGreaterThanOrEqual(4.5);
  expect(sameColors(colors,DEFAULT_COLORS)).toBe(false);
  global.fetch=vi.fn(async()=>({ok:true,json:async()=>({colors,pageColors:false})}));
  await loadAppearance('action-test');
  expect(getAppearance().colors.action).toBe('#ffcf26');
  const {schemePalette}=m_themes_readingPalettes;
  expect(schemePalette(colors).secondary).toBe('#ffcf26');
  setAppearance({colors:DEFAULT_COLORS},{save:false});
  expect(document.documentElement.style.getPropertyValue('--om-action')).toBe('');
  expect(document.documentElement.style.getPropertyValue('--om-on-action')).toBe('');
  clearAppearance();
});
test('all revised actions have readable foregrounds',()=>{
 const {actionColor,actionInk}=m_appearance;
 for(const p of PRESETS.filter(p=>p.colors.action)) expect(contrast(actionInk(p.colors),actionColor(p.colors))).toBeGreaterThanOrEqual(4.5);
});

test('motifs persist independently of colors, toggle off and clear on sign-out',async()=>{
 const {loadAppearance}=m_appearance;
 const skin=PRESETS.find(p=>p.id==='x-men');
 setAppearance({colors:skin.colors,themeId:skin.id,decorations:true},{save:false});
 expect(document.documentElement.dataset.characterTheme).toBe('x-men');
 expect(document.documentElement.style.getPropertyValue('--om-banner-text')).toBe(skin.colors.bannerText);
 expect(JSON.parse(localStorage.getItem('omnibus.appearance')).themeId).toBe('x-men');
 setAppearance({decorations:false},{save:false});
 expect(document.documentElement.dataset.characterTheme).toBeUndefined();
 expect(getAppearance().colors).toEqual(skin.colors);
 global.fetch=vi.fn(async()=>({ok:true,json:async()=>({colors:skin.colors,themeId:'x-men',decorations:true})}));
 await loadAppearance('motif-account');
 expect(document.documentElement.dataset.characterTheme).toBe('x-men');
 clearAppearance();
 expect(getAppearance().themeId).toBeNull();
 expect(document.documentElement.dataset.characterTheme).toBeUndefined();
 expect(document.documentElement.style.getPropertyValue('--om-banner-text')).toBe('');
});
test('the launch collection replaces all old preset menus without coercing saved colors',()=>{
 expect(PRESETS.map(p=>p.id)).toEqual(['superman','batman','green-lantern','harley-quinn','joker','captain-america','iron-man','hulk','x-men','fantastic-four']);
 setAppearance({colors:{...DEFAULT_COLORS,secondary:'#6d28d9'},themeId:'dark-age'},{save:false});
 expect(getAppearance().themeId).toBeNull();
 expect(getAppearance().colors.secondary).toBe('#6d28d9');
 clearAppearance();
});