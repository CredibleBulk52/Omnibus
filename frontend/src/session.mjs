// Session operations use explicit bearer headers: the reader cookie is read-only.
export async function prepareReaderSession(token, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetcher('/api/auth/reader-session', {
      method: 'POST', credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return 'invalid';
    return response.ok ? 'ready' : 'offline';
  } catch { return 'offline'; }
  finally { clearTimeout(timeout); }
}
export async function revokeSession(token, fetcher = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher('/api/auth/logout', {
      method: 'POST', credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (!response.ok && response.status !== 401) throw new Error('Unable to sign out on the server. Please reconnect and try again.');
  } finally { clearTimeout(timeout); }
}
