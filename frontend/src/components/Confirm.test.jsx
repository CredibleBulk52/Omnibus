import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { ConfirmProvider, useConfirm } from './Confirm';
import Modal from './Modal';

let host, root, answer;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); answer = undefined; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function Asker({ danger }) {
  const confirm = useConfirm();
  return <button className="ask" onClick={async () => { answer = await confirm({ title: 'Delete box?', message: 'Gone for good.', confirmLabel: 'Delete', danger }); }}>ask</button>;
}
const open = async danger => {
  await act(async () => root.render(<ConfirmProvider><Asker danger={danger} /></ConfirmProvider>));
  await act(async () => host.querySelector('.ask').click());
};

test('the app dialog asks, and the answer comes back', async () => {
  await open(true);
  expect(host.querySelector('.rl-modal-title').textContent).toBe('Delete box?');
  expect(document.activeElement.textContent).toBe('Cancel');   // destructive: Cancel has focus
  await act(async () => host.querySelector('.confirm-ok').click());
  expect(answer).toBe(true);
  expect(host.querySelector('.rl-modal')).toBeNull();
});

test('Cancel, Escape and the backdrop all answer no', async () => {
  await open(false);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(answer).toBe(false);
  await act(async () => host.querySelector('.ask').click());
  await act(async () => host.querySelector('.confirm-cancel').click());
  expect(answer).toBe(false);
});

test('Escape closes only the top dialog when two are open', async () => {
  const closed = [];
  await act(async () => root.render(<>
    <Modal title="Outer" onClose={() => closed.push('outer')}><p>outer</p></Modal>
    <Modal title="Inner" onClose={() => closed.push('inner')}><p>inner</p></Modal>
  </>));
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(closed).toEqual(['inner']);
});
