'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
function createDeploymentGate(){
  const context=new AsyncLocalStorage();let draining=false,active=0;
  const waiters=new Set();
  async function run(action){
    if(context.getStore()?.live)return action();
    if(draining)throw Object.assign(Error('Metadata work is paused for deployment'),{code:'DEPLOYMENT_PAUSED'});
    active++;const scope={live:true};
    try{return await context.run(scope,action);}
    finally{scope.live=false;if(--active===0)for(const resolve of waiters)resolve();}
  }
  async function drain(timeoutMs=120000){
    draining=true;
    if(!active)return true;
    return new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);waiters.delete(finish);resolve(true);};
      const timer=setTimeout(()=>{waiters.delete(finish);resolve(false);},timeoutMs);
      waiters.add(finish);
    });
  }
  return {run,drain,resume(){draining=false;},snapshot:()=>({draining,active})};
}
module.exports={createDeploymentGate};
