import React from 'react';

// Built-in banner art for the app themes (2026-11-12). Generic scenes only: no character,
// emblem or logo. Drawn in a 240-tall box centred on x=0; `span` is the visible width.
// An installation's own ThemeArtwork.local.jsx, or art an admin uploaded, takes precedence.

const star='0,-42 10,-13 40,-13 16,6 25,35 0,18 -25,35 -16,6 -40,-13 -10,-13';
const sides=[-1,1];
const steps=(count)=>Array.from({length:count},(_,i)=>i);

function Laugh({x,y,angle,size}) {
  // Angular "HA" lettering drawn as fixed vector glyphs.
  return <g transform={'translate('+x+' '+y+') rotate('+angle+') scale('+size/70+') translate(-66 0)'} fill="#b4ee43" stroke="#271039" strokeWidth="4" strokeLinejoin="miter" paintOrder="stroke">
    <path d="M0 0 9-70 26-76 18-43 36-47 43-73 59-68 47 0 30 4 34-28 15-24 12-2Z"/>
    <path fillRule="evenodd" d="M52 2 76-72 99-78 114-4 96 2 92-17 72-14 68 5Z M77-31 89-34 85-53Z"/>
    <path d="M117-23 120-75 141-79 130-24Z M115-13 133-16 130 1 113 5Z"/>
  </g>;
}

// Daybreak: a sun rising behind a sweeping red wave.
function Daybreak({L}) {
  const reach=Math.max(L,320);
  const rays=steps(18).map(i=>{
    const a=Math.PI+(i+.5)*Math.PI/18,d=.045;
    return <path key={i} d={'M0 150 L'+Math.cos(a-d)*reach+' '+(150+Math.sin(a-d)*reach)+' L'+Math.cos(a+d)*reach+' '+(150+Math.sin(a+d)*reach)+'Z'} fill="#ffdc43" opacity={i%2?.22:.38}/>;
  });
  return <>
    {rays}
    <circle cy="150" r="74" fill="#ffdc43" stroke="#081126" strokeWidth="6"/>
    <circle cy="150" r="52" fill="#ffe88a" opacity=".7"/>
    <path d={'M'+(-L)+' 205 C'+(-L*.78)+' 205 '+(-L*.77)+' 70 '+(-L*.45)+' 100 C'+(-L*.2)+' 123 -170 159 0 133 C'+(L*.3)+' 80 '+(L*.55)+' 174 '+L+' 196 L'+L+' 240 H'+(-L)+' V205Z'} fill="#d32239" stroke="#071126" strokeWidth="5"/>
    <path d={'M-55 154 Q'+L*.38+' 125 '+L*.81+' 192'} fill="none" stroke="#99172e" strokeWidth="5"/>
  </>;
}

// Night Watch: a city skyline under a moon, with two searchlights crossing the sky.
function NightWatch({L}) {
  let d='M'+(-L)+' 220',x=-L,i=0;
  while(x<L){
    const width=45+(i*47%83),end=Math.min(L,x+width),top=130+(i*43%73);
    const inset=Math.min(8,(end-x)/4);   // keep the last roof inside narrow banners
    d+=' L'+x+' '+(top+14)+' H'+(x+inset);
    if(i%3===0)d+=' V'+top+' H'+(x+(end-x)*.46)+' V'+(top-18)+' H'+(x+(end-x)*.56)+' V'+top;
    else if(i%3===1)d+=' L'+(x+(end-x)*.5)+' '+(top-12)+' L'+(end-inset)+' '+(top+14);
    else d+=' V'+top+' H'+(end-inset)+' V'+(top+14);
    d+=' H'+end+' V220';x=end;i++;
  }
  const moon=Math.min(L*.6,260);
  return <>
    {sides.map(side=><path key={side} d={'M'+side*60+' 220 L'+side*(-Math.min(L*.5,330))+' 0 L'+side*(-Math.min(L*.5,330)+70)+' 0Z'} fill="#f6cf4a" opacity=".22"/>)}
    <circle cx={moon} cy="60" r="38" fill="#f6cf4a" opacity=".95"/>
    <circle cx={moon-12} cy="52" r="8" fill="#d9b23a" opacity=".6"/><circle cx={moon+13} cy="70" r="5" fill="#d9b23a" opacity=".6"/>
    <path d={d+' L'+(-L)+' 220Z'} fill="#0a101c" stroke="#4d6482" strokeWidth="3"/>
  </>;
}

