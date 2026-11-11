const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const React=require('react'),{createRoot}=require('react-dom/client'),{act}=require('react-dom/test-utils'),{JSDOM}=require('jsdom'),babel=require('@babel/core');
const dom=new JSDOM('<div id="root"></div>',{url:'https://app.test/'});
Object.assign(global,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
const source=fs.readFileSync(require.resolve('../src/App.jsx'),'utf8');
const section=source.slice(source.indexOf('let logoutPending'),source.indexOf('function RequireAdmin(')).replace('export async function','async function');
function setup({prepare=async()=> 'ready',revoke=async()=>{}}={}){
 const storage=window.localStorage;storage.setItem('omnibus_token','token');storage.setItem('omnibus_user','{}');const alerts=[];
 const context={React,useState:React.useState,useEffect:React.useEffect,useLocation:()=>({pathname:'/read/book'}),Navigate:()=>null,prepareReaderSession:prepare,revokeSession:revoke,loadAppearance:()=>{},clearAppearance:()=>{},setViewAsUser:()=>{},localStorage:storage,getToken:()=>storage.getItem('omnibus_token'),window:{addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window),alert:message=>alerts.push(message),location:{}}};
 vm.createContext(context);vm.runInContext(babel.transformSync(section+'\nglobalThis.api={RequireAuth,doLogout};',{presets:[require.resolve('@babel/preset-react')],babelrc:false,configFile:false}).code,context);
 return {...context.api,alerts};
}
test('reader does not mount before handshake; offline opens and reconnect remounts with authenticated images',async()=>{
 let release,count=0;const api=setup({prepare:()=>count++===0?new Promise(r=>release=r):Promise.resolve('ready')});const host=document.getElementById('root'),root=createRoot(host);let mounts=0;
 function Reader(){React.useEffect(()=>{mounts++},[]);return React.createElement('img',{src:'/api/books/b/pages/0'})}
 try{
 await act(async()=>root.render(React.createElement(api.RequireAuth,null,React.createElement(Reader))));assert.equal(host.querySelector('img'),null);assert.match(host.textContent,/Opening/);
 await act(async()=>release('offline'));assert.ok(host.querySelector('img'));assert.equal(mounts,1);
 await act(async()=>window.dispatchEvent(new window.Event('online')));assert.equal(mounts,2);
 }finally{await act(async()=>root.unmount())}
});
test('logout waits for server before clearing credentials and navigation, without recursive calls',async()=>{
 let release,navigated=false,calls=0;const api=setup({revoke:()=>{calls++;return new Promise(r=>release=r)}});
 const pending=api.doLogout(()=>navigated=true);await api.doLogout(()=>navigated=true);assert.equal(calls,1);assert.equal(window.localStorage.getItem('omnibus_token'),'token');assert.equal(navigated,false);
 release();await pending;assert.equal(window.localStorage.getItem('omnibus_token'),null);assert.equal(navigated,true);
});
test('failed server logout still signs out locally and reports failure; automatic invalidation clears locally',async()=>{
 const api=setup({revoke:async()=>{throw Error('offline')}});let navigated=false;
 await api.doLogout(()=>navigated=true);assert.equal(window.localStorage.getItem('omnibus_token'),null);assert.equal(navigated,true);assert.equal(api.alerts.length,1);
 window.localStorage.setItem('omnibus_token','token');navigated=false;
 await api.doLogout(()=>navigated=true,true);assert.equal(window.localStorage.getItem('omnibus_token'),null);assert.equal(navigated,true);assert.equal(api.alerts.length,1);
});
