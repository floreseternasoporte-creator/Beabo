/* ================================================================
 * C159 — Practicar: AVISO A SEGUIDORES DEL EJERCICIO NUEVO (fan-out).
 *
 * HALLAZGO (hueco real, verificado contra el código):
 *  - SE CALCULA: publishExercise() hace push a languageExercises con
 *    authorId/authorName/authorImage/language/topic/text/timestamp.
 *  - SE PINTA: la tarjeta del ejercicio aparece en el feed de Practicar
 *    (loadPracticarFeed) para todo el mundo, incluidos los seguidores.
 *  - SILENCIO: es el ÚNICO contenido publicado sin fan-out a seguidores.
 *    Posts -> notifyFollowersOfNewContent(..., 'post', ...) [~14913];
 *    canciones -> addNotification 'music' por seguidor [~50823];
 *    fiestas -> notifyFollowersOfNewContent(..., 'fiesta', ...) [~47279];
 *    ejercicios -> cero call sites (grep: notifyFollowersOfNewContent solo
 *    aparece en esos tres lugares). El ajuste "Publicaciones de seguidos"
 *    promete "Cuando alguien que sigues publica": el ejercicio es una
 *    publicación de un seguido y nadie se entera.
 *  - VALOR DE PRODUCTO: el sentido de Practicar es que otros corrijan tu
 *    ejercicio; tus seguidores (compañeros de intercambio) son los
 *    correctores más probables. Ambas partes ganan con el aviso.
 *
 * CAMBIO (index.html):
 *  - exerciseNotifyText(authorName, langName): núcleo PURO. Texto del
 *    aviso, español fijo (convención C147/C153/C157/C158: sin claves i18n
 *    nuevas que romper).
 *  - exerciseAnnounceToFollowers(authorId, authorName, exId, langName):
 *    envoltorio del fan-out. Puro salvo la llamada al notificador
 *    existente; se testea en sandbox con mock. Devuelve false sin
 *    authorId/exId o sin notificador (no dispara nada a medias).
 *  - publishExercise: tras confirmar el push (pushAsync resuelve con el
 *    ref -> key real), invoca al anunciador con guarda typeof (los
 *    harnesses viejos ejecutan publishExercise en sandbox sin él;
 *    patrón C153). No toca el payload del push (lección C149: el shape
 *    caliente de languageExercises queda intacto).
 *  - Tap en la notificación: case 'exercise' nuevo en el switch de
 *    navegación (con guarda typeof openExerciseDetail, patrón C153).
 *    NO es un tipo de notificación nuevo: el aviso viaja con tipo 'post'
 *    EXISTENTE para heredar el toggle 'followingPosts' del destinatario
 *    vía notifTypeToPrefKey (nunca inventar tipo); 'exercise' es solo
 *    actionType de navegación, como 'chat' o 'profile'.
 *
 * DECISIÓN una-vez vs repetible: fan-out por publicación (como posts/
 * canciones/fiestas), no exactamente-una-vez: el publicador es el único
 * escritor del evento tras confirmar el push, así que no hay carrera que
 * arbitrar y no se necesita nodo paralelo ni updater. notifyFollowers-
 * OfNewContent ya excluye al propio autor (sin auto-aviso).
 *
 * DEGRADACIÓN best-effort: si las reglas RTDB deniegan el push, el
 * ejercicio no existe y no hay aviso (el catch ya muestra el error); si el
 * fan-out falla, el ejercicio sigue publicado: el aviso nunca bloquea.
 *
 * Ejecutar con: node tests/test-c159-ejercicio-seguidores.js
 * ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failures = 0;
const pending = [];
function tcase(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(function (v) {
        console.log((v ? 'ok - ' : 'NOT OK - ') + name);
        if (!v) failures++;
      }).catch(function (e) {
        console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
        failures++;
      }));
      return;
    }
    console.log((r ? 'ok - ' : 'NOT OK - ') + name);
    if (!r) failures++;
  } catch (e) {
    console.log('NOT OK - ' + name + ' [excepción: ' + e.message + ']');
    failures++;
  }
}
function extractFn(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(source);
  if (!m) throw new Error('no se encontró ' + name);
  let i = source.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
  }
  throw new Error('llaves sin balance en ' + name);
}
function extractC159Block() {
  const start = html.indexOf('// ============ C159:');
  const endMark = '// ============ /C159 ============';
  const ei = html.indexOf(endMark);
  if (start === -1 || ei === -1 || ei < start) throw new Error('bloque C159 ausente en index.html');
  return html.slice(start, ei + endMark.length);
}

// ---------- Parte A: estáticos (FALLAN sin el parche) ----------
tcase('A1 existen exerciseNotifyText + exerciseAnnounceToFollowers (bloque C159)', () => {
  return html.indexOf('function exerciseNotifyText(authorName, langName)') !== -1
    && html.indexOf('function exerciseAnnounceToFollowers(authorId, authorName, exId, langName)') !== -1
    && html.indexOf('// ============ C159:') !== -1
    && html.indexOf('// ============ /C159 ============') !== -1;
});
tcase('A2 hook en publishExercise tras confirmar el push (guarda typeof, patrón C153)', () => {
  const fn = extractFn(html, 'publishExercise');
  return fn.indexOf("typeof exerciseAnnounceToFollowers === 'function'") !== -1
    && fn.indexOf('exerciseAnnounceToFollowers(profile.uid, profile.name,') !== -1;
});
tcase('A3 el hook captura la key real del push (pushAsync resuelve con el ref)', () => {
  const fn = extractFn(html, 'publishExercise');
  return fn.indexOf("ref('languageExercises').pushAsync(payload)") !== -1
    && /var _exPushRef|const _exPushRef/.test(fn)
    && fn.indexOf('_exPushRef.key') !== -1;
});
tcase('A4 el fan-out usa tipo post EXISTENTE (hereda toggle followingPosts; nunca inventar tipo)', () => {
  const blk = extractC159Block();
  return blk.indexOf("notifyFollowersOfNewContent(authorId, authorName || 'Alguien', 'post',") !== -1
    && blk.indexOf('notifTypeToPrefKey') !== -1;
});
tcase('A5 la navegación usa actionType exercise con guarda typeof (no rompe el switch)', () => {
  const blk = extractC159Block();
  return blk.indexOf("{ actionType: 'exercise', actionId: exId, actorId: authorId }") !== -1
    && html.indexOf("case 'exercise':") !== -1
    && html.indexOf("typeof openExerciseDetail === 'function'") !== -1;
});
tcase('A6 el payload del push no cambia (shape caliente intacto, lección C149)', () => {
  const fn = extractFn(html, 'publishExercise');
  const m = /const payload = \{([\s\S]*?)\};/.exec(fn);
  if (!m) return false;
  const keys = m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean).sort().join('|');
  return keys === 'authorId|authorImage|authorName|correctionsCount|language|text|timestamp|topic';
});
tcase('A7 mensaje en español fijo (sin claves i18n nuevas que romper)', () => {
  const blk = extractC159Block();
  const fn = blk.slice(blk.indexOf('function exerciseNotifyText'));
  return fn.indexOf('publicó un nuevo ejercicio') !== -1 && fn.indexOf('appT(') === -1;
});

// ---------- Parte B: núcleo puro (sandbox con el bloque real) ----------
function pureBox() {
  const sb = {};
  vm.createContext(sb);
  const mocks = [
    'var __captured = null;',
    'function notifyFollowersOfNewContent(authorId, authorName, type, message, meta){',
    '  __captured = { authorId: authorId, authorName: authorName, type: type, message: message, meta: meta };',
    '}'
  ].join('\n');
  vm.runInContext(mocks, sb);
  vm.runInContext(extractC159Block(), sb);
  return sb;
}
tcase('B1 texto: nombre + idioma en minúsculas', () => {
  const sb = pureBox();
  return vm.runInContext("exerciseNotifyText('María', 'Inglés')", sb) === 'María publicó un nuevo ejercicio de inglés.'
    && vm.runInContext("exerciseNotifyText('  Ana  ', 'Portugués')", sb) === 'Ana publicó un nuevo ejercicio de portugués.';
});
tcase('B2 texto: fallbacks sin nombre / sin idioma', () => {
  const sb = pureBox();
  return vm.runInContext("exerciseNotifyText('', 'Inglés')", sb) === 'Alguien publicó un nuevo ejercicio de inglés.'
    && vm.runInContext("exerciseNotifyText(null, null)", sb) === 'Alguien publicó un nuevo ejercicio.'
    && vm.runInContext("exerciseNotifyText('Luis', '')", sb) === 'Luis publicó un nuevo ejercicio.';
});
tcase('B3 wrapper: dispara el fan-out con (uid, nombre, post, texto, meta exercise)', () => {
  const sb = pureBox();
  const ok = vm.runInContext("exerciseAnnounceToFollowers('u1', 'María', 'ex9', 'Inglés')", sb);
  const c = vm.runInContext('__captured', sb);
  return ok === true
    && c && c.authorId === 'u1' && c.authorName === 'María' && c.type === 'post'
    && c.message === 'María publicó un nuevo ejercicio de inglés.'
    && c.meta && c.meta.actionType === 'exercise' && c.meta.actionId === 'ex9' && c.meta.actorId === 'u1';
});
tcase('B4 wrapper: no dispara sin authorId / sin exId (nada a medias)', () => {
  const sb = pureBox();
  const r1 = vm.runInContext("exerciseAnnounceToFollowers('', 'María', 'ex9', 'Inglés')", sb);
  const r2 = vm.runInContext("exerciseAnnounceToFollowers('u1', 'María', '', 'Inglés')", sb);
  const r3 = vm.runInContext("exerciseAnnounceToFollowers(null, 'María', 'ex9', 'Inglés')", sb);
  const c = vm.runInContext('__captured', sb);
  return r1 === false && r2 === false && r3 === false && c === null;
});
tcase('B5 wrapper: sin notificador disponible no rompe (best-effort)', () => {
  const sb = {};
  vm.createContext(sb);
  // sandbox SIN notifyFollowersOfNewContent: debe devolver false, no lanzar
  vm.runInContext(extractC159Block(), sb);
  return vm.runInContext("exerciseAnnounceToFollowers('u1', 'María', 'ex9', 'Inglés')", sb) === false;
});

// ---------- Parte C: publishExercise no avisa dos veces ni al autor ----------
tcase('C1 el hook va DESPUÉS del push confirmado (no antes del await)', () => {
  const fn = extractFn(html, 'publishExercise');
  const iPush = fn.indexOf("ref('languageExercises').pushAsync(payload)");
  const iHook = fn.indexOf("typeof exerciseAnnounceToFollowers === 'function'");
  const iCatch = fn.indexOf('} catch(e) {');
  return iPush !== -1 && iHook !== -1 && iCatch !== -1 && iPush < iHook && iHook < iCatch;
});
tcase('C2 sin auto-aviso: el fan-out excluye al autor (contrato de notifyFollowersOfNewContent)', () => {
  // El contrato vive en notifyFollowersOfNewContent (fid === authorId -> skip),
  // ya cubierto por su propio ciclo; aquí se fija que C159 lo usa en vez de
  // un loop manual que pudiera olvidar el skip.
  const blk = extractC159Block();
  const fn = extractFn(html, 'notifyFollowersOfNewContent');
  return blk.indexOf('notifyFollowersOfNewContent(') !== -1
    && fn.indexOf('if (!fid || fid === authorId) return;') !== -1;
});

Promise.all(pending).then(() => {
  console.log(failures === 0 ? 'C159: 13/13 OK' : 'C159: ' + failures + ' FALLOS');
  process.exit(failures === 0 ? 0 : 1);
});
