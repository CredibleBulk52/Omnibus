'use strict';
const zone='America/Chicago';
const format=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
function localParts(now){return Object.fromEntries(format.formatToParts(new Date(now)).map(p=>[p.type,p.value]));}
function maintenanceWindow(now=Date.now()){
  const p=localParts(now),hour=Number(p.hour),open=hour>=1&&hour<6;
  // Search real instants instead of guessing a fixed UTC offset. This handles
  // both occurrences of 1 AM in autumn and the missing spring 2 AM hour.
  let nextStart=null;
  if(!open){
    let t=Math.floor(now/3600000)*3600000+3600000;
    for(let i=0;i<27;i++,t+=3600000){if(Number(localParts(t).hour)===1){nextStart=t;break;}}
  }
  return {open,nextStart,timeZone:zone,startHour:1,endHour:6,nightKey:p.year+'-'+p.month+'-'+p.day};
}
module.exports={maintenanceWindow};
