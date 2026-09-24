// C111: shareEco pasaba el contenido COMPLETO del eco (hasta 4000 chars del
// composer) sin truncar a navigator.share y al portapapeles. Fix: vista previa
// acotada a 220 chars + '…'. navigator.share con texto largo genera tarjetas
// de compartir feas y en Android el EXTRA_TEXT gigante roza el límite del
// binder; el truncado es el comportamiento esperado.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const targetArg = process.argv.find(a => a.startsWith('--target='));
const htmlPath = targetArg ? targetArg.slice('--target='.length)
  : path.join(__dirname, '..', 'index.html');
let html;
try { html = fs.readFileSync(htmlPath, 'utf8'); }
catch (e) { console.error('FAIL: no se pudo leer index.html'); process.exit(1); }

let failures = 0;
function ok(name, cond) {
  if (cond) console.log('ok - ' + name);
  else { failures++; console.error('FAIL - ' + name); }
}
// tcase: las llamadas al núcleo van envueltas en try/catch para que la base
// reporte FAILs limpios en vez de crashear el runner.
function tcase(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(
    () => console.log('ok - ' + name),
    (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve(); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}

// Extrae una función top-level por balance de llaves (conserva 'async ' si lo hay).
function extractFn(name) {
  let i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no encontrada: ' + name);
  if (html.slice(i - 6, i) === 'async ') i -= 6;
  let j = html.indexOf('{', i), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
  }
  throw new Error('sin cierre: ' + name);
}

// ---------- 1. Estáticos ----------
ok('shareEco: usa vista previa acotada (ecoPreview)',
  /async function shareEco[\s\S]{0,600}ecoPreview/.test(html));
ok('shareEco: trunca a 220 chars con elipsis',
  /rawContent\.length > 220 \? rawContent\.slice\(0, 220\)\.trimEnd\(\) \+ '…'/.test(html));
ok('shareEco: ya no interpola note.content sin truncar en shareText',
  !/shareText = `[^`]*\$\{\(note\?\.content \|\| ''\)\.trim\(\)/.test(html));

// ---------- 2. Conductuales en vm ----------
function runShareEco(content, userName) {
  const src = extractFn('shareEco')
    + '\nthis.__result = shareEco({ id: "n1", content: CONTENT }, USERNAME);';
  let captured = null;
  const sandbox = {
    CONTENT: content,
    USERNAME: userName,
    appT: (s) => s,
    location: { origin: 'https://x.test', pathname: '/' },
    showMiniToast: () => {},
    navigator: {
      share: (data) => { captured = data; return Promise.resolve(); },
      clipboard: { writeText: () => Promise.reject(new Error('no clipboard')) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__result.then(() => captured);
}

tcase('contenido corto (100 chars): pasa íntegro, sin elipsis', () => {
  const c = 'a'.repeat(100);
  return runShareEco(c, 'Ana').then((data) => {
    if (!data) throw new Error('navigator.share no fue llamado');
    if (!data.text.includes(c)) throw new Error('el contenido corto no pasó íntegro');
    if (data.text.includes('…')) throw new Error('elipsis indebida en contenido corto');
  });
});

tcase('contenido largo (4000 chars): se trunca a ~220 con elipsis', () => {
  const c = 'b'.repeat(4000);
  return runShareEco(c, 'Ana').then((data) => {
    if (!data) throw new Error('navigator.share no fue llamado');
    const tail = data.text.split('\n\n')[1] || '';
    if (tail.length > 222) throw new Error('no truncó: ' + tail.length + ' chars');
    if (!tail.endsWith('…')) throw new Error('falta la elipsis de truncado');
    if (!tail.startsWith('b'.repeat(200))) throw new Error('el truncado no conserva el inicio');
  });
});

tcase('contenido de 220 exactos: no se trunca', () => {
  const c = 'c'.repeat(220);
  return runShareEco(c, 'Ana').then((data) => {
    if (!data) throw new Error('navigator.share no fue llamado');
    if (!data.text.includes(c)) throw new Error('220 exactos deberían pasar íntegros');
    if (data.text.includes('…')) throw new Error('elipsis indebida en 220 exactos');
  });
});

tcase('contenido vacío: fallback "Mira este post."', () => {
  return runShareEco('   ', 'Ana').then((data) => {
    if (!data) throw new Error('navigator.share no fue llamado');
    if (!data.text.includes('Mira este post.')) throw new Error('falta el fallback');
  });
});

tcase('sin note (undefined): no crashea, usa fallback', () => {
  const src = extractFn('shareEco') + '\nthis.__result = shareEco(undefined, "Ana");';
  let captured = null;
  const sandbox = {
    appT: (s) => s,
    location: { origin: 'https://x.test', pathname: '/' },
    showMiniToast: () => {},
    navigator: {
      share: (data) => { captured = data; return Promise.resolve(); },
      clipboard: { writeText: () => Promise.reject(new Error('no clipboard')) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.__result.then(() => {
    if (!captured) throw new Error('navigator.share no fue llamado');
    if (!captured.text.includes('Mira este post.')) throw new Error('falta el fallback');
  });
});

process.on('exit', () => { if (failures) { console.error(failures + ' FAIL(s)'); process.exitCode = 1; } });
