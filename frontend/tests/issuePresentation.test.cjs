const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const babel=require('@babel/core');
global.DOMParser=new JSDOM('').window.DOMParser;
const moduleUnderTest={exports:{}};
new Function('exports',babel.transformSync(fs.readFileSync(require.resolve('../src/components/issuePresentation.js'),'utf8'),{plugins:[require.resolve('@babel/plugin-transform-modules-commonjs')]}).code)(moduleUnderTest.exports);
const {issueText,uniqueCredits,issueSummary}=moduleUnderTest.exports;
test('decodes nested entities and preserves paragraph separation without markup',()=>{
 assert.equal(issueText('<p>Jos&amp;#233;</p><p>Next &amp; final.</p>'),'José\nNext & final.');
 assert.equal(issueText('<script>bad()</script>Hello'),'Hello');
});
test('deduplicates creators within a role',()=>assert.equal(uniqueCredits('Nick Dragotta, Nick Dragotta, Jos&#233; Villarrubia'),'Nick Dragotta, José Villarrubia'));
test('separates explicit cover appendix without losing its text',()=>{
 const value='Story. List of covers and their creators: A &amp; B';
 const result=issueSummary(value);
 assert.equal(result.story,'Story.'); assert.equal(result.supplement,'List of covers and their creators: A & B');
 assert.equal(issueSummary('A story about covers.').story,'A story about covers.');
});
