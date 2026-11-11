import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage, { ConnectionsSection } from './SettingsPage';
vi.mock('../App', () => ({InfoTip: () => null, isAdmin: () => true, authHeader: () => ({})}));
vi.mock('../components/PageStats', () => ({ default: () => <span>Old page statistics</span> }));
vi.mock('../components/PageHeader', () => ({ default: ({title,children}) => <header>{title}{children}</header> }));
let host, root;
const render = node => act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
beforeEach(() => {
 global.IS_REACT_ACT_ENVIRONMENT = true;
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 global.fetch=vi.fn(async()=>({ok:true,json:async()=>({cv_api_key:'test-cv',ai_key:'do-not-save',anthropic_api_key:'do-not-save',prowlarr_url:'http://example.test'})}));
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
test('settings shows all five groups', async()=>{
 await render(<SettingsPage />);
 expect(host.querySelector('.comic-settings')).not.toBeNull();
 expect(host.querySelectorAll('.admin-group')).toHaveLength(5);
 expect(host.textContent).not.toContain('Old page statistics');
});
test('compact connections preserves fields, every service test, and excludes AI keys when saving',async()=>{
 await render(<ConnectionsSection />);
 const originalLabels=[...host.querySelectorAll('.form-label')].map(e=>e.textContent);
 await render(<ConnectionsSection compact />);
 expect([...host.querySelectorAll('.form-label')].map(e=>e.textContent)).toEqual(originalLabels);
 const tests=[...host.querySelectorAll('button')].filter(b=>b.textContent==='Test');
 expect(tests).toHaveLength(6);   // Comic Vine, Metron, Prowlarr, SABnzbd, two qBittorrent
 for(const b of tests) await act(async()=>b.click());
 for(const service of ['comicvine','metron','prowlarr','sabnzbd','qbittorrent?which=manga','qbittorrent?which=comic']) expect(fetch).toHaveBeenCalledWith('/api/settings/test/'+service);
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save Changes').click());
 const save=fetch.mock.calls.find(([,o])=>o?.method==='POST');
 expect(JSON.parse(save[1].body)).toEqual({cv_api_key:'test-cv',prowlarr_url:'http://example.test'});
});
