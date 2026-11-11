import React from 'react';
import './NavigationIcons.css';

// Shared by desktop navigation and mobile groups. Labels provide accessible names.
function InkIcon({ children }) {
  return <svg className="om-nav-art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">{children}</svg>;
}

export function HomeIcon() { return <InkIcon><path d="M3 8q10-4 21 2 11-6 21-2v32q-11-4-21 1-11-5-21-1Z"/><path className="cut" d="M7 12q7-2 15 1v23q-8-3-15-1ZM26 13q8-3 15-1v23q-7-2-15 1Z"/><path className="detail" d="M24 11v30"/><g transform="translate(3 14) scale(.46)"><path className="burst" d="m24 7 2 8 6-5-1 8 9-2-6 6 9 3-9 3 5 7-8-3-1 9-5-7-5 6 1-9-8 3 5-7-8-3 9-2-5-7 8 4Z"/></g><path d="m29 17 9-2v7l-9 1ZM29 27l9-1v5l-9 1Z" stroke="none"/></InkIcon>; }

export function CollectionsIcon() { return <InkIcon><path d="m3 23 23-14 19 6v23L23 47 3 40Z"/><path className="cut" d="m7 23 20-11 14 4-19 12Z"/><path d="m25 5 16 5v14l-16-5Z"/><path d="m20 8 16 5v14l-16-5Z"/><path d="m15 11 16 5v14l-16-5Z"/><path d="m10 14 16 5v14l-16-5Z"/><path d="m5 17 16 5v14l-16-5Z"/><path d="m3 27 20 6 22-13v18L23 47 3 40Z"/><path className="detail" d="M23 33v14M25 34l18-10"/><path className="cut" d="m8 32 10 3v4l-10-3Z"/></InkIcon>; }

export function MyBoxesIcon() { return <InkIcon><g transform="translate(17 0) scale(.64)"><path d="m3 23 23-14 19 6v23L23 47 3 40Z"/><path className="cut" d="m7 23 20-11 14 4-19 12Z"/><path d="m25 5 16 5v14l-16-5Z"/><path d="m20 8 16 5v14l-16-5Z"/><path d="m15 11 16 5v14l-16-5Z"/><path d="m10 14 16 5v14l-16-5Z"/><path d="m5 17 16 5v14l-16-5Z"/><path d="m3 27 20 6 22-13v18L23 47 3 40Z"/><path className="detail" d="M23 33v14M25 34l18-10"/><path className="cut" d="m8 32 10 3v4l-10-3Z"/></g><g transform="translate(0 15) scale(.67)"><path d="m3 23 23-14 19 6v23L23 47 3 40Z"/><path className="cut" d="m7 23 20-11 14 4-19 12Z"/><path d="m25 5 16 5v14l-16-5Z"/><path d="m20 8 16 5v14l-16-5Z"/><path d="m15 11 16 5v14l-16-5Z"/><path d="m10 14 16 5v14l-16-5Z"/><path d="m5 17 16 5v14l-16-5Z"/><path d="m3 27 20 6 22-13v18L23 47 3 40Z"/><path className="detail" d="M23 33v14M25 34l18-10"/><path className="cut" d="m8 32 10 3v4l-10-3Z"/></g></InkIcon>; }

export function PullBoxIcon() { return <InkIcon><g transform="translate(0 9) scale(.8)"><path d="m3 23 23-14 19 6v23L23 47 3 40Z"/><path className="cut" d="m7 23 20-11 14 4-19 12Z"/><path d="m25 5 16 5v14l-16-5Z"/><path d="m20 8 16 5v14l-16-5Z"/><path d="m15 11 16 5v14l-16-5Z"/><path d="m10 14 16 5v14l-16-5Z"/><path d="m5 17 16 5v14l-16-5Z"/><path d="m3 27 20 6 22-13v18L23 47 3 40Z"/><path className="detail" d="M23 33v14M25 34l18-10"/><path className="cut" d="m8 32 10 3v4l-10-3Z"/></g><g transform="rotate(12 34.5 14)"><path d="M27 3h15v22H27Z"/><path className="cut" d="M29 5h11v18H29Z"/><g transform="translate(34.5 14) scale(.26) translate(-24 -24.5)"><path className="burst" d="M23 7 27 17 35 11 32 21 42 23 32 27 38 36 28 32 25 42 21 32 11 38 16 28 6 24 16 21 10 11 21 16Z"/></g></g><path className="detail light-line" d="M17 3v10m-4-3 4 4 4-4"/></InkIcon>; }