// Emerald Light: rays and ribbons of green energy around a bright core.
function EmeraldLight({L}) {
  const rays=steps(36).map(i=>{
    const a=i*Math.PI*2/36+.025*Math.sin(i*7),near=63+(i*13%22),far=170+(i*71%290);
    const reach=Math.abs(Math.cos(a))>.82?Math.min(L*.92,far*2):far;
    const d='M'+Math.cos(a-.025)*near+' '+(120+Math.sin(a-.025)*near)+' L'+Math.cos(a)*reach+' '+(120+Math.sin(a)*reach)+' L'+Math.cos(a+.025)*near+' '+(120+Math.sin(a+.025)*near)+'Z';
    return <path key={i} d={d} fill={i%4===0?'#edffb2':'#93ff65'} opacity={i%3===0?.6:.28}/>;
  });
  let burst='';
  for(let i=0;i<64;i++){const a=i*Math.PI*2/64,r=i%2?83:105+(i*7%22);burst+=(i?'L':'M')+Math.cos(a)*r+' '+(120+Math.sin(a)*r)+' ';}
  return <>
    {rays}
    {sides.flatMap(side=>steps(4).map(j=>{
      const end=Math.min(L*.96,430+j*140),y=55+j*43;
      const d='M'+side*78+' '+(95+j*16)+' C'+side*150+' '+(y-65)+' '+side*205+' '+(y+65)+' '+side*285+' '+y+' S'+side*(end-80)+' '+(y+(j%2?70:-65))+' '+side*end+' '+(y+(j%2?20:-15));
      return <g key={side+':'+j} fill="none"><path d={d} stroke="#55ed61" strokeWidth="13" opacity=".18"/><path d={d} stroke={j%2?'#b9ff9a':'#7eff72'} strokeWidth={j===1?4:2.5} opacity=".7"/></g>;
    }))}
    <path d={burst+'Z'} fill="#8aff60" opacity=".2"/>
    <circle cy="120" r="62" fill="#8aff60" opacity=".3"/>
    <circle cy="120" r="40" fill="#e5ffe0" opacity=".9"/>
  </>;
}

// Harlequin: layers of tilted diamonds.
function Harlequin({L,span,id}) {
  return <>
    <defs><clipPath id={id}><path d={'M'+(-L+75)+' 0H'+L+'V240H'+(-L)+'Z'}/></clipPath></defs>
    <g clipPath={'url(#'+id+')'}>
      <path d={'M'+(-L+75)+' 0H'+L+'V240H'+(-L)+'Z'} fill="#15131c"/>
      {steps(Math.max(1,Math.ceil(span/160))).map(i=>{
        const x=-L+100+i*160,y=i%2?170:53,angle=(i*13%37)-18;
        return <g key={'back'+i} transform={'translate('+x+' '+y+') rotate('+angle+') scale(.55)'} fill={i%2?'#9d1732':'#aa9fa9'} opacity=".5" stroke="#08090c" strokeWidth="5"><path d="M0-55 34 0 0 55-34 0Z"/></g>;
      })}
      {steps(Math.max(1,Math.ceil(span/150))).map(i=>{
        const x=-L+125+i*150+(i%3-1)*19,y=100+(i*37%67)-33,scale=.75+(i*7%5)*.13,angle=(i*17%39)-19;
        return <g key={'front'+i} transform={'translate('+x+' '+y+') rotate('+angle+') scale('+scale+')'} fill={i%3===1?'#dc2342':'#fff0e9'} stroke="#08090c" strokeWidth="5"><path d="M0-55 34 0 0 55-34 0Z"/></g>;
      })}
    </g>
  </>;
}

