import React from 'react';
import '../omnibusLogo.css';

// The Omnibus logo, drawn in layers so it follows the app colours live:
// black ink + blue oval as an image, the red ring in --om-secondary, the burst in --om-highlight.
// size: 'sm' uses the 160px layers (sidebar), anything else the 512px layers.
export default function OmnibusLogo({ size = 'lg', className = '', style }) {
  return (
    <span className={`om-logo${size === 'sm' ? ' om-logo--sm' : ''} ${className}`} style={style} role="img" aria-label="Omnibus">
      <span className="om-logo-red" />
      <span className="om-logo-yellow" />
    </span>
  );
}
