'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const error = (code,message) => Object.assign(new Error(message),{code});

// Writers remain serialized. A proven single-series metadata writer excludes
// only readers of that series; legacy writers and scans retain global scopes.
// This coordinates cooperating app code, not another process or filesystem.
function createLibraryAccess({ admit = () => {}, deploymentGate = null } = {}) {
  const context = new AsyncLocalStorage(), waiting = [];
  const active = new Set();
  const conflicts = (a,b) => (a.mode==='write' || b.mode==='write') &&
    (a.mode===b.mode || a.scope===null || b.scope===null || a.scope===b.scope);
  function pump() {
    for (let index=0;index<waiting.length;) {
      const entry=waiting[index];
      // Preserve FIFO for conflicting work, without making unrelated image
      // requests queue behind a writer waiting on another series.
      if ([...active].some(other=>conflicts(entry,other)) || waiting.slice(0,index).some(other=>conflicts(entry,other))) { index++;continue; }
      waiting.splice(index,1);
      entry.signal?.removeEventListener('abort',entry.abort);
      try { admit(entry.mode,entry.admission,entry.scope); } catch (e) { entry.reject(e); continue; }
      active.add(entry);
      entry.resolve(() => { active.delete(entry); pump(); });
    }
  }
  function acquire(mode, signal, admission, scope) {
    if (signal?.aborted) return Promise.reject(error('ARCHIVE_CANCELLED','Library work cancelled before admission'));
    return new Promise((resolve,reject) => {
      const entry={mode,signal,admission,scope,resolve,reject};
      entry.abort=()=>{const index=waiting.indexOf(entry);if(index<0)return;waiting.splice(index,1);reject(error('ARCHIVE_CANCELLED','Library work cancelled while waiting'));pump();};
      signal?.addEventListener('abort',entry.abort,{once:true});waiting.push(entry);pump();
    });
  }
  async function child(group, action) {
    group.children++;
    try { return await action(); }
    finally { if (--group.children === 0) group.drained?.(); }
  }
  function run(mode,action,options={}) {
    return mode==='write'&&deploymentGate?deploymentGate.run(()=>runAccess(mode,action,options)):runAccess(mode,action,options);
  }
  async function runAccess(mode, action, {signal,admission,scope} = {}) {
    if (!['read','write'].includes(mode) || typeof action !== 'function') throw new TypeError('Library access mode and action required');
    if(scope!==undefined && scope!==null && (typeof scope!=='string'||!scope))throw new TypeError('Nonempty library scope required');
    const parent=context.getStore();
    if (parent?.live) {
      if (parent.mode === 'read' && mode === 'write') throw error('LIBRARY_LOCK_UPGRADE','Start a library mutation outside an active reader');
      if(parent.scope!==null && scope!==undefined && scope!==parent.scope)throw error('LIBRARY_SCOPE_CHANGE','Cannot widen or change an active library scope');
      if (signal?.aborted) throw error('ARCHIVE_CANCELLED','Library work cancelled');
      return child(parent,action);
    }
    scope ??= null;
    const release=await acquire(mode,signal,admission,scope), group={mode,scope,live:true,children:0,drained:null};
    try { return await context.run(group,action); }
    finally {
      // Includes intentionally detached work started through run/track before
      // its parent finished. A later timer with a stale context must reacquire.
      while (group.children) await new Promise(resolve=>{group.drained=resolve;});
      group.live=false;release();
    }
  }
  function track(promise) {
    const group=context.getStore();
    if (!group?.live) throw error('LIBRARY_ACCESS_REQUIRED','A child process requires an active library scope');
    return child(group,()=>promise);
  }
  const wrap=(mode,fn)=>function(...args){return run(mode,()=>fn.apply(this,args));};
  function route(mode,fn,resolveScope=()=>null) {
    return function(req,res,next) {
      const retry={};
      return (async()=>{
        for(let attempt=0;attempt<3;attempt++){
          const scope=resolveScope(req);
          const result=await run(mode,()=>scope===resolveScope(req)?fn(req,res,next):retry,{scope});
          if(result!==retry)return result;
        }
        throw error('LIBRARY_SCOPE_CHANGED','Book moved while waiting; retry the request');
      })().catch(e=>{
        if (res.headersSent) return res.end();
        res.status(e.code==='LIBRARY_RECOVERY_REQUIRED'?409:500).json({error:e.message,code:e.code});
      });
    };
  }
  return {run,wrap,route,track,assertWrite(){if(!context.getStore()?.live || context.getStore().mode!=='write')throw error('LIBRARY_ACCESS_REQUIRED','Library writer scope required');},setAdmission(fn){if(typeof fn!=='function')throw new TypeError('Admission callback required');admit=fn;},
    snapshot:()=>({readers:[...active].filter(entry=>entry.mode==='read').length,writer:[...active].some(entry=>entry.mode==='write'),queued:waiting.length})};
}

// Exact route registrations only. Authentication middleware stays outside the
// barrier; no global pause of login, cancellation, progress or unrelated APIs.
const WRITE_ROUTES = Object.freeze({
  post: ['/api/specials/merge','/api/series/:id/create-json','/api/series/:id/enrich'],
  delete: ['/api/books/batch','/api/monitor/series/:id'],
});
const READ_ROUTES = Object.freeze({get:['/api/books/:id/pages','/api/books/:id/pages/:page','/api/books/:id/thumbnail','/api/series/:id/thumbnail','/api/import/disk-cover']});
function coordinateLibraryRoutes(app,access,{readScope=()=>null}={}) {
  for (const [method,routes] of Object.entries({...WRITE_ROUTES,...READ_ROUTES})) {
    const register=app[method];
    app[method]=function(route,...handlers) {
      if (routes.includes(route)) {
        const last=handlers.length-1;
        if (typeof handlers[last]!=='function') throw new TypeError('Library route needs a terminal handler');
        handlers[last]=access.route(method==='get'?'read':'write',handlers[last],method==='get'?req=>readScope(route,req):undefined);
      }
      return register.call(this,route,...handlers);
    };
  }
}
module.exports={createLibraryAccess,coordinateLibraryRoutes,WRITE_ROUTES,READ_ROUTES};