// Wild Card: laughter lettering around a tilted playing card.
function WildCard({L}) {
  const laughter=[[-165,76,-21,65],[-180,171,17,58],[-130,238,-11,58],[-62,37,12,43],[65,30,-17,48],[156,77,19,69],[180,160,-13,62],[123,237,16,55]];
  for(const side of sides) {
    let distance=285,i=0;
    while(distance<L-40) {
      laughter.push([side*distance,65+(i*53%130),side*((i*19%39)-19),50+(i*11%27)]);
      if(distance<520) laughter.push([side*(distance+35),208-(i%2)*110,-side*23,37+(i%3)*7]);
      distance+=125+distance*.18;i++;
    }
  }
  const pip='M0-16 11 0 0 16-11 0Z';
  return <>
    {laughter.map(([x,y,angle,size],i)=><Laugh key={i} x={x} y={y} angle={angle} size={size}/>)}
    <g transform="translate(0 122) rotate(-12)">
      <rect x="-56" y="-80" width="112" height="160" rx="11" fill="#fff6e6" stroke="#160d20" strokeWidth="7"/>
      <rect x="-44" y="-68" width="88" height="136" rx="6" fill="none" stroke="#64308e" strokeWidth="3"/>
      <path d="M0-36 30 0 0 36-30 0Z" fill="#a2dd34" stroke="#160d20" strokeWidth="5"/>
      <path d={pip} transform="translate(-34 -56) scale(.6)" fill="#64308e"/>
      <path d={pip} transform="translate(34 56) scale(.6)" fill="#64308e"/>
    </g>
  </>;
}

// Old Glory: stripes, a row of stars and one large star.
function OldGlory({L}) {
  return <>
    {[0,1,2].map(i=><path key={i} d={'M'+(-L)+' '+(148+i*24)+'H'+L} stroke={i===1?'#fff':'#d0273e'} strokeWidth="23"/>)}
    {sides.flatMap(side=>steps(Math.max(0,Math.floor((L-150)/140))).map(i=><polygon key={side+':'+i} points={star} transform={'translate('+side*(190+i*140)+' 65) scale(.43)'} fill="#fff"/>))}
    <polygon points={star} transform="translate(0 108) scale(2.1)" fill="#fff" stroke="#0a1326" strokeWidth="3.5" strokeLinejoin="round"/>
  </>;
}

// Red & Gold: gold circuit lines running into a hexagonal power core.
function RedAndGold({L}) {
  const hex=r=>steps(6).map(i=>{const a=Math.PI/6+i*Math.PI/3;return (Math.cos(a)*r).toFixed(1)+','+(120+Math.sin(a)*r).toFixed(1);}).join(' ');
  return <>
    {sides.map(side=><g key={side} transform={'scale('+side+' 1)'} fill="none">
      <path d={'M45 0 90 85H'+Math.max(130,L-95)+'L'+L+' 20M45 240 90 152H'+Math.max(130,L-123)+'L'+L+' 220'} stroke="#f0c451" strokeWidth="16"/>
      <path d={'M110 68H'+Math.max(130,L-110)+'L'+L+' 0M110 171H'+Math.max(130,L-135)+'L'+L+' 240'} stroke="#4b101b" strokeWidth="5"/>
    </g>)}
    <polygon points={hex(88)} fill="#4b1420" stroke="#e8b746" strokeWidth="14" strokeLinejoin="round"/>
    <polygon points={hex(58)} fill="#a31e2b" stroke="#ffd778" strokeWidth="8" strokeLinejoin="round"/>
    <polygon points={hex(30)} fill="#ffe7a8" stroke="#fff6dc" strokeWidth="6" strokeLinejoin="round"/>
  </>;
}

