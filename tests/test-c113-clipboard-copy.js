// C113: regresión — copyCommentText (hoja de acciones de comentario) era la
// única de las 10 rutas de navigator.clipboard.writeText sin guarda de
// navigator.clipboard y sin fallback: con clipboard ausente lanzaba TypeError
// síncrono que rompía el onclick con la hoja abierta, y ante un rechazo
// (permiso denegado) solo hacía console.error sin feedback. El fix sigue el
// patrón de copyPostTextFromOptions: guarda + fallback execCommand + cierre
// de hoja y toast en ambos paths. Sin strings i18n nuevos.
//
// RE-AUDITORÍA (2026-09-25, MISIÓN BARO Bloque 1): la función "Series" fue
// eliminada por orden del usuario, incluyendo su helper de portapapeles
// (copiar enlace de serie: createElement('input') + execCommand('copy') +
// navigator.clipboard.writeText). Por eso la familia baja de 8→7 guardas y
// 10→9 call sites de writeText. Delta explicado 1:1 por el diff (la única
// línea eliminada con clipboard.writeText). Resto de la familia intacta.
// Test híbrido: asserts estáticos (fallan en base) + conductuales en sandbox
// vm (sin clipboard / clipboard OK / clipboard rechaza / clipboard sin
// writeText), con tcase para FAILs limpios en base.
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
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(
      () => console.log('ok - ' + name),
      (e) => { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); });
    console.log('ok - ' + name); return Promise.resolve();
  } catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); return Promise.resolve(); }
}
function tcasesync(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.error('FAIL - ' + name + ' :: ' + (e && e.message)); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractFn(src, declLine) {
  const declIdx = src.indexOf(declLine);
  if (declIdx < 0) throw new Error('declaración no encontrada: ' + declLine);
  const braceIdx = src.indexOf('{', declIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(declIdx, i + 1); }
  }
  throw new Error('cierre no encontrado: ' + declLine);
}

function copyBlock() { return extractFn(html, 'function copyCommentText(text)'); }

// ---------- asserts estáticos ----------
tcasesync('copyCommentText existe', () => {
  if (html.indexOf('function copyCommentText(text)') < 0) throw new Error('no existe');
});
tcasesync('guarda navigator.clipboard && .writeText', () => {
  if (copyBlock().indexOf('navigator.clipboard && navigator.clipboard.writeText') < 0)
    throw new Error('sin guarda');
});
tcasesync('fallback execCommand presente', () => {
  if (copyBlock().indexOf("document.execCommand('copy')") < 0) throw new Error('sin fallback');
});
tcasesync('cierra la hoja y muestra toast en el path de éxito', () => {
  const b = copyBlock();
  if (b.indexOf('closeCommentActionsSheet()') < 0) throw new Error('no cierra la hoja');
  if (b.indexOf("showMiniToast(appT('Texto copiado al portapapeles'))") < 0) throw new Error('sin toast');
});
tcasesync('patrón viejo ausente (then inline sin guarda)', () => {
  if (copyBlock().indexOf('navigator.clipboard.writeText(text).then(() => {') >= 0)
    throw new Error('patrón viejo presente');
});
tcasesync('sin console.error silencioso', () => {
  if (copyBlock().indexOf("console.error('Error al copiar:'") >= 0)
    throw new Error('console.error silencioso presente');
});
tcasesync('llamador onclick intacto', () => {
  if (html.indexOf('onclick="copyCommentText(') < 0) throw new Error('onclick perdido');
});
tcasesync('familia: 7 guardas clipboard en todo el archivo (BARO-1: -1 por eliminar Series)', () => {
  const n = (html.match(/navigator\.clipboard && navigator\.clipboard\.writeText/g) || []).length;
  if (n !== 7) throw new Error('guardas: ' + n + ' (esperado 7)');
});
tcasesync('familia: 9 call sites de writeText (sin nuevos ni perdidos)', () => {
  const n = (html.match(/navigator\.clipboard\.writeText\(/g) || []).length;
  if (n !== 9) throw new Error('call sites: ' + n + ' (esperado 9)');
});

// ---------- conductuales en vm ----------
function makeCtx(navigatorStub) {
  const calls = { sheetClosed: false, toasts: [], execCommands: [], written: [], textareas: 0 };
  const sandbox = {
    navigator: navigatorStub,
    document: {
      createElement(tag) {
        if (tag !== 'textarea') throw new Error('tag inesperado: ' + tag);
        calls.textareas++;
        return { value: '', select() {}, remove() {} };
      },
      body: { appendChild() {}, removeChild() {} },
      execCommand(cmd) { calls.execCommands.push(cmd); return true; }
    },
    closeCommentActionsSheet() { calls.sheetClosed = true; },
    showMiniToast(m) { calls.toasts.push(String(m)); },
    appT(s) { return s; },
    console
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(copyBlock(), context);
  return { context, calls };
}
function runCopy(ctx, text) {
  vm.runInContext('copyCommentText(' + JSON.stringify(text) + ')', ctx.context);
}

(async () => {
  await tcase('conductual: sin navigator.clipboard → fallback execCommand + toast + hoja cerrada', async () => {
    const ctx = makeCtx({});
    runCopy(ctx, 'hola mundo');
    await sleep(30);
    if (!ctx.calls.execCommands.includes('copy')) throw new Error('no usó fallback execCommand');
    if (ctx.calls.textareas !== 1) throw new Error('no creó el textarea de fallback');
    if (!ctx.calls.sheetClosed) throw new Error('hoja no cerrada');
    if (!ctx.calls.toasts.includes('Texto copiado al portapapeles')) throw new Error('sin toast');
  });
  await tcase('conductual: clipboard OK → writeText + toast + hoja cerrada, sin fallback', async () => {
    const ctx = makeCtx({ clipboard: { writeText: async (t) => { ctx.calls.written.push(t); } } });
    runCopy(ctx, 'texto del comentario');
    await sleep(30);
    if (ctx.calls.written.join() !== 'texto del comentario') throw new Error('no escribió el texto');
    if (ctx.calls.textareas !== 0) throw new Error('usó fallback innecesario');
    if (!ctx.calls.sheetClosed) throw new Error('hoja no cerrada');
    if (!ctx.calls.toasts.includes('Texto copiado al portapapeles')) throw new Error('sin toast');
  });
  await tcase('conductual: clipboard rechaza (permiso denegado) → fallback + feedback', async () => {
    const ctx = makeCtx({ clipboard: { writeText: async () => { throw new Error('denied'); } } });
    runCopy(ctx, 'otro texto');
    await sleep(30);
    if (!ctx.calls.execCommands.includes('copy')) throw new Error('no cayó al fallback');
    if (!ctx.calls.sheetClosed) throw new Error('hoja no cerrada tras rechazo');
    if (!ctx.calls.toasts.includes('Texto copiado al portapapeles')) throw new Error('sin feedback');
  });
  await tcase('conductual: clipboard sin writeText → no lanza, usa fallback', async () => {
    const ctx = makeCtx({ clipboard: {} });
    runCopy(ctx, 'x'); // en base lanza TypeError síncrono aquí
    await sleep(30);
    if (!ctx.calls.execCommands.includes('copy')) throw new Error('no usó fallback');
    if (!ctx.calls.sheetClosed) throw new Error('hoja no cerrada');
  });

  console.log(failures ? '\n' + failures + ' FAIL(s)' : '\nALL OK');
  process.exit(failures ? 1 : 0);
})();
