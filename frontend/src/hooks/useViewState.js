import { useState, useEffect } from 'react';
import { useNavigationType } from 'react-router-dom';

// Remembers list-page state (page, filters) per browser tab so
// the Back button returns you to where you were. Saved values are restored only
// on Back/Forward (a "POP" navigation) or a reload; opening a page from the
// sidebar or a link starts fresh.
const PREFIX = 'omnibus:view:';

function read(key) {
  try {
    const v = sessionStorage.getItem(PREFIX + key);
    return v == null ? undefined : JSON.parse(v);
  } catch { return undefined; }
}

function write(key, value) {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// Like useState, but persisted under `key`. With no key it behaves like useState.
export function useViewState(key, initial) {
  const navType = useNavigationType();
  const [value, setValue] = useState(() => {
    if (key && navType === 'POP') {
      const stored = read(key);
      if (stored !== undefined) return stored;
    }
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => { if (key) write(key, value); }, [key, value]);
  return [value, setValue];
}

// Scroll position on Back/Forward: hooks/scrollMemory.js (one place for every page, 2026-11-03).
