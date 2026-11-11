const test=require('node:test'),assert=require('node:assert/strict');
const {cleanAppearance}=require('./appearancePrefs');
const colors={base:'#101010',secondary:'#223344',highlight:'#ffffff',text:'#eeeeee'};
test('legacy appearance remains unchanged and optional action survives persistence validation',()=>{
 assert.deepEqual(cleanAppearance({colors,pageColors:false}),{colors,pageColors:false});
 assert.deepEqual(cleanAppearance({colors:{...colors,action:'#AABBCC'}}).colors,{...colors,action:'#aabbcc'});
 assert.deepEqual(cleanAppearance({colors:null}),{colors:null,pageColors:true});
});
test('invalid optional action values are rejected without weakening required color validation',()=>{
 for(const action of [null,123,'red','#abc','#123456;'])assert.equal(cleanAppearance({colors:{...colors,action}}),null);
 assert.equal(cleanAppearance({colors:{...colors,base:'bad',action:'#ffffff'}}),null);
});

test('theme motifs and banner lettering are validated and survive round-trip',()=>{
 const themed={colors:{...colors,bannerText:'#AABBCC'},themeId:'hulk',decorations:false};
 assert.deepEqual(cleanAppearance(themed),{...themed,pageColors:true,colors:{...colors,bannerText:'#aabbcc'}});
 for(const themeId of ['Bad Theme!','../x',123,'x'.repeat(41)])assert.equal(cleanAppearance({...themed,themeId}).themeId,null);
 assert.equal(cleanAppearance({...themed,themeId:'new-theme'}).themeId,'new-theme');   // the frontend's list decides
 assert.equal(cleanAppearance({...themed,decorations:'yes'}),null);
 assert.equal(cleanAppearance({...themed,colors:{...colors,bannerText:'url(bad)'}}),null);
});