// Gamma: ground cracking outward from a shattered stone.
function Gamma() {
  return <>
    <g fill="none" stroke="#172311" strokeLinejoin="miter">
      <path d="M0 120 -85 22M0 120 -150 87 -205 30M0 120 -120 160 -170 230M0 120 100 65 140 30M0 120 150 158 210 230M0 120 5 230" strokeWidth="14"/>
      <path d="M-150 87 -252 102 -310 70 -399 89 -455 50 -570 64 -635 15M-120 160 -238 139 -287 176 -375 158 -445 202 -534 180 -611 223M150 158 245 136 290 170 370 142 410 186 490 171 570 208M100 65 208 83 254 46 340 65 391 25 466 45" strokeWidth="7"/>
      <path d="M-399 89 -434 142 -511 125 -574 159 -663 129 -718 156 -798 110M-252 102 -290 124 -287 176M-434 142 -375 158M-663 129 -701 68 -778 84M245 136 222 100 208 83M370 142 354 99 340 65M490 171 516 113 588 130 634 86 719 104M466 45 515 12M570 208 636 191 694 231" strokeWidth="3"/>
    </g>
    <path d="M-47 95 -16 78 4 96 36 84 56 111 40 138 63 166 26 172 2 194 -24 166 -49 156 -35 129Z" fill="#312039" stroke="#172311" strokeWidth="6"/>
  </>;
}

// Blue & Gold: slanted blue bands with pale gold between them, on the gold banner.
function BlueAndGold({L,id}) {
  const count=Math.ceil((L*2+300)/70);
  return <>
    <defs><clipPath id={id}><rect x={-L} y="0" width={L*2} height="240"/></clipPath></defs>
    <g clipPath={'url(#'+id+')'}>
      {steps(count).map(i=>{
        const x=-L-150+i*70,w=i%3===1?22:40;
        return <path key={i} d={'M'+x+' 240 L'+(x+120)+' 0 H'+(x+120+w)+' L'+(x+w)+' 240Z'} fill={i%3===1?'#fff3b0':'#214ca6'} opacity={i%3===1?.9:.95} stroke="#101b38" strokeWidth="3"/>;
      })}
    </g>
  </>;
}

// Cosmic Blue: a ringed planet with orbit lines and stars.
function CosmicBlue({L}) {
  return <>
    {sides.map(side=><g key={side} transform={'scale('+side+' 1)'} fill="none" stroke="#a3ddff" strokeWidth="4">
      <path d={'M110 75 140 45H'+L+'M110 165 140 195H'+L}/>
      {steps(Math.max(0,Math.floor((L-170)/180))).map(i=><circle key={i} cx={190+i*180} cy="45" r="7" fill="#fff" stroke="none"/>)}
    </g>)}
    {[[-150,120],[160,118],[-60,22],[70,214],[110,30],[-120,205]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r={i%2?3:4} fill="#e8f5ff"/>)}
    <g transform="translate(0 120) rotate(-16)">
      <ellipse rx="112" ry="26" fill="none" stroke="#082e55" strokeWidth="16"/>
      <circle r="62" fill="#0879c3" stroke="#082e55" strokeWidth="7"/>
      <path d="M-50-30 Q0-46 50-30M-60 4 Q0-8 60 4" fill="none" stroke="#5fb8ef" strokeWidth="6" opacity=".7"/>
      <path d="M-112 0 A112 26 0 0 0 112 0" fill="none" stroke="#f4fbff" strokeWidth="9"/>
    </g>
  </>;
}

export default function GenericThemeArtwork({theme,span=620}) {
  const id=React.useId(),L=span/2;
  switch(theme){
    case 'superman':return <Daybreak L={L}/>;
    case 'batman':return <NightWatch L={L}/>;
    case 'green-lantern':return <EmeraldLight L={L}/>;
    case 'harley-quinn':return <Harlequin L={L} span={span} id={id}/>;
    case 'joker':return <WildCard L={L}/>;
    case 'captain-america':return <OldGlory L={L}/>;
    case 'iron-man':return <RedAndGold L={L}/>;
    case 'hulk':return <Gamma/>;
    case 'x-men':return <BlueAndGold L={L} id={id}/>;
    case 'fantastic-four':return <CosmicBlue L={L}/>;
    default:return null;
  }
}
