// Intentional app-wide themes; independent of reading-page character palettes.
// Public names describe the look, not a character (2026-11-12). Ids stay as they were so
// saved choices and a local ThemeArtwork.local.jsx keep working. `character` is only used
// to find art an admin uploaded (Library › Branding, kind "character") for the banner.
export const characterThemes = [
  ['superman','Daybreak','Superman','#091321','#1657b8','#cf2337','#ffdc43','#f4f5f7','#ffdc43'],
  ['batman','Night Watch','Batman','#0b0d13','#25364c','#182131','#f6cf4a','#eceef2','#f6cf4a'],
  ['green-lantern','Emerald Light','Green Lantern','#081610','#087447','#17a45f','#c5ffae','#edf8ef','#d7ffc9'],
  ['harley-quinn','Harlequin','Harley Quinn','#120e12','#c91d38','#17151b','#fff1ed','#f7f0ef','#fff1ed'],
  ['joker','Wild Card','Joker','#120d1b','#64308e','#a2dd34','#b4ee43','#f3f0e8','#b4ee43'],
  ['captain-america','Old Glory','Captain America','#0b1422','#17457f','#c62136','#ff4357','#f5f8ff','#ffffff'],
  ['iron-man','Red & Gold','Iron Man','#151011','#a31e2b','#e9b849','#ffd778','#f9eee0','#ffd778'],
  ['hulk','Gamma','Hulk','#0e160f','#68ad31','#64308e','#c3ed83','#f0f3e8','#4a1869'],
  ['x-men','Blue & Gold','X-Men','#0b1325','#ffd52e','#214ca6','#8eb9ff','#f2f6ff','#163574'],
  ['fantastic-four','Cosmic Blue','Fantastic Four','#0a1725','#0868ae','#e8f5ff','#e8f5ff','#f4f9ff','#ffffff'],
].map(([id,name,character,base,secondary,action,highlight,text,bannerText])=>({
  id,name,character,group:'all',colors:{base,secondary,action,highlight,text,bannerText}
}));
