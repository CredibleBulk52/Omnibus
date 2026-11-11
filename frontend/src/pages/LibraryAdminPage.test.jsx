import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { LibrariesSection, PostProcessingSection, SettingsStyles } from './SettingsPage';
import { AttentionList } from '../components/LibraryHealth';

vi.mock('../App', () => ({ InfoTip: () => null, isAdmin: () => true, authHeader: () => ({}) }));
let root, host, libraries;
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));
const render = node => act(async () => root.render(<MemoryRouter>{node}<SettingsStyles /></MemoryRouter>));
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  libraries = Array.from({length: 4}, (_, i) => ({id: i + 1, name: `Library ${i + 1}`, path: `/comics/${i + 1}`, seriesCount: 12, scan_interval_hours: 0}));
  global.fetch = vi.fn(async url => ({ok:true, json: async () => url === '/api/libraries' ? libraries : url === '/api/settings' ? {file_format:'$Series $Issue ($Year)',folder_format:'$Series ($Year)'} : url === '/api/admin/library-health' ? {badge:2,needsYou:{stuck:2,damaged:0,unsafe:0,duplicates:0,failedDownloads:0,heldDownloads:0,requests:0},info:{noCvId:0,seriesWithoutDetails:15}} : {running:false,cached:2,total:4}}));
  window.confirm = vi.fn(() => false);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

test('compact library list retains every folder, schedule update and delete confirmation', async () => {
  await render(<LibrariesSection compact />);
  expect(host.querySelectorAll('.library-row')).toHaveLength(3);
  await act(async () => button('Show all 4').click());
  expect(host.querySelectorAll('.library-row')).toHaveLength(4);
  await act(async () => { const select = host.querySelector('.library-meta select'); select.value='6'; select.dispatchEvent(new Event('change',{bubbles:true})); });
  expect(fetch).toHaveBeenCalledWith('/api/libraries/1',expect.objectContaining({method:'PATCH',body:JSON.stringify({scan_interval_hours:6})}));
  await act(async () => button('Remove library').click());
  expect(window.confirm).toHaveBeenCalled();
  expect(fetch.mock.calls.some(([,opts]) => opts?.method === 'DELETE')).toBe(false);
  expect(button('Scan All')).toBeUndefined();
  expect(button('Fetch scores')).toBeDefined();
  await act(async () => button('+ Add Library').click());
  expect(button('Browse')).toBeDefined();
  expect(button('Add & Scan')).toBeDefined();
});

test('legacy library controls retain their original actions and all rows', async () => {
  await render(<LibrariesSection />);
  expect(host.querySelectorAll('.library-row')).toHaveLength(4);
  expect(button('Scan All')).toBeDefined();
  expect(button('Fetch CBR Scores')).toBeDefined();
  expect(host.querySelector('.library-row-menu')).toBeNull();
});

test('compact health keeps actionable routes and all zero checks available', async () => {
  const open=vi.fn(); await render(<AttentionList compact onOpen={open} />);
  expect(host.querySelector('.health-all')).not.toBeNull();
  await act(async () => button('Books stuck for a match').click());
  expect(open).toHaveBeenCalledWith('metadata','intervention');
  await act(async () => button('Series without details').click());
  expect(open).toHaveBeenCalledWith('series');
  expect(host.querySelector('.health-all').textContent).toContain('Unsafe archive paths');
});

test('filename example is display-only and saves the actual template', async () => {
  await render(<PostProcessingSection compact />);
  expect(host.querySelector('.library-name-example').textContent).toContain('Secret Wars 001 (1984).cbz');
  expect(button('Download Markdown')).toBeUndefined();
  await act(async () => button('Save Changes').click());
  expect(fetch).toHaveBeenCalledWith('/api/settings',expect.objectContaining({method:'POST',body:JSON.stringify({file_format:'$Series $Issue ($Year)',folder_format:'$Series ($Year)'})}));
});

test('opening compact libraries reconnects to an already-running scan', async () => {
  const original=fetch.getMockImplementation();
  fetch.mockImplementation(async (url,...args) => url === '/api/scan/status' ? {ok:true,json:async()=>({running:true,libraryId:2,total:10,progress:4,currentPath:'/comics/2'})} : original(url,...args));
  await render(<LibrariesSection compact />);
  expect(host.querySelector('.scan-progress').textContent).toContain('4 / 10');
  expect(host.querySelectorAll('.library-row')).toHaveLength(4);
  expect(host.querySelector('.library-meta select').disabled).toBe(true);
});
