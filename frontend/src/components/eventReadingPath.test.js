import { validPath, effectivePath, includesTier, preferenceKey, readPreference, writePreference, eventReadUrl, eventAlternatives, pathEndMessage } from './eventReadingPath';
beforeEach(()=>localStorage.clear());
test('preferences survive remount reads and are isolated by account and event',()=>{
 localStorage.setItem('omnibus_user',JSON.stringify({id:'one'}));
 const a=preferenceKey('event.a');writePreference(a,'essential');expect(readPreference(a,'all')).toBe('essential');
 expect(readPreference(preferenceKey('event.b'),'all')).toBe('all');
 localStorage.setItem('omnibus_user',JSON.stringify({id:'two'}));expect(readPreference(preferenceKey('event.a'),'all')).toBe('all');
});
test('invalid preferences are safe and empty tiers widen consistently',()=>{
 expect(validPath('invalid')).toBe('all');expect(effectivePath([{tier:'recommended'}],'essential')).toBe('recommended');
 expect(effectivePath([{tier:'tie-in'}],'essential')).toBe('all');expect(includesTier({tier:'essential'},'recommended')).toBe(true);
});
test('read URL preserves path and restart with escaped identifiers',()=>{
 const url=new URL(eventReadUrl('a/b','event & 1','essential',true),'http://localhost');
 expect(url.pathname).toBe('/read/a%2Fb');expect(url.searchParams.get('eventId')).toBe('event & 1');expect(url.searchParams.get('minTier')).toBe('essential');expect(url.searchParams.get('restart')).toBe('1');
});
test('end-card shortcuts preserve distinct destinations and suppress duplicates',()=>{
 const rec={id:'r'},ess={id:'e'},all={id:'a'};
 expect(eventAlternatives({next:ess,nextRecommended:rec,nextEssential:ess,nextAll:all},'essential').map(r=>r.issue.id)).toEqual(['r','a']);
 expect(eventAlternatives({next:ess,nextRecommended:ess,nextEssential:ess,nextAll:all},'essential').map(r=>r.issue.id)).toEqual(['a']);
 expect(eventAlternatives({next:all,nextRecommended:rec,nextEssential:ess,nextAll:all},'all').map(r=>r.issue.id)).toEqual(['r','e']);
 expect(eventAlternatives({next:rec,nextRecommended:rec,nextEssential:ess,nextAll:all},'recommended').map(r=>r.issue.id)).toEqual(['e','a']);
});
test('completion is distinct from merely reaching the last owned issue',()=>{
 expect(pathEndMessage({path:'essential',remainingOther:0},true)).toContain('reading complete');
 expect(pathEndMessage({path:'essential',remainingOther:1},true)).toContain('unread or missing');
 expect(pathEndMessage({path:'essential',remainingOther:0},false)).not.toContain('reading complete');
});
