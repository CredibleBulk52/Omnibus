'use strict';
// Called only after a cache miss, before the shared gateway's normal limits.
async function waitForRoutineSlot({readLast,now=Date.now,sleep}){
  for(;;){const wait=(readLast()||0)+24000-now();if(wait<=0)return;await sleep(wait);}
}
module.exports={waitForRoutineSlot};
