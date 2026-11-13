import CharacterSymbolsSettings from '../components/BrandingSettings';
import React, { useState } from 'react';
import '../comicLibraryAdmin.css';
import PageHeader from '../components/PageHeader';
import AdminGroup, { useOpenGroups } from '../components/AdminGroup';
import MetadataPanel from './MetadataPanel';
import SeriesPage from './SeriesPage';
import { CharacterVerification } from './CVAdminPage';
import { LibrariesSection, PostProcessingSection, PublisherSection, WeeklySection, SettingsStyles, InventoryDownloadBtn } from './SettingsPage';
import { useLibrary } from '../App';
import { AttentionList, DuplicatesPanel, SeriesLinksPanel } from '../components/LibraryHealth';
import { SeriesGroupingPanel } from '../components/SeriesShelf';
import GenreRetag from '../components/GenreRetag';

// ─── LibraryAdminPage (/library) ──────────────────────────────────
// Admin work on the comics themselves, in groups that open in place
// (2026-10-16 reorganization, claude/ADMIN_REORG.md). Libraries & scanning
// first, then the metadata sweeper and the rest of the setup. Replaces CV Admin and
// Settings › No Metadata / Publishers / Libraries / Post-Processing.
// The library health attention list goes at the top (step 2).
export default function LibraryAdminPage() {
  const [health, setHealth] = useState(null);
  const [libraryCount, setLibraryCount] = useState(null);
  const [scanRefresh, setScanRefresh] = useState(0);
  const { activeLibrary, libraries } = useLibrary();
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState(params.get('view') || 'intervention');
  // Every group starts closed so all of them are visible at once (user, 2026-10-16).
  const [open, toggle, openGroup] = useOpenGroups([]);
  // An attention row opens its group (and the sweeper's filter, when it has one).
  const openFrom = (id, nextView) => { if (nextView) setView(nextView); openGroup(id); };
  const [scan, setScan] = useState('');
  const scanAll = async () => {
    setScan('Starting…');
    try {
      const r = await fetch('/api/libraries/scan-all', { method: 'POST' });
      if (r.ok) { setScanRefresh(n => n + 1); openGroup('libraries'); }
      setScan(r.ok ? 'Scan started. Progress shows under Libraries & scanning.' : 'Could not start the scan.');
    } catch { setScan('Could not start the scan.'); }
  };
  const group = (id, title, sub, children, actions = null) => (
    <AdminGroup id={id} title={title} sub={sub} open={open.has(id)} onToggle={toggle} actions={actions}>{children}</AdminGroup>
  );
  return (
    <div className="settings-page comic-library-admin">
      <PageHeader title="LIBRARY" borderSeed={1}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="adm-btn" onClick={scanAll} disabled={scan === 'Starting…'}>⟳ Scan all libraries</button>
          <details className="library-export-menu"><summary>More ▾</summary><div><InventoryDownloadBtn format="md" label="Export inventory · Markdown" /><InventoryDownloadBtn format="json" label="Export inventory · JSON" /></div></details>
          {scan && <small style={{ color: 'var(--text-muted)' }}>{scan}</small>}
        </div>
      </PageHeader>
      <div className="settings-page-body admin-groups" style={{ maxWidth: 1280 }}>
        <AttentionList onOpen={openFrom} compact onHealth={setHealth} />
        {group('libraries', 'Libraries & scanning', 'Library folders, scans and Comic Book Roundup scores', <LibrariesSection compact scanRefresh={scanRefresh} onCount={setLibraryCount} />, <span className="library-group-status">{libraryCount ?? libraries?.length ?? '…'} libraries</span>)}
        {group('metadata', 'Metadata checks', 'Books that need a Comic Vine match, damaged files, and overnight checks',
          <MetadataPanel key={view + ':' + (activeLibrary?.id || 'all')} initialView={view} libraryId={activeLibrary?.id} libraryName={activeLibrary?.name} />)}
        {group('duplicates', 'Duplicate copies', 'The same Comic Vine issue in more than one file', <DuplicatesPanel onOpen={openFrom} />, health && <span className="library-group-status">{health.needsYou.duplicates ? `${health.needsYou.duplicates} flagged` : 'None flagged'}</span>)}
        {group('series-links', 'Series linked to the wrong volume', "Folders whose series.json names a different Comic Vine series than their comics", <SeriesLinksPanel />,
          health && health.needsYou.seriesLinks ? <span className="library-group-status">{health.needsYou.seriesLinks} to check</span> : null)}
        {group('grouping', 'Specials shelves', 'Event minis and one-shots grouped under their home series, and the event homes to check', <SeriesGroupingPanel />)}
        {group('series', 'Series without details', 'Series folders with no series.json yet',
          <SeriesPage maintenance="no-metadata" />, health && <span className="library-group-status">{health.info.seriesWithoutDetails} series</span>)}
        {group('genres', 'Genres', 'The genre list, and retagging series with it (AI)', <GenreRetag />)}
        <div className="library-configuration">Configuration</div>
        {group('processing', 'File processing', 'Naming, folders and automation after downloads', <PostProcessingSection compact />)}
        {group('publishers', 'Publishers & weekly releases', 'Publisher eras and imprints; publishers hidden from weekly releases',
          <><PublisherSection /><WeeklySection /></>)}
        {group('symbols', 'Character symbols', 'Optional shared artwork for character and team heroes', <CharacterSymbolsSettings />)}
        {group('characters', 'Comic Vine characters', 'Character images and overrides from Comic Vine', <CharacterVerification />)}
      </div>
      <SettingsStyles />
    </div>
  );
}
