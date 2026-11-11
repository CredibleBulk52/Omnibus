import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionPresentation, editableCollectionRules } from '../src/pages/collectionPresentation.mjs';
test('separates date range but preserves other title parentheses',()=>{
  assert.equal(collectionPresentation({name:'The Golden Age (1937 to 1986)'}).dates,'1937–1986');
  assert.equal(collectionPresentation({name:'Batman (Essentials)'}).title,'Batman (Essentials)');
});
test('long introductions remain complete after collapsing',()=>{
  const description='Before the Multiverse fell, DC Comics was a universe without limits. '+ 'More adventures and stories. '.repeat(15).trim();
  const p=collectionPresentation({description});
  assert.equal([p.lead,...p.paragraphs].join(' '),description);
  assert.ok(p.lead.length<240);
});
test('nested conditions are preserved and corrupt rules are rejected',()=>{
  const group={id:1,type:'group',condition:'OR',rules:[{id:2,field:'year',operator:'between',value:'1937',value2:'1986'}]};
  assert.deepEqual(editableCollectionRules({conditionGroup:JSON.stringify(group)}),group);
  assert.throws(()=>editableCollectionRules({conditionGroup:'invalid'}));
  const legacy=editableCollectionRules({rules:[{rule_type:'publisher',rule_value:'DC Comics'}]});
  assert.equal(legacy.rules[0].field,'publisher');
  assert.equal(legacy.rules[0].value,'DC Comics');
});
