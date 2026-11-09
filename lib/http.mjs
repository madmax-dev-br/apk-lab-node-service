// Tiny HTTP toolkit shared by the runner and the queue: routing, bounded bodies, JSON errors, bearer-token auth, CORS and Server-Sent Events.
// node:http only, no framework.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, details = undefined) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const badRequest = (message, details) => new HttpError(400, 'bad-request', message, details);
export const notFound = (message = 'Not found') => new HttpError(404, 'not-found', message);

/** Route table: add(method, '/sessions/:id/elements/:key/screenshot.png', handler). Params are URL-decoded. */
export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, options = {}) {
    const wildcard = pattern.endsWith('/*'), base = wildcard ? pattern.slice(0, -2) : pattern;
    const names = [], source = base.split('/').map(part => { if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('/');
    if (wildcard) names.push('*');
    this.routes.push({ method, regex: new RegExp(`^${source}${wildcard ? '(?:/(.*))?' : ''}$`), names, handler, options });
    return this;
  }
  match(method, path) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(path); if (!m) continue; pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {}; route.names.forEach((name, index) => { try { params[name] = name === '*' ? (m[index + 1] ?? '') : decodeURIComponent(m[index + 1]); } catch { throw badRequest(`Malformed path parameter ${name}`); } });
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, 'method-not-allowed', `Method ${method} not allowed on ${path}`);
    return null;
  }
}

/** Reads the request body up to `limit` bytes (413 above it). */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(new HttpError(413, 'too-large', `Body larger than ${limit} bytes`)); return; }
    const chunks = []; let size = 0, failed = false;
    req.on('data', chunk => { if (failed) return; size += chunk.length; if (size > limit) { failed = true; req.resume(); reject(new HttpError(413, 'too-large', `Body larger than ${limit} bytes`)); return; } chunks.push(chunk); });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks, size)); });
    req.on('error', error => { if (!failed) { failed = true; reject(error); } });
  });
}
export async function readJSON(req, limit = 1024 * 1024) {
  const type = String(req.headers['content-type'] ?? '');
  const body = await readBody(req, limit);
  if (!body.length) return {};
  if (type && !/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported-media-type', 'Expected application/json');
  try { return JSON.parse(body.toString('utf8')); } catch { throw badRequest('Body is not valid JSON'); }
}

/** multipart/form-data -> Map(name -> { filename, contentType, data: Buffer }). Bounded by the caller's body limit and maxParts. */
export function parseMultipart(body, contentType, { maxParts = 8 } = {}) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? ''); if (!match) throw badRequest('multipart body without boundary');
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`), parts = new Map();
  let at = body.indexOf(boundary); if (at < 0) throw badRequest('multipart boundary not found');
  while (true) {
    at += boundary.length;
    if (body[at] === 45 && body[at + 1] === 45) break;   // closing "--"
    if (body[at] === 13 && body[at + 1] === 10) at += 2;
    const headerEnd = body.indexOf('\r\n\r\n', at); if (headerEnd < 0) throw badRequest('multipart part without headers');
    const headers = body.subarray(at, headerEnd).toString('utf8'), next = body.indexOf(boundary, headerEnd + 4); if (next < 0) throw badRequest('unterminated multipart part');
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)?.[1] ?? '', name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name !== undefined) {
      if (parts.size >= maxParts) throw badRequest(`more than ${maxParts} multipart parts`);
      let end = next; if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
      parts.set(name, { filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null, contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null, data: body.subarray(headerEnd + 4, end) });
    }
    at = next;
  }
  return parts;
}

export function sendJSON(res, status, value, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
  const body = Buffer.from(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? String(item) : item));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}
export function sendBytes(res, status, type, bytes, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : bytes);
}

/** Constant-time comparison of a presented token with the configured one (both hashed so lengths do not leak). */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented || typeof expected !== 'string' || !expected) return false;
  const a = createHash('sha256').update(presented).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
/** The bearer token of a request: Authorization: Bearer <t>, or ?access_token=<t> on GET (EventSource cannot set headers). */
export function presentedToken(req, url) {
  const header = String(req.headers.authorization ?? ''), m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) return m[1].trim();
  if (req.method === 'GET' || req.method === 'HEAD') return url.searchParams.get('access_token');
  return null;
}

/** CORS for the service's own API: only listed origins (exact match, or '*'), preflights answered here. Returns true when the request was a preflight that is now answered. */
export function applyCors(req, res, origins, { allowHeaders = 'authorization, content-type, x-apk-config, x-client-id, last-event-id', exposeHeaders = 'x-request-id, retry-after, content-disposition', maxAge = 600 } = {}) {
  const origin = req.headers.origin;
  if (!origin || !origins.length) { if (req.method === 'OPTIONS' && origin) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('CORS origin not allowed'); return true; } return false; }
  const allowed = origins.includes('*') || origins.includes(origin);
  res.setHeader('vary', 'Origin');
  if (!allowed) { if (req.method === 'OPTIONS') { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('CORS origin not allowed'); return true; } return false; }
  res.setHeader('access-control-allow-origin', origins.includes('*') ? '*' : origin);
  res.setHeader('access-control-expose-headers', exposeHeaders);
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    const privateNetwork = req.headers['access-control-request-private-network'] === 'true';
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': allowHeaders, 'access-control-max-age': String(maxAge), ...(privateNetwork ? { 'access-control-allow-private-network': 'true' } : {}) });
    res.end(); return true;
  }
  return false;
}
export const parseOrigins = text => String(text ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean).filter(item => item === '*' || /^https?:\/\/[^/\s]+$/.test(item));

/** A Server-Sent Events stream. send(event, data, id?) writes one event; a comment keeps proxies from closing it. close() ends it. */
export function openSSE(req, res, { heartbeatMs = 15000, onClose = () => {} } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': stream open\n\n');
  let closed = false;
  const timer = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, heartbeatMs); timer.unref?.();
  const close = () => { if (closed) return; closed = true; clearInterval(timer); try { res.end(); } catch { /* closed */ } onClose(); };
  req.on('close', close); res.on('error', close);
  return {
    get closed() { return closed; },
    send(event, data, id) { if (closed) return false; const text = JSON.stringify(data, (key, item) => typeof item === 'bigint' ? String(item) : item); return res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${text}\n\n`); },
    close,
  };
}

