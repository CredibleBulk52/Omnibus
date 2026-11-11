'use strict';
// Build cookies for this request URL, never borrowing another site's session.
function cachedDownloadHeaders(url, cache, base = {}, now = Date.now()) {
  const target = new URL(url), headers = { ...base };
  for (const key of Object.keys(headers)) if (key.toLowerCase() === 'cookie') delete headers[key];
  const cached = cache.get(target.hostname);
  if (!cached || cached.expiry <= now) return headers;
  if (cached.userAgent) headers['User-Agent'] = cached.userAgent;
  const cookies = (cached.cookies || []).filter(c => {
    if (typeof c.name !== 'string' || typeof c.value !== 'string' || /[;\r\n]/.test(c.name + c.value)) return false;
    if (c.secure && target.protocol !== 'https:') return false;
    if (c.expires > 0 && c.expires * 1000 <= now) return false;
    const domain = String(c.domain || target.hostname).toLowerCase();
    if (domain.startsWith('.')) {
      if (target.hostname !== domain.slice(1) && !target.hostname.endsWith(domain)) return false;
    } else if (target.hostname !== domain) return false;
    const scope = c.path || '/';
    return target.pathname === scope || (target.pathname.startsWith(scope) && (scope.endsWith('/') || target.pathname[scope.length] === '/'));
  });
  if (cookies.length) headers.Cookie = cookies.map(c => c.name + '=' + c.value).join('; ');
  return headers;
}
module.exports = { cachedDownloadHeaders };
