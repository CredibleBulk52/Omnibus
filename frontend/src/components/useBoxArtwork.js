import { useEffect, useState } from 'react';

// Box images are private media. Fetch through the authenticated API wrapper,
// then give native image/background elements a short-lived local URL.
export default function useBoxArtwork(src) {
  const protectedImage = typeof src === 'string' && (src.startsWith('/api/collections/') || src.startsWith('/api/reading-lists/'));
  const [image, setImage] = useState(null);
  useEffect(() => {
    if (!protectedImage) return;
    let active = true;
    let objectUrl;
    const controller = new AbortController();
    fetch(src, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error('Box artwork unavailable');
        return response.blob();
      })
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ src, url: objectUrl });
      })
      .catch(() => { if (active) setImage(null); });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, protectedImage]);
  return protectedImage ? (image?.src === src ? image.url : null) : src;
}
