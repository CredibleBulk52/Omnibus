'use strict';
// Outgoing-request guard (security review 2026-11-12). A download address that a
// user supplies must be a plain http(s) URL on the public internet: never this
// server, the home network, or a cloud metadata address.
const dns = require('node:dns');
const net = require('node:net');

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (mapped) return isPublicAddress(mapped[1]);
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const refuse = message => Object.assign(new Error(message), { status: 400, code: 'UNSAFE_URL' });

// Resolves to the parsed URL, or throws an error with status 400.
async function assertPublicHttpUrl(value, { lookup = dns.promises.lookup } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw refuse('Download address is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('Download address must start with http:// or https://');
  if (url.username || url.password) throw refuse('Download address must not contain a user name or password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^localhost$/i.test(host) || /\.(localhost|local|internal|lan|home\.arpa)$/i.test(host)) throw refuse('Download address must be on the public internet');
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await lookup(host, { all: true, verbatim: true })).map(a => a.address); }
    catch { throw refuse('Download address could not be resolved'); }
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) throw refuse('Download address must be on the public internet');
  return url;
}

module.exports = { assertPublicHttpUrl, isPublicAddress };
