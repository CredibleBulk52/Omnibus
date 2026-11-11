import React, { useLayoutEffect, useRef, useState } from 'react';
import { boxArtworkImages } from './boxArtwork';

export default function BoxDefaultArtwork({ title, isOrder, family = 'default', era }) {
  const titleRef = useRef(null);
  const [failed, setFailed] = useState(null);
  const image = boxArtworkImages[family] || boxArtworkImages.default;
  useLayoutEffect(() => {
    const el=titleRef.current;
    if (!el) return;
    const fit=()=>{
      let size=38;
      el.style.fontSize=`${size}px`;
      const caption=el.parentElement;
      const stamp=caption.querySelector('.box-placeholder-stamp');
      const eraLabel=caption.querySelector('.cbox-placeholder-era');
      const availableHeight=caption.clientHeight - (stamp?.offsetHeight || 0) - 8 - (eraLabel ? eraLabel.offsetHeight + 8 : 0);
      while ((el.scrollHeight>availableHeight + 1 || el.scrollWidth>el.clientWidth + 1) && size>12) {
        size--; el.style.fontSize=`${size}px`;
      }
    };
    fit();
    let active=true;
    document.fonts?.ready.then(()=>{if(active) fit();});
    return ()=>{active=false;};
  },[title,era]);
  return <div className="cbox-placeholder cbox-default-artwork" data-artwork-family={family}>
    {image && failed !== image && <img className="cbox-default-art-image" src={image} loading="lazy" decoding="async" alt="" aria-hidden="true" onError={()=>setFailed(image)} />}
    <div className="cbox-default-caption">
      <span className="box-placeholder-stamp">{isOrder ? 'READING ORDER' : 'OMNIBUS COLLECTION'}</span>
      <div className="cbox-placeholder-name" ref={titleRef} title={title}>{title}</div>
      {era && <div className="cbox-placeholder-era">{era}</div>}
    </div>
  </div>;
}

