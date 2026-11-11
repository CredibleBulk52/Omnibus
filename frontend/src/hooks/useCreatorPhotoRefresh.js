import { useEffect } from 'react';

// Background photo work must not hold up the page. Poll briefly, then stop;
// navigating away cancels the request and timer.
export default function useCreatorPhotoRefresh(enabled, setCreators) {
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false, timer, attempts = 0;
    const controller = new AbortController();
    const refresh = async () => {
      attempts += 1;
      let missing = true;
      try {
        const response = await fetch('/api/canon/creators', { signal: controller.signal });
        if (response.ok) {
          const people = await response.json();
          if (!cancelled && Array.isArray(people)) {
            setCreators(people);
            missing = people.some(person => !person.image_url);
          }
        }
      } catch { /* Keep the existing shelf on temporary failures. */ }
      if (!cancelled && missing && attempts < 12) timer = setTimeout(refresh, 5000);
    };
    timer = setTimeout(refresh, 5000);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [enabled, setCreators]);
}
