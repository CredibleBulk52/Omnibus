import { useState, useEffect } from 'react';
import OmnibusLogo from '../components/OmnibusLogo';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function LoginPage() {
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);
  const navigate                  = useNavigate();
  const [params]                  = useSearchParams();
  // SSO only: the admin can hide the username/password form. /login?local=1
  // still shows it, as a fallback if the SSO provider is unavailable.
  const [sso, setSso]             = useState({ configured: false, hide_local_login: false, loaded: false });
  useEffect(() => {
    fetch('/api/auth/oidc-status').then(r => r.json()).then(d => setSso({ ...d, loaded: true })).catch(() => setSso(s => ({ ...s, loaded: true })));
  }, []);
  const forceLocal = params.get('local') === '1';
  const showLocal  = !sso.hide_local_login || forceLocal;
  const showSso    = sso.configured || !sso.loaded;

  // Show any error passed back from OIDC callback
  useEffect(() => {
    const e = params.get('error');
    if (e) setError(decodeURIComponent(e));
  }, [params]);

  const handleLogin = async e => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res  = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed'); setLoading(false); return; }
      localStorage.setItem('omnibus_token', data.token);
      localStorage.setItem('omnibus_user',  JSON.stringify(data.user));
      navigate('/', { replace: true });
    } catch {
      setError('Network error — is the server running?');
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-base)',
    }}>
      <div style={{
        width: 360, background: 'var(--bg-card, var(--om-base))', borderRadius: 12,
        padding: '40px 36px', boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
        {/* Logo / title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <OmnibusLogo style={{
            width: 100, height: 100, borderRadius: '50%',
            filter: 'drop-shadow(0 0 24px color-mix(in srgb, var(--td-yellow) 50%, transparent))',
            margin: '0 auto 12px',
          }} />
          <div style={{
            fontFamily: "'Boogaloo', cursive", fontSize: '1.8rem',
            color: 'var(--color-primary, var(--td-yellow))', letterSpacing: '0.02em',
          }}>Omnibus</div>
          <div style={{ color: 'var(--text-muted, color-mix(in srgb, var(--om-text) 30%, var(--om-base)))', fontSize: '0.8rem', marginTop: 4 }}>
            Sign in to continue
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'color-mix(in srgb, var(--td-red) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--td-red) 30%, transparent)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 20,
            color: '#e88', fontSize: '0.85rem',
          }}>{error}</div>
        )}

        {/* Local login form */}
        {showLocal && <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted, color-mix(in srgb, var(--om-text) 30%, var(--om-base)))', marginBottom: 5 }}>
              Username
            </label>
            <input
              type="text" value={username} autoComplete="username"
              onChange={e => setUsername(e.target.value)}
              style={inputStyle}
              placeholder="username"
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted, color-mix(in srgb, var(--om-text) 30%, var(--om-base)))', marginBottom: 5 }}>
              Password
            </label>
            <input
              type="password" value={password} autoComplete="current-password"
              onChange={e => setPassword(e.target.value)}
              style={inputStyle}
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit" disabled={loading || !username || !password}
            style={primaryBtnStyle(loading)}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>}

        {/* Divider */}
        {showLocal && showSso && <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '22px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.07)' }} />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, color-mix(in srgb, var(--om-text) 30%, var(--om-base)))' }}>or</span>
          <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.07)' }} />
        </div>}

        {/* Authentik SSO button */}
        {showSso && <a href="/api/auth/authentik" style={ssoLinkStyle}>
          <AuthentikIcon />
          Sign in with Authentik
        </a>}
      </div>
    </div>
  );
}

// ── Auth callback page — handles the redirect from Authentik ───────
export function AuthCallbackPage() {
  const navigate     = useNavigate();
  const [params]     = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    // Remove the token from the address bar so it stays out of browser history.
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (token) {
      localStorage.setItem('omnibus_token', token);
      // Fetch user info to store role etc.
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(user => { localStorage.setItem('omnibus_user', JSON.stringify(user)); })
        .finally(() => navigate('/', { replace: true }));
    } else {
      navigate('/login?error=no_token', { replace: true });
    }
  }, [params, navigate]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--bg-base)', color: 'color-mix(in srgb, var(--om-text) 70%, var(--om-base))' }}>
      Completing sign-in…
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────
const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 6, padding: '10px 12px', color: 'var(--om-text)', fontSize: '0.9rem',
  outline: 'none',
};

const primaryBtnStyle = loading => ({
  padding: '11px', borderRadius: 6, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
  background: loading ? 'color-mix(in srgb, var(--td-yellow) 40%, transparent)' : 'var(--color-primary, #f5c518)',
  color: 'var(--om-base)', fontWeight: 700, fontSize: '0.9rem', transition: 'opacity 0.15s',
});

const ssoLinkStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
  padding: '11px', borderRadius: 6, textDecoration: 'none',
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)',
  color: 'color-mix(in srgb, var(--om-text) 75%, var(--om-base))', fontSize: '0.88rem', fontWeight: 500,
  transition: 'background 0.15s',
};

function AuthentikIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
