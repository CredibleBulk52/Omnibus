const test = require('node:test');
const assert = require('node:assert/strict');
const { usableImage, personImage, selectPerson, createPersonPhotos } = require('./personPhotos');
const blank='https://comicvine.gamespot.com/a/uploads/scale_medium/11122/111222211/6373148-blank.png';
const photo='https://comicvine.gamespot.com/a/uploads/real.jpg';
const ok=results=>({data:{status_code:1,results}});
function fixture(cached, request) {
  const entries=new Map(cached ? [['stan lee',cached]] : []);let writes=0;
  const service=createPersonPhotos({read:n=>entries.get(n),write:(n,p)=>{writes++;entries.set(n,{...p,cached_at:'2026-10-24 12:00:00'});},request,getKey:()=> 'test',now:()=>Date.parse('2026-10-24T12:00:00Z')});
  return {service,entries,get writes(){return writes;}};
}
test('reject placeholders and select a usable alternative size',()=>{
  assert.equal(usableImage(blank),null);assert.equal(usableImage('https://comicvine.gamespot.com/a/img_broken.png'),null);
  assert.equal(personImage({medium_url:blank,original_url:photo}),photo);
});
test('repair a recently cached placeholder directly by person ID',async()=>{
  const calls=[];const f=fixture({image_url:blank,cv_person_id:'123',cached_at:'2026-10-24 11:00:00'},async url=>{calls.push(url);return ok({image:{medium_url:photo}})});
  assert.equal((await f.service.resolve('Stan Lee')).image_url,photo);assert.deepEqual(calls,['https://comicvine.gamespot.com/api/person/4040-123/']);assert.equal(f.writes,1);
});
test('search placeholder falls back to detail and concurrent requests share lookup',async()=>{
  const calls=[];const f=fixture(null,async url=>{calls.push(url);return url.endsWith('/search')?ok([{id:123,name:'Stan Lee',image:{medium_url:blank}}]):ok({image:{medium_url:photo}})});
  const result=await Promise.all([f.service.resolve('Stan Lee'),f.service.resolve('Stan Lee')]);assert.equal(calls.length,2);assert.equal(result[0].image_url,photo);assert.equal(f.writes,1);
});
test('true missing photos are cached as null and do not repeatedly call CV',async()=>{
  let calls=0;const f=fixture({image_url:blank,cv_person_id:'123'},async()=>{calls++;return ok({image:{medium_url:blank}})});
  assert.equal((await f.service.resolve('Stan Lee')).image_url,null);await f.service.resolve('Stan Lee');assert.equal(calls,1);
});
test('transient errors retain cache and back off',async()=>{
  let calls=0;const f=fixture({image_url:blank,cv_person_id:'123'},async()=>{calls++;throw Error('Rate limited')});
  await assert.rejects(f.service.resolve('Stan Lee'));await f.service.resolve('Stan Lee');assert.equal(calls,1);assert.equal(f.writes,0);
});
test('valid photos use cache; popularity cannot outrank the correct name',async()=>{
  const f=fixture({image_url:photo,cv_person_id:'123',cached_at:'2026-10-24 11:00:00'},()=>{throw Error('Unnecessary call')});assert.equal((await f.service.resolve('Stan Lee')).image_url,photo);
  assert.equal(selectPerson([{name:'Stan Lee',id:1},{name:'Stan Somebody',id:2,count_of_issue_appearances:10000}],'Stan Lee').id,1);
  assert.equal(selectPerson([{name:'Someone Else'}],'Stan Lee'),undefined);
});

test('Mariko uses her verified CV headshot even during a negative-cache TTL',async()=>{
  let written;
  const service=createPersonPhotos({
    read:()=>({image_url:null,cv_person_id:'60206',cached_at:'2026-10-24 11:59:00'}),
    write:(name,photo)=>{written={name,...photo};},
    request:()=>{throw Error('No API call needed for verified fallback');},
    getKey:()=>'',now:()=>Date.parse('2026-10-24T12:00:00Z'),
  });
  const result=await service.resolve(' Mariko Tamaki ');
  assert.equal(result.cv_person_id,'60206');
  assert.match(result.image_url,/1431885-tamaki_headshot\.gif$/);
  assert.equal(written.name,'mariko tamaki');
});
