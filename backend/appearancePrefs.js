// Theme ids are checked for shape only; the list of themes lives in one place, the frontend's
// themes/characterThemes.js, which also ignores an id it does not know (components/appearance.js).
const THEME_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX=/^#[0-9a-fA-F]{6}$/;
function cleanAppearance(body) {
 const out={colors:null,pageColors:body?.pageColors!==false};
 if(body?.themeId!==undefined)out.themeId=typeof body.themeId==='string'&&body.themeId.length<=40&&THEME_ID.test(body.themeId)?body.themeId:null;
 if(body?.decorations!==undefined){if(typeof body.decorations!=='boolean')return null;out.decorations=body.decorations;}
 // Admins: the ⓘ AI cost details and the AI activity feed (2026-11-09); on unless switched off.
 if(body?.aiInfo!==undefined){if(typeof body.aiInfo!=='boolean')return null;out.aiInfo=body.aiInfo;}
 if(body?.colors && typeof body.colors==='object') {
  const colors={};
  for(const k of ['base','secondary','highlight','text']) {
   if(typeof body.colors[k]!=='string'||!HEX.test(body.colors[k]))return null;
   colors[k]=body.colors[k].toLowerCase();
  }
  if(body.colors.action!==undefined) {
   if(typeof body.colors.action!=='string'||!HEX.test(body.colors.action))return null;
   colors.action=body.colors.action.toLowerCase();
  }
  if(body.colors.bannerText!==undefined) {
   if(typeof body.colors.bannerText!=='string'||!HEX.test(body.colors.bannerText))return null;
   colors.bannerText=body.colors.bannerText.toLowerCase();
  }
  out.colors=colors;
 }
 return out;
}
module.exports={cleanAppearance};
