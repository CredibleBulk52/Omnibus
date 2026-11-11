import React from 'react';
import ThemeArtwork from './ThemeArtwork';
import '../themeMotifs.css';

// Keep the emblem in the actual free space, not under a long title or stats.
export function getMotifLayout(header, title, actions) {
  const left=title.right-header.left+24;
  const right=(actions?actions.left-header.left:header.width-24)-24;
  const width=Math.max(0,right-left);
  const sameRow=!actions || Math.abs(actions.top-title.top)<35;
  const visible=header.width>=600 && header.height>0 && width>=180 && sameRow;
  return {left,width,visible,span:visible?width/header.height*240:620};
}

export default function ThemeMotif({theme,className=''}) {
  const svgRef=React.useRef(null);
  const [layout,setLayout]=React.useState(null);
  React.useEffect(()=>{
    const svg=svgRef.current,header=svg?.closest('.page-header');
    if(!header) {setLayout(null);return undefined;}
    const content=header.querySelector('.page-header-content');
    let active=true;
    const update=()=>{
      if(!active)return;
      const title=header.querySelector('.page-title'),actions=header.querySelector('.page-header-actions');
      if(!title)return;
      const next=getMotifLayout(header.getBoundingClientRect(),title.getBoundingClientRect(),actions?.getBoundingClientRect());
      setLayout(old=>old && Object.keys(next).every(k=>old[k]===next[k])?old:next);
    };
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(update):null;
    const observe=()=>{
      observer?.disconnect();
      [header,content,header.querySelector('.page-title'),header.querySelector('.page-header-actions')].filter(Boolean).forEach(el=>observer?.observe(el));
      update();
    };
    const mutations=typeof MutationObserver!=='undefined'?new MutationObserver(observe):null;
    if(content)mutations?.observe(content,{childList:true,subtree:true,characterData:true});
    observe();
    window.addEventListener('resize',update);
    document.fonts?.ready.then(update);
    return ()=>{active=false;observer?.disconnect();mutations?.disconnect();window.removeEventListener('resize',update);};
  },[theme]);
  const style=layout?{left:layout.left,width:layout.width,right:'auto',display:layout.visible?'block':'none'}:undefined;
  return <ThemeMotifArt theme={theme} className={className} span={layout?.span||620} svgRef={svgRef} style={style}/>;
}

export function ThemeMotifArt({theme,className='',span=620,svgRef,style}) {
  if(!theme)return null;
  return <svg ref={svgRef} className={'theme-motif '+className} data-motif={theme}
    viewBox={(-span/2)+' 0 '+span+' 240'} preserveAspectRatio="xMidYMid meet"
    style={style} aria-hidden="true" focusable="false">
    <ThemeArtwork theme={theme} span={span}/>
  </svg>;
}