/**
 * The HTTP server: CORS, auth, routing and error mapping. `authenticate(req, url)` returns a principal or throws; routes with { public: true } skip it.
 * handler(ctx) receives { req, res, url, params, principal } and returns a value (sent as JSON 200) or undefined after writing the response itself.
 */
export function createHttpServer({ router, corsOrigins = [], authenticate, log = () => {}, requestTimeoutMs = 0 }) {
  let seq = 0;
  const server = createServer(async (req, res) => {
    const requestId = `${Date.now().toString(36)}-${(++seq).toString(36)}`; res.setHeader('x-request-id', requestId); res.req = req;
    let url;
    try { url = new URL(req.url, 'http://service.invalid'); } catch { sendJSON(res, 400, { error: { code: 'bad-request', message: 'Malformed URL' } }); return; }
    try {
      if (applyCors(req, res, corsOrigins)) return;
      const found = router.match(req.method, url.pathname);
      if (!found) throw notFound(`No route for ${req.method} ${url.pathname}`);
      const principal = found.route.options.public ? null : await authenticate(req, url);
      const value = await found.route.handler({ req, res, url, params: found.params, principal, requestId });
      if (value !== undefined && !res.headersSent) sendJSON(res, found.route.options.status ?? 200, value);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) log('error', `${req.method} ${url.pathname}: ${error?.stack ?? error}`);
      const headers = error?.retryAfter ? { 'retry-after': String(error.retryAfter) } : {};
      sendJSON(res, status, { error: { code: error?.code && error instanceof HttpError ? error.code : 'internal', message: status >= 500 && !(error instanceof HttpError) ? 'Internal error' : String(error?.message ?? error), ...(error?.details !== undefined ? { details: error.details } : {}) }, requestId }, headers);
    }
  });
  server.requestTimeout = requestTimeoutMs; server.headersTimeout = 30000; server.keepAliveTimeout = 5000;
  return server;
}

export const env = (name, fallback) => { const value = globalThis.process?.env?.[name]; return value === undefined || value === '' ? fallback : value; };
export const envInt = (name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => { const value = Number(env(name, fallback)); if (!Number.isFinite(value)) return fallback; return Math.min(max, Math.max(min, Math.floor(value))); };
export const envBool = (name, fallback = false) => { const value = env(name, null); if (value === null) return fallback; return /^(1|true|yes|on)$/i.test(value); };