export function SeriesIcon() { return <InkIcon><path d="M3 13 22 5 35 35 16 43Z"/><path d="M12 7 34 5 38 40 16 42Z"/><g transform="rotate(10 30.5 26)"><path d="M19 8h23v36H19Z"/><path className="cut" d="M22 11h17v30H22Z"/><g transform="translate(30.5 26) scale(.4) translate(-24 -24.5)"><path className="burst" d="M23 7 27 17 35 11 32 21 42 23 32 27 38 36 28 32 25 42 21 32 11 38 16 28 6 24 16 21 10 11 21 16Z"/></g></g></InkIcon>; }

export function CanonIcon() { return <InkIcon><path d="M11 9H3v9q0 10 13 11M37 9h8v9q0 10-13 11"/><path className="cut" d="M7 13h5v10q-5-1-5-6ZM36 13h5v4q0 5-5 6Z"/><path d="M11 4h26v12q0 13-10 15v7h8v7H13v-7h8v-7Q11 29 11 16Z"/><path className="cut" d="m24 10 3 6 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1Z"/></InkIcon>; }

export function EssentialsIcon() { return <InkIcon><path d="M6 4h29v39H6Z"/><path className="cut" d="M10 8h21v31H10Z"/><path className="detail light-line" d="M14 33h11q6 0 6-6t-6-6h-6q-5 0-5-5t5-5h5"/><circle cx="14" cy="33" r="3"/><path d="m23 6 7 5-7 5Z"/></InkIcon>; }

export function EventsIcon() { return <InkIcon><path className="detail light-line" d="M5 36h36M12 22v14M25 31v5M38 22v14"/><path d="M2 5h16v19H2ZM18 13h15v19H18ZM31 4h15v19H31Z"/><path className="cut" d="m6 18 5-8 3 9ZM22 17h7v10h-7ZM35 9h7v4h-7Z"/><path d="m38 31 8 5-8 5Z"/></InkIcon>; }

export function OfflineIcon() { return <InkIcon><rect x="5" y="2" width="31" height="44" rx="3"/><path className="cut" d="M9 7h23v31H9Z"/><path d="m22 10-10 16h8l-3 10 12-16h-8Z"/><circle className="cut" cx="20" cy="42" r="1.5"/><circle cx="36" cy="35" r="11"/><path className="detail" d="m30 35 4 4 8-9"/></InkIcon>; }

export function DownloadMgrIcon() { return <InkIcon><path d="M4 30h9l4 7h14l4-7h9v14H4Z"/><path d="M18 3h12v16h10L24 35 8 19h10Z"/></InkIcon>; }

export function CVAdminIcon() { return <InkIcon><path d="M4 4h40v40H4Z"/><path className="cut" d="M9 9h30v12H9ZM9 27h30v12H9Z"/><path className="detail light-line" d="M15 10v10M22 10v10M28 11l4 8M15 28v10M22 28v10M30 28v10"/></InkIcon>; }

export function SettingsIcon() { return <InkIcon><path d="m19 3 10 0 2 7 6 3 7-1 4 9-6 5-1 6 3 6-7 7-7-4-6 1-5 6-9-4 1-7-3-6-7-2V19l7-2 3-6-1-7 9-4Z" transform="translate(2 2) scale(.9)"/><circle className="cut" cx="24" cy="24" r="8"/></InkIcon>; }

