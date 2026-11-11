import React, { useEffect, useRef, useState } from 'react';

export default function BrandingCrop({ file, busy, onSave, onCancel }) {
  const [image, setImage] = useState(null), [crop, setCrop] = useState(null), [error, setError] = useState('');
  const preview = useRef(null), auto = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      if (w * h > 16000000) { setError('Choose an image under 16 megapixels.'); return; }
      try {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, w, h).data;
        let left = w, top = h, right = -1, bottom = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (pixels[(y * w + x) * 4 + 3]) {
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
        if (right < left) { setError('This image is fully transparent. Choose artwork with visible content.'); return; }
        auto.current = { left, top, width: right - left + 1, height: bottom - top + 1 };
        setImage(img); setCrop(auto.current);
      } catch { setError('Could not preview this image. Choose another PNG or JPEG.'); }
    };
    img.onerror = () => { if (!cancelled) setError('Could not read this image. Choose another PNG or JPEG.'); };
    img.src = url;
    return () => { cancelled = true; URL.revokeObjectURL(url); };
  }, [file]);
  useEffect(() => {
    if (!image || !crop || !preview.current) return;
    const canvas = preview.current;
    const scale = Math.min(1, 420 / crop.width, 220 / crop.height);
    canvas.width = Math.max(1, Math.round(crop.width * scale)); canvas.height = Math.max(1, Math.round(crop.height * scale));
    canvas.getContext('2d').drawImage(image, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  }, [image, crop]);
  function margin(edge, value) {
    const w = image.naturalWidth, h = image.naturalHeight;
    setCrop(c => {
      const right = c.left + c.width, bottom = c.top + c.height;
      if (edge === 'Left') { const left = Math.min(right - 1, Math.round(w * value / 100)); return { ...c, left, width: right - left }; }
      if (edge === 'Right') return { ...c, width: Math.max(1, w - Math.round(w * value / 100) - c.left) };
      if (edge === 'Top') { const top = Math.min(bottom - 1, Math.round(h * value / 100)); return { ...c, top, height: bottom - top }; }
      return { ...c, height: Math.max(1, h - Math.round(h * value / 100) - c.top) };
    });
  }
  const margins = image && crop ? [
    ['Left', crop.left / image.naturalWidth * 100],
    ['Right', (image.naturalWidth - crop.left - crop.width) / image.naturalWidth * 100],
    ['Top', crop.top / image.naturalHeight * 100],
    ['Bottom', (image.naturalHeight - crop.top - crop.height) / image.naturalHeight * 100],
  ] : [];
  return <div className="brand-crop">
    <strong>Crop artwork</strong>
    <p>Transparent margins are trimmed automatically. Adjust the edges to remove extra background. The preview keeps the artwork’s proportions.</p>
    {error ? <p role="alert" className="brand-error">{error}</p> : !image ? <p role="status">Preparing preview…</p> : <>
      <div className="brand-crop-preview"><canvas ref={preview} role="img" aria-label="Cropped artwork preview" /></div>
      {margins.map(([edge, value]) => <label key={edge}>{edge}<input aria-label={edge + ' crop'} type="range" min="0" max="99" step="0.1" value={value} disabled={busy} onChange={e => margin(edge, Number(e.target.value))} /><span>{Math.round(value)}%</span></label>)}
      <div className="brand-editor-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setCrop(auto.current)}>Auto-trim</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setCrop({ left: 0, top: 0, width: image.naturalWidth, height: image.naturalHeight })}>Reset crop</button>
      </div>
    </>}
    <div className="brand-editor-actions">
      <button type="button" className="btn btn-primary" disabled={busy || !crop || !!error} onClick={() => onSave(crop)}>Save artwork</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    <small>Changes apply everywhere only after saving. To restore cropped-out content later, upload the original again.</small>
  </div>;
}
