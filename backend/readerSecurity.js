'use strict';
const READER_IMAGE = /^\/books\/[^/]+\/(?:pages|page-thumbs)\/[^/]+\/?$/i;
const COOKIE = 'omnibus_reader';
const options = req => ({ httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: '/api/books' });
function setReaderCookie(req, res, token, payload) {
  res.cookie(COOKIE, token, { ...options(req), maxAge: Math.max(0, payload.exp * 1000 - Date.now()) });
  res.set('Cache-Control', 'no-store');
}
function clearReaderCookie(req, res) { res.clearCookie(COOKIE, options(req)); }
function readerToken(req) {
  const header = req.headers.authorization;
  if (header) return header.replace(/^Bearer /, '');
  const value = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  if (!value) return '';
  try { return decodeURIComponent(value.slice(COOKIE.length + 1)); } catch { return ''; }
}
function protectReader(req, res, next, tokens) {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie'); res.vary('Authorization');
  try { req.user = tokens.verify(readerToken(req)); }
  catch { return res.status(401).json({ error: 'Unauthorised' }); }
  next();
}
module.exports = { READER_IMAGE, setReaderCookie, clearReaderCookie, protectReader };
