// The original desktop CSS stays in ListEditor for Comic (OLD), Wood and Panel.
export const readableCss = `
 .le-readable { font-family: system-ui, sans-serif; line-height: 1.5; }
 .le-readable .le-body { max-width: 1440px; padding-top: 20px; }
 .le-readable .le-titles h1 { font: 700 1.25rem/1.4 system-ui, sans-serif; white-space: normal; }
 .le-readable .le-sub, .le-readable .le-meta, .le-readable .le-pos,
 .le-readable .le-hint, .le-readable .le-muted { font-size: .875rem; color: #b8becb; }
 .le-readable .le-bar { flex-wrap: wrap; padding: 10px 0; }
 .le-readable .le-link, .le-readable .le-seg button { font-size: .9375rem; min-height: 36px; }
 .le-readable .le-link, .le-readable .le-seg button, .le-readable .le-back,
 .le-readable .le-more, .le-readable .le-caret, .le-readable .le-tier select,
 .le-readable .le-status > span { color: #b8becb; }
 .le-readable .le-status > span.dirty, .le-readable .le-seg button.on { color: color-mix(in srgb, var(--td-yellow) 50%, var(--om-text)); }
 .le-readable .le-link.danger { color: #f08a8a; }
 .le-readable .le-toolbar-button {
   padding: 5px 12px; border: 1px solid #626a79; border-radius: 5px;
   background: #222731; color: #eceef3; font-weight: 600; line-height: 1.3;
   text-decoration: none; white-space: nowrap; box-shadow: 0 2px 0 #08090d;
 }
 .le-readable .le-toolbar-button:hover { background: #303846; border-color: #a0aabb; color: #fff; text-decoration: none; }
 .le-readable .le-toolbar-button:active { background: #181d25; box-shadow: none; transform: translateY(1px); }
 .le-readable .le-list { border: 1px solid #343943; border-radius: 8px; overflow: hidden; }
 .le-readable .le-item:nth-child(even) { background: rgba(255,255,255,.025); }
 .le-readable .le-item.sel { background: rgba(245,197,24,.1); }
 .le-readable .le-row { grid-template-columns: 18px 20px 32px 40px minmax(0,1fr) auto auto 36px; padding: 10px 12px; font-size: 1rem; }
 .le-readable .le-thumb { width: 40px; height: 60px; }
 .le-readable .le-main { flex-wrap: wrap; gap: 6px 8px; }
 .le-readable .le-label, .le-readable .le-kid-label { white-space: normal; overflow-wrap: anywhere; }
 .le-readable .le-label { font-weight: 600; }
 .le-readable .le-mark { font-size: .75rem; }
 .le-readable .le-grip, .le-readable .le-tick, .le-readable .le-more { opacity: 1; }
 .le-readable .le-more { min-height: 36px; font-size: 1.4rem; background: rgba(255,255,255,.045); }
 .le-readable .le-tick { width: 18px; height: 18px; }
 .le-readable .le-caret { min-width: 24px; min-height: 36px; }
 .le-readable .le-tier select { font-size: .875rem; padding: 8px; border: 1px solid #454b56; border-radius: 5px; }
 .le-readable .le-note { margin: 0 48px 12px 162px; font-size: .9375rem; font-style: normal; line-height: 1.6; color: #c5cbd5; border-left: 2px solid #606777; padding-left: 12px; }
 .le-readable .le-note-edit { margin: 0 48px 12px 162px; width: calc(100% - 210px); font-size: 1rem; }
 .le-readable .le-item.sec { background: #202630; margin-top: 18px; border-block: 1px solid #454b56; }
 .le-readable .le-item.sec .le-row { font-size: .9375rem; color: color-mix(in srgb, var(--td-yellow) 60%, var(--om-text)); letter-spacing: .03em; }
 .le-readable .le-kids { margin-left: 92px; }
 .le-readable .le-kid { grid-template-columns: 18px 40px minmax(0,1fr) auto 36px; padding: 8px 10px; font-size: .9375rem; border-top: 1px solid #30343c; }
 .le-readable .le-d-label, .le-readable .le-details-sum { font-size: .9375rem; }
 .le-readable .le-d-input { font-size: 1rem; padding: 9px 10px; }
 .le-readable .le-menu button { font-size: .9375rem; padding-block: 10px; }
 .le-readable .le-details { background: #14161e; border-color: #343946; border-radius: 8px; }
 .le-readable .le-details-head { padding: 15px 20px; }
 .le-readable .le-details-title { font-size: 1rem; color: #eceef4; }
 .le-readable .le-details.open .le-details-head { border-bottom: 1px solid #343946; }
 .le-readable .le-details.open .le-details-sum { display: none; }
 .le-readable .le-details-head .le-tag { margin-left: auto; }
 .le-readable .le-details-body { padding: 20px; }
 .le-readable .le-d-grid { gap: 18px 24px; }
 .le-readable .le-d-field { min-width: 0; }
 .le-readable .le-d-label { color: #d1d7e2; font-weight: 600; margin-bottom: 7px; }
 .le-readable .le-d-input { background: #0d0f15; color: #eceef4; border-color: #414959; line-height: 1.5; }
 .le-readable textarea.le-d-input { min-height: 135px; padding: 12px; }
 .le-readable .le-d-help { color: #bcc3d0; font-size: .8125rem; line-height: 1.5; margin-top: 7px; }
 .le-readable .le-d-group-name { color: #bcc3d0; font-size: .75rem; letter-spacing: .1em; }
 .le-readable .le-d-group + .le-d-group { margin-top: 20px; padding-top: 18px; border-color: #343946; }
 .le-readable .le-d-danger { justify-content: flex-end; flex-wrap: wrap; margin-top: 20px; padding-top: 10px; border-color: #343946; }
 .le-readable .le-d-danger > span { flex: 1 1 240px; color: #e1bdbe; }
 .le-readable .le-d-danger .le-link { font-size: .875rem; }
 .le-readable .le-order-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; margin: 28px 0 8px; }
 .le-readable .le-order-heading h2 { margin: 0; font: 650 1.125rem/1.5 system-ui, sans-serif; color: #eceef4; }
 .le-readable .le-bar { margin-bottom: 14px; }
 .le-readable .le-seg { background: transparent; gap: 2px; }
 .le-readable .le-seg button { border: 1px solid transparent; border-radius: 5px; }
 .le-readable .le-seg button.on { background: #252a35; border-color: #414959; }
 .le-readable .le-row { padding-block: 15px; grid-template-columns: 18px 20px 32px 40px minmax(0,1fr) 120px 155px 36px; }
 .le-readable .le-meta { white-space: normal; }
 .le-readable .le-tier { min-width: 0; }
 .le-readable .le-tier select { width: 100%; min-width: 0; background: #202631; color: #eceef4; }
 .le-readable .le-more { border: 1px solid #434b5a; border-radius: 5px; background: #242a35; color: #eceef4; }
 .le-readable .le-item:nth-child(even) { background: #171b24; }
 .le-readable .le-item.sel { background: #2b2a20; }
 @media (max-width: 900px) {
  .le-readable .le-details-head { padding: 14px; }
  .le-readable .le-details-body { padding: 16px; }
 }
 .le-readable :is(button,input,select,textarea):focus-visible { outline: 2px solid color-mix(in srgb, var(--td-yellow) 60%, var(--om-text)); outline-offset: 3px; }
`;

