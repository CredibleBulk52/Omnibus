import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal';

// ─── Shared confirmation (2026-10-26) ─────────────────────────────
// Replaces the browser's grey confirm() pop-up with the app's own dialog.
//   const confirm = useConfirm();
//   if (!(await confirm({ title: 'Delete box?', message: '…', confirmLabel: 'Delete', danger: true }))) return;
// A plain string works too: await confirm('Remove this?'). Cancel is focused first
// for destructive actions, so Enter never deletes by accident.
const ConfirmContext = createContext(async message => window.confirm(typeof message === 'string' ? message : message?.message || ''));

export function ConfirmProvider({ children }) {
  const [ask, setAsk] = useState(null);
  const resolver = useRef(null);
  const confirm = useCallback(options => new Promise(resolve => {
    resolver.current = resolve;
    setAsk(typeof options === 'string' ? { message: options } : options || {});
  }), []);
  const answer = useCallback(value => { resolver.current?.(value); resolver.current = null; setAsk(null); }, []);
  const cancel = useCallback(() => answer(false), [answer]);
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {ask && (
        <Modal title={ask.title || 'Are you sure?'} onClose={cancel} width={440}
          initialFocus={ask.danger ? '.confirm-cancel' : '.confirm-ok'}
          footer={<>
            <button type="button" className="btn btn-ghost confirm-cancel" onClick={cancel}>{ask.cancelLabel || 'Cancel'}</button>
            <button type="button" className={`btn ${ask.danger ? 'btn-danger' : 'btn-primary'} confirm-ok`} onClick={() => answer(true)}>{ask.confirmLabel || 'OK'}</button>
          </>}>
          <div className="rl-modal-body confirm-message">{ask.message}</div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
