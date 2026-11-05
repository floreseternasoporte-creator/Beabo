'use strict';
/* server.js: path traversal, archivos internos y métodos no permitidos.
 * Equivale a la "prueba de humo" del workflow pero usando http.request con la
 * ruta TAL CUAL (node no normaliza %2e%2e como curl sin --path-as-is).
 * Ejecutar con: node tests/test-server-path-traversal.js */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 5000 + Math.floor(Math.random() * 500) + 100;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK  ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject); r.end();
  });
}
function waitUp(tries) {
  return req('GET', '/').catch(() => (tries > 0
    ? new Promise((r) => setTimeout(r, 200)).then(() => waitUp(tries - 1))
    : Promise.reject(new Error('el servidor no arrancó'))));
}

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
  { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });

(async () => {
  try {
    await waitUp(40);
    check('GET / = 200', (await req('GET', '/')) === 200);
    check('GET /server.js = 404', (await req('GET', '/server.js')) === 404);
    check('GET /.replit = 404', (await req('GET', '/.replit')) === 404);
    check('traversal %2e%2e = 403', (await req('GET', '/%2e%2e/%2e%2e/etc/passwd')) === 403);
    check('traversal ../ literal = 403', (await req('GET', '/../../etc/passwd')) === 403);
    check('POST = 405', (await req('POST', '/api/x')) === 405);
  } catch (e) {
    failures++; console.log('  FAIL excepción :: ' + e.message);
  }
  srv.kill();
  console.log(failures ? failures + ' FALLOS' : 'todo OK');
  process.exit(failures ? 1 : 0);
})();
