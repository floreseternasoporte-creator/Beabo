// Runner del test de layout del FEED a 390px (Carril 1 - auditoria UI Drex).
// Uso: node tests/test-ui-feed-390.js [--shots]
//
// Levanta (si hace falta) `python3 -m http.server` sobre el worktree, abre
// tests/harness-feed-390.html en Chromium headless, extrae los asserts que
// el harness ejecuta dentro del iframe con el index.html real y reporta.
// Con --shots guarda PNGs en tests/shots-feed-390/.

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell';
const HTTP_PORT = 8891;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(__dirname, 'shots-feed-390');

function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureHttp() {
  if (await httpGetOk(`${BASE}/index.html`)) return null;
  const srv = spawn('python3', ['-m', 'http.server', String(HTTP_PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: true });
  srv.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await httpGetOk(`${BASE}/index.html`)) return srv;
  }
  throw new Error('no se pudo levantar el http.server en ' + HTTP_PORT);
}

function runShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(SHELL, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout shell; stderr: ' + err.slice(-300))); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function main() {
  const srv = await ensureHttp();
  const url = `${BASE}/tests/harness-feed-390.html`;
  const common = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=390,844'];

  console.log('cargando harness…');
  const dom = await runShell([...common, '--virtual-time-budget=90000', '--dump-dom', url], 180000);
  const m = dom.out.match(/RESULTS-BEGIN([\s\S]*?)RESULTS-END/);
  if (!m) {
    console.error('FAIL harness sin resultados. DOM tail:');
    console.error(dom.out.slice(-800));
    console.error('STDERR:', dom.err.slice(-500));
    process.exit(3);
  }
  const results = JSON.parse(m[1]);
  let fails = 0;
  for (const r of results) {
    if (!r.pass) fails++;
    console.log((r.pass ? 'PASS' : 'FAIL') + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  console.log(`\n${results.length - fails}/${results.length} asserts OK`);

  if (SHOTS) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const s1 = await runShell([...common, '--virtual-time-budget=90000', '--hide-scrollbars',
      `--screenshot=${path.join(SHOT_DIR, 'feed-390-full.png')}`, url], 180000);
    console.log('shot:', path.join(SHOT_DIR, 'feed-390-full.png'), 'exit=' + s1.code);
  }
  process.exit(fails ? 2 : 0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(3); });
