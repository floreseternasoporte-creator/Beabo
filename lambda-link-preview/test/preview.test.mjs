import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, normalizeTarget, parseMetadata, decodeEntities, handler } from '../index.js';

test('isPrivateAddress bloquea rangos internos y metadata', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'no-es-ip'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
test('normalizeTarget solo acepta http(s) públicas simples', () => {
  assert.equal(normalizeTarget('https://example.com/a?b=1#x').href, 'https://example.com/a?b=1');
  for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'https://user:pw@example.com', 'https://example.com:8080/', 'http://intranet.local/', 'nada', '', 'http://169.254.169.254/latest/meta-data'])
    assert.equal(normalizeTarget(bad), null, bad);
});
test('parseMetadata lee og:*, resuelve imagen relativa y exige https', () => {
  const html = '<html><head><title>Fallback</title><meta property="og:title" content="Hola &amp; adiós"><meta property="og:description" content="Una &quot;desc&quot;"><meta property="og:image" content="/img/a.png"><meta property="og:site_name" content="Sitio"></head></html>';
  const r = parseMetadata(html, 'https://example.com/post');
  assert.deepEqual(r, { title: 'Hola & adiós', description: 'Una "desc"', image: 'https://example.com/img/a.png', siteName: 'Sitio' });
  assert.equal(parseMetadata('<meta property="og:image" content="http://x.com/a.png">', 'https://x.com').image, '');
  assert.equal(parseMetadata('<meta property="og:image" content="javascript:alert(1)">', 'https://x.com').image, '');
  assert.equal(parseMetadata('<title> Solo título </title>', 'https://x.com').title, 'Solo título');
});
test('decodeEntities', () => { assert.equal(decodeEntities('&#65;&#x42;&amp;&lt;'), 'AB&<'); });
test('handler: valida método y url sin salir a la red', async () => {
  assert.equal((await handler({ requestContext: { http: { method: 'POST' } } })).statusCode, 405);
  assert.equal((await handler({ requestContext: { http: { method: 'GET' } }, queryStringParameters: { url: 'http://127.0.0.1/' } })).statusCode, 400);
  assert.equal((await handler({ requestContext: { http: { method: 'OPTIONS' } } })).statusCode, 204);
});

import http from 'node:http';
import { getOnce } from '../index.js';
test('getOnce: descarga HTML, detecta redirecciones y rechaza no-HTML (servidor local)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/r') { res.writeHead(302, { location: '/p' }); return res.end(); }
    if (req.url === '/img') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('x'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>T</title><meta property="og:title" content="Hola">');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; const addr = { address: '127.0.0.1', family: 4 };
  try {
    assert.match((await getOnce(new URL(`http://localhost:${port}/p`), addr)).body, /og:title/);
    assert.equal((await getOnce(new URL(`http://localhost:${port}/r`), addr)).redirect, '/p');
    await assert.rejects(getOnce(new URL(`http://localhost:${port}/img`), addr), /not_html/);
  } finally { srv.close(); }
});
