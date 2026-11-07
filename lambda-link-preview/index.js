// Drex Link Preview — Lambda (Node 20) detrás de una Function URL.
//
//   GET ?url=https://ejemplo.com/articulo
//     -> 200 {"url","host","title","description","image","siteName"}   (campos vacíos si no hay)
//     -> 400 {"error":"bad_url"} | 502 {"error":"fetch_failed"}
//
// Sin dependencias y sin APIs de pago: hace un GET al HTML y lee <meta og:*>/<title>.
// Seguridad (es un fetch de URLs ajenas => riesgo SSRF):
//   - solo http/https, puertos 80/443, sin credenciales en la URL;
//   - resuelve el DNS y rechaza cualquier IP privada/loopback/link-local/metadata (IPv4 e IPv6),
//     y CONECTA a la IP ya validada (evita DNS rebinding);
//   - redirecciones manuales (máx. 3) validando cada salto;
//   - solo text/html, máx. 600 KB, timeout 4 s;
//   - la imagen devuelta solo si es https (si no, se omite); la app la carga con no-referrer.
// Variables opcionales: ALLOWED_ORIGINS (lista separada por comas; vacío = '*').
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 600 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

// Expande una IPv6 a sus 8 grupos numéricos (null si no es válida).
// Acepta '::', forma comprimida, expandida e IPv4 embebida (::ffff:10.0.0.1).
function expandIPv6Groups(ip) {
  const v = String(ip || '').toLowerCase();
  if (v.includes('%')) return null; // zona: fuera de alcance
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const parseSide = (s) => {
    if (s === '') return [];
    const segs = s.split(':');
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.includes('.')) {
        if (i !== segs.length - 1) return null; // la IPv4 solo va al final
        const o = seg.split('.');
        if (o.length !== 4) return null;
        const nums = o.map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
        if (nums.some((n) => n < 0 || n > 255)) return null;
        out.push(((nums[0] << 8) | nums[1]) & 0xffff, ((nums[2] << 8) | nums[3]) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
        out.push(parseInt(seg, 16));
      }
    }
    return out;
  };
  if (halves.length === 1) {
    const gs = parseSide(halves[0]);
    return gs && gs.length === 8 ? gs : null;
  }
  const head = parseSide(halves[0]);
  const tail = parseSide(halves[1]);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    // Se juzga por GRUPOS numéricos, no por el texto: una misma dirección
    // tiene muchas escrituras ('::ffff:a00:1', '0:0:0:0:0:ffff:a00:1',
    // '::ffff:10.0.0.1') y el filtro por prefijo de texto dejaba pasar la
    // forma hexadecimal de IPv4-mapped (::ffff:0a00:0001 = 10.0.0.1,
    // ::ffff:a9fe:a9fe = 169.254.169.254): el fetch llegaba a red interna
    // y al endpoint de metadata. El kernel traduce ::ffff:0:0/96 a la IPv4.
    const g = expandIPv6Groups(ip);
    if (!g) return true; // no interpretable: fail-closed
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    const first = g[0];
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 única-local
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 enlace-local
    if (first >= 0xff00) return true; // ff00::/8 multidifusión
    return false;
  }
  return true; // lo que no es IP válida no se considera seguro
}

export function normalizeTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').slice(0, 2048)); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return null;
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && isPrivateAddress(host.replace(/^\[|\]$/g, ''))) return null;
  u.hash = '';
  return u;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ''; } catch (_) { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}

const clean = (s, n) => decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, n);

export function parseMetadata(html, baseUrl) {
  const head = String(html || '').slice(0, MAX_BYTES);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val !== undefined && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = val;
  }
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = clean(meta['og:title'] || meta['twitter:title'] || titleTag || '', 140);
  const description = clean(meta['og:description'] || meta['twitter:description'] || meta.description || '', 240);
  const siteName = clean(meta['og:site_name'] || '', 60);
  let image = '';
  const rawImg = decodeEntities(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || '').trim();
  if (rawImg) {
    try {
      const iu = new URL(rawImg, baseUrl);
      if (iu.protocol === 'https:' && !iu.username && !iu.password && iu.href.length <= 2048) image = iu.href;
    } catch (_) { /* sin imagen */ }
  }
  return { title, description, image, siteName };
}

async function resolveSafe(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new Error('private_address');
    return { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  }
  const addrs = await dns.lookup(bare, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new Error('private_address');
  return addrs[0];
}

export function getOnce(u, addr) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DrexLinkPreview/1.0)', accept: 'text/html,application/xhtml+xml', 'accept-language': 'es,en;q=0.8' },
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)), // conectar a la IP validada
      servername: u.hostname,
    }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      const type = String(res.headers['content-type'] || '');
      if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) { res.resume(); return reject(new Error('not_html')); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { res.destroy(); resolve({ body: Buffer.concat(chunks).toString('utf8') }); } else chunks.push(c); });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPreview(rawUrl) {
  let u = normalizeTarget(rawUrl);
  if (!u) throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
  const deadline = Date.now() + TIMEOUT_MS + 1000;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() > deadline) throw new Error('timeout');
    const addr = await resolveSafe(u.hostname);
    const r = await getOnce(u, addr);
    if (r.redirect) {
      const next = normalizeTarget(new URL(r.redirect, u).href);
      if (!next) throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
      u = next; continue;
    }
    const md = parseMetadata(r.body, u.href);
    return { url: u.href, host: u.hostname.replace(/^www\./, ''), ...md };
  }
  throw new Error('too_many_redirects');
}

export const handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const allowed = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const cors = { 'access-control-allow-origin': allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || 'GET';
  const json = (statusCode, body, extra = {}) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', ...cors, ...extra }, body: JSON.stringify(body) });
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const url = (event.queryStringParameters && event.queryStringParameters.url) || '';
  if (!normalizeTarget(url)) return json(400, { error: 'bad_url' });
  try {
    const data = await fetchPreview(url);
    return json(200, data, { 'cache-control': 'public, max-age=86400' });
  } catch (e) {
    if (e && e.code === 'bad_url') return json(400, { error: 'bad_url' });
    return json(502, { error: 'fetch_failed' }, { 'cache-control': 'public, max-age=300' });
  }
};
