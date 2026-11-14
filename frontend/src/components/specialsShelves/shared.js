// Shared bits of the Library › Specials shelves panel (split out of SeriesShelf.jsx, 2026-11-14).
import { call } from '../seriesShelf/api';

export const CONF_LABEL = { sure: 'sure', likely: 'likely', unsure: 'unsure' };
export const SCOPE_LABEL = { new: 'New and changed', suggested: 'Open suggestions only', outdated: 'Those suggestions', all: 'Everything you have not decided' };
export const SCOPE_HINT = {
  new: 'Events and series not asked about yet, or whose facts changed since.',
  suggested: 'Only the advice still waiting for you. Cheapest after changing the model.',
  outdated: 'Only the waiting advice that came from another model or an older prompt.',
  all: 'Everything except what you decided yourself. Answers that disagree with what is in place wait for you; nothing changes on its own.',
};
export const askWhat = o => [o.events && `${o.events} event${o.events === 1 ? '' : 's'}`, o.series && `${o.series} series`].filter(Boolean).join(' and ');
// Off / Events only / Events and minis (2026-11-14). The series page's views follow (App reloads its settings).
export const MODE_LABEL = { events: 'Events only', all: 'Events and minis', off: 'Off' };
export const setMode = async mode => {
  const r = await call('POST', '/api/grouping/mode', { mode });
  try { window.dispatchEvent(new Event('omnibus:settings')); } catch {}
  return r;
};
// Turning shelves on or off also changes the series page's views (App reloads its settings).
export const setShelves = async on => {
  const r = await call('POST', '/api/grouping/enabled', { on });
  try { window.dispatchEvent(new Event('omnibus:settings')); } catch {}
  return r;
};
