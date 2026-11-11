// A deterministic shuffle spreads related titles apart without reshuffling on render.
function shuffledItems(items) {
 const pool=[...items].sort((a,b)=>String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
 let state=0x6d2b79f5;
 for(let i=pool.length-1;i>0;i--){state^=state<<13;state^=state>>>17;state^=state<<5;const j=(state>>>0)%(i+1);[pool[i],pool[j]]=[pool[j],pool[i]];}
 return pool;
}
// Stable rotation keeps returning from a detail page predictable.
export function dailyItem(items, day = Math.floor(Date.now() / 86400000)) {
  const sorted = shuffledItems(items);
  return sorted.length ? sorted[day % sorted.length] : null;
}
export function runDestination(run) { return run.event_id ? `/events/${run.event_id}` : `/canon/run/${run.id}`; }
export function publicRuns(shelf = {}, preferRecommended = true) {
  const unique = new Map();
  for (const list of Object.values(shelf)) if (Array.isArray(list)) for (const run of list) unique.set(run.id, run);
  return preferRecommended && Array.isArray(shelf.recommended) && shelf.recommended.length ? shelf.recommended : [...unique.values()];
}

// Manual rotation visits each eligible item, beginning at the daily spotlight.
export function rotatedItem(items, initial, step = 0) {
 const sorted = shuffledItems(items);
 if (!sorted.length) return null;
 const start = Math.max(0, sorted.findIndex(item=>String(item.id)===String(initial?.id)));
 return sorted[(start + step) % sorted.length];
}