// Small-screen access is shared functionality; the archived desktop view is unchanged.
export const responsiveCss = `
 @media (max-width: 900px) {
  .le .le-head { flex-wrap: wrap; gap: 8px; padding: 12px; }
  .le .le-titles { flex-basis: calc(100% - 48px); }
  .le .le-titles h1 { white-space: normal; overflow-wrap: anywhere; }
  .le .le-status { width: 100%; gap: 12px; }
  .le .le-status > span { flex: 1; white-space: normal; font-size: .875rem; }
  .le .le-body { padding: 12px 10px 70px; }
  .le .le-bar { flex-wrap: wrap; gap: 8px 16px; }
  .le .le-seg { flex-wrap: wrap; border-radius: 8px; }
  .le .le-seg button, .le .le-link { min-height: 40px; }
  .le .le-row { grid-template-columns: 22px 32px 40px minmax(0,1fr) 40px; gap: 6px; padding: 10px 8px; }
  .le .le-row > :nth-child(1) { display: none; }
  .le .le-row > :nth-child(2) { grid-column: 1; grid-row: 1; }
  .le .le-row > :nth-child(3) { grid-column: 2; grid-row: 1; }
  .le .le-row > :nth-child(4) { grid-column: 3; grid-row: 1; }
  .le .le-row > :nth-child(5) { grid-column: 4; grid-row: 1; }
  .le .le-row > :nth-child(6) { grid-column: 3 / 5; grid-row: 2; white-space: normal; }
  .le .le-row > :nth-child(7) { grid-column: 3 / 5; grid-row: 3; }
  .le .le-row > :nth-child(8) { grid-column: 5; grid-row: 1; }
  .le .le-row > :nth-child(6):empty, .le .le-row > :nth-child(7):empty { display: none; }
  .le .le-main { flex-wrap: wrap; }
  .le .le-label, .le .le-kid-label { white-space: normal; overflow-wrap: anywhere; }
  .le .le-tick, .le .le-more { opacity: 1; }
  .le .le-more, .le .le-caret { min-height: 40px; }
  .le .le-note, .le .le-note-edit { margin: 0 12px 12px 74px; width: calc(100% - 86px); box-sizing: border-box; }
  .le .le-reason-ask { padding: 0 12px 12px 74px; }
  .le .le-kids { margin-left: 24px; }
  .le .le-kid { grid-template-columns: 40px minmax(0,1fr) 40px; gap: 8px; }
  .le .le-kid > :first-child { display: none; }
  .le .le-kid > :nth-child(2) { grid-column: 1; grid-row: 1; }
  .le .le-kid > :nth-child(3) { grid-column: 2; grid-row: 1; }
  .le .le-kid > :nth-child(4) { grid-column: 2; grid-row: 2; white-space: normal; }
  .le .le-kid > :last-child { grid-column: 3; grid-row: 1; }
  .le .le-pill { max-width: calc(100vw - 24px); width: max-content; box-sizing: border-box; flex-wrap: wrap; border-radius: 10px; bottom: calc(68px + env(safe-area-inset-bottom)); white-space: normal; padding: 8px; }
  .le .le-pill button { min-height: 40px; }
  .le .le-menu { max-width: calc(100vw - 24px); max-height: min(320px, 50dvh); }
  .le .le-menu button { min-height: 44px; }
  .le :is(input,textarea,select) { font-size: 16px; }
  .le .le-d-grid, .le .le-d-cat, .le .le-d-event-pick { grid-template-columns: minmax(0,1fr); }
  .le .le-d-creator { grid-template-columns: minmax(0,1fr) minmax(80px,.7fr) 32px; }
  .le .le-d-danger, .le .le-dialog-head, .le .le-dialog-search, .le .le-aw-search, .le .le-tw-foot, .le .le-aw-mode { flex-wrap: wrap; }
  .le .le-dialog, .le .le-iw, .le .le-aw { max-height: 92dvh; }
  .le .le-dialog-head { flex-shrink: 0; }
  .le .le-dialog-head { position: relative; padding-right: 48px; }
  .le .le-dialog-head .le-x { position: absolute; right: 8px; top: 8px; min-width: 36px; min-height: 36px; }
  .le .le-aw-search > .le-input:first-child, .le .le-dialog-search > .le-input:first-child { flex-basis: 100%; }
  .le .le-aw-body { grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(100px, .8fr) minmax(130px,1.2fr); }
  .le .le-aw-left { border-bottom: 1px solid var(--border-subtle); }
  .le .le-iw-body { grid-template-columns: minmax(0,1fr); overflow-y: auto; }
  .le .le-iw-cover { width: 100px; }
  .le .le-iw-right { min-height: 280px; }
  .le .le-tw-row { flex-wrap: wrap; gap: 10px; }
  .le .le-tw-text { flex: 1 1 180px; }
  .le .le-tw-cover { width: 48px; height: 72px; }
 }
`;
