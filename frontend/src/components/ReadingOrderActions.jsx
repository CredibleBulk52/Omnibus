import DeleteCatalogAction from './DeleteCatalogAction';
import React, { useState } from 'react';
import { useReadingTheme } from './ReadingTheme';
import ManageMenu from './ManageMenu';
import { ExportMenuItem } from './CuratedTransfer';
import '../readingOrderActions.css';

// Timeline event and Top Shelf run pages: + Add to a box (and ⚑ Report for readers);
// for admins the editor sits behind Manage ⌄, as on reading orders and comic boxes (2026-11-04).
export default function ReadingOrderActions({ name, bookId, onAdd, onEdit, onReport, deletion, exportItem }) {
  const theme = useReadingTheme({ name }, bookId);
  const [open, setOpen] = useState(false);
  return <>
    <div className="order-utility-actions" style={theme.style}>
      <button className="order-list-button" onClick={onAdd}>+ Add to a box</button>
      {onReport && <button className="order-editor-button order-report-button" onClick={onReport} title="Tell the admin about a wrong order or a wrong or missing issue"><span aria-hidden="true">⚑ </span>Report</button>}
    </div>
    {onEdit && <ManageMenu id="order-manage-menu" open={open} setOpen={setOpen}>
      <button onClick={() => { setOpen(false); onEdit(); }}>✎ Open Editor</button>
      {exportItem && <ExportMenuItem {...exportItem} onDone={() => setOpen(false)} />}
    {deletion && <DeleteCatalogAction {...deletion} />}
    </ManageMenu>}
  </>;
}
