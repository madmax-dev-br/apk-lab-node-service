// The runner's private-network guard. The session default reaches every host (allowedHosts ["*"], like the site for a new visitor), but a server is not a visitor's
// browser: from it, "every host" would include the server's own loopback services, its private network and the cloud metadata endpoint. So every HTTP exchange the VM
// makes resolves its host name first (dns.lookup, all addresses) and is refused when any address is loopback (127.0.0.0/8, ::1), private (RFC 1918: 10/8, 172.16/12,
// 192.168/16; unique local fc00::/7), link-local (169.254.0.0/16 -- cloud metadata included --, fe80::/10) or unspecified (0.0.0.0/8, ::), unless the operator set
// RUNNER_ALLOW_PRIVATE_NETWORK=1. Each redirect hop is a new exchange (the Java side follows them), so it is checked too. The refusal is an error the lab turns into a
// java.io.IOException naming the policy. Endpoint mocks answer before any exchange and never get here.
// Limit: the address is resolved here and again by the HTTP client; a host whose DNS answer changes between the two lookups (DNS rebinding) is not caught.
import dns from 'node:dns';
import net from 'node:net';

export const PRIVATE_NETWORK_CODE = 'APKLAB_PRIVATE_NETWORK';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function ipv4Kind(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  return null;
}
/** The eight 16-bit groups of an IPv6 address (with an embedded IPv4 tail expanded). */
function ipv6Groups(address) {
  let text = address.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) { const [a, b, c, d] = v4[1].split('.').map(Number); text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map(group => parseInt(group || '0', 16));
}
/** 'loopback' | 'private' | 'link-local' | 'unspecified' for an address the guard refuses, null for a public one (or text that is not an IP address). */
export function privateAddressKind(input) {
  const address = String(input ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(address);
  if (family === 4) return ipv4Kind(address);
  if (family !== 6) return null;
  const g = ipv6Groups(address);
  if (g.every(x => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return 'loopback';
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return ipv4Kind(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);   // IPv4-mapped
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';      // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';   // fe80::/10
  return null;
}
export const isPrivateAddress = address => privateAddressKind(address) !== null;

export function privateNetworkError(host, address, kind) {
  const error = new Error(`RUNNER_ALLOW_PRIVATE_NETWORK: the runner's network policy refuses ${host}${address !== host ? ` (${address})` : ''}, a ${kind} address; loopback, private and link-local targets are reachable only when the operator sets RUNNER_ALLOW_PRIVATE_NETWORK=1`);
  return Object.assign(error, { name: 'NetworkPolicyError', code: PRIVATE_NETWORK_CODE, host, address, kind });
}

/** Resolves `hostname` (every address) and throws the policy error when one is loopback, private, link-local or unspecified. Lookup failures are thrown as they are. */
export async function assertPublicHost(hostname, { lookup = dns.promises.lookup } = {}) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  const literal = net.isIP(host.replace(/%.*$/, '')) ? [{ address: host }] : null;
  const addresses = literal ?? await lookup(host, { all: true, verbatim: true });
  for (const { address } of addresses) { const kind = privateAddressKind(address); if (kind) throw privateNetworkError(host, address, kind); }
  return addresses.map(entry => entry.address);
}

/**
 * fetch with the guard in front of every http(s) request. Redirects asked to be followed (redirect: 'follow', fetch's default) are followed here hop by hop so each
 * target is checked; the lab itself asks for manual redirects outside a browser. Other schemes go to `baseFetch` untouched.
 */
export function createGuardedFetch(baseFetch, { allowPrivate = false, lookup } = {}) {
  if (allowPrivate) return baseFetch;
  return async function guardedFetch(input, init = {}) {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input);
    let url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return baseFetch(input, init);
    await assertPublicHost(url.hostname, { lookup });
    const mode = init?.redirect ?? (typeof input === 'object' ? input?.redirect : undefined) ?? 'follow';
    if (mode !== 'follow') return baseFetch(input, init);
    let request = { ...init, redirect: 'manual' }, target = input;
    for (let hop = 0; hop <= 20; hop++) {
      const response = await baseFetch(target, request), location = response.headers.get('location');
      if (!REDIRECTS.has(response.status) || !location) { if (hop) { Object.defineProperty(response, 'redirected', { value: true }); Object.defineProperty(response, 'url', { value: url.href }); } return response; }
      try { await response.body?.cancel(); } catch { /* ignored */ }
      url = new URL(location, url); target = url.href;
      const method = String(request.method ?? 'GET').toUpperCase();
      if (response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST') { request = { ...request, method: 'GET' }; delete request.body; }
      await assertPublicHost(url.hostname, { lookup });
    }
    throw new TypeError('fetch failed: too many redirects');
  };
}
