// InstallBanner.jsx
// Shows an "Add to Home Screen" prompt on mobile browsers.
// Strategy: always show on mobile if not already running as installed PWA.
// Dismissal is session-only (sessionStorage) — reappears on next visit.
// This is intentional: we want mobile users to install the app.

import React, { useState, useEffect } from 'react';

const SESSION_KEY = 'omnibus_pwa_banner_dismissed';

function isRunningAsApp() {
  if (window.navigator.standalone === true) return true;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  return false;
}

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) && !window.MSStream) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
}

export default function InstallBanner() {
  const [show, setShow]         = useState(false);
  const [platform, setPlatform] = useState(null);
  const [deferredPrompt, setDeferred] = useState(null);

  useEffect(() => {
    if (isRunningAsApp()) return;
    if (!isMobileBrowser()) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;

    const p = getPlatform();
    if (!p) return;

    setPlatform(p);

    if (p === 'android') {
      const handler = (e) => {
        e.preventDefault();
        setDeferred(e);
      };
      window.addEventListener('beforeinstallprompt', handler);
      // Show banner regardless — even without the native prompt we guide
      // users to the Chrome menu option
      setShow(true);
      return () => window.removeEventListener('beforeinstallprompt', handler);
    }

    if (p === 'ios') {
      setShow(true);
    }
  }, []);

  function dismiss() {
    sessionStorage.setItem(SESSION_KEY, '1');
    setShow(false);
  }

  async function handleInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') setShow(false);
      setDeferred(null);
    }
  }

  if (!show) return null;

  const s = {
    banner: {
      position: 'fixed',
      bottom: 60,
      left: 12,
      right: 12,
      zIndex: 9000,
      background: 'var(--om-base)',
      border: '1px solid color-mix(in srgb, var(--td-yellow) 33%, transparent)',
      borderRadius: 12,
      padding: '14px 14px 14px 16px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
    },
    icon: { fontSize: 26, lineHeight: 1, flexShrink: 0, marginTop: 1 },
    body: { flex: 1, minWidth: 0 },
    title: { color: 'var(--td-yellow)', fontSize: 13, fontWeight: 700, marginBottom: 4 },
    text: { color: 'color-mix(in srgb, var(--om-text) 60%, var(--om-base))', fontSize: 12, lineHeight: 1.55 },
    em: { color: 'color-mix(in srgb, var(--om-text) 75%, var(--om-base))', fontWeight: 600 },
    actions: { display: 'flex', gap: 8, marginTop: 10 },
    btnInstall: {
      background: 'var(--td-yellow)', color: 'color-mix(in srgb, var(--om-base) 75%, black)', border: 'none',
      borderRadius: 6, padding: '7px 16px', fontSize: 12,
      fontWeight: 700, cursor: 'pointer', flexShrink: 0,
    },
    btnDismiss: {
      background: 'none', color: 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))', border: '1px solid color-mix(in srgb, var(--om-base) 95%, white)',
      borderRadius: 6, padding: '7px 12px', fontSize: 12, cursor: 'pointer',
    },
    close: {
      background: 'none', border: 'none', color: 'color-mix(in srgb, var(--om-text) 30%, var(--om-base))',
      fontSize: 20, cursor: 'pointer', padding: '0 2px',
      flexShrink: 0, lineHeight: 1,
    },
  };

  return (
    <div style={s.banner}>
      <div style={s.icon}>📚</div>
      <div style={s.body}>
        <div style={s.title}>Install Omnibus</div>

        {platform === 'android' && (
          <>
            <div style={s.text}>
              {deferredPrompt
                ? <>Tap <span style={s.em}>Add to Home Screen</span> below to install Omnibus for full-screen reading and offline access.</>
                : <>Open the <span style={s.em}>Chrome menu (⋮)</span> and tap <span style={s.em}>"Add to Home Screen"</span> to install Omnibus.</>
              }
            </div>
            <div style={s.actions}>
              {deferredPrompt && (
                <button style={s.btnInstall} onClick={handleInstall}>Add to Home Screen</button>
              )}
              <button style={s.btnDismiss} onClick={dismiss}>Not now</button>
            </div>
          </>
        )}

        {platform === 'ios' && (
          <>
            <div style={s.text}>
              Tap <span style={s.em}>Share ⎋</span> at the bottom of Safari,
              then <span style={s.em}>"Add to Home Screen"</span> to install
              Omnibus for offline reading.
            </div>
            <div style={s.actions}>
              <button style={s.btnDismiss} onClick={dismiss}>Got it</button>
            </div>
          </>
        )}
      </div>
      <button style={s.close} onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
