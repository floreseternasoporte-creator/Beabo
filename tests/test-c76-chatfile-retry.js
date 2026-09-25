// test-c76-chatfile-retry.js — C76-F1: tras un fallo del msgRef.set(), el
// composer del chat limpiaba los adjuntos ANTES del set y el catch solo
// restauraba el texto: el retry salía solo con texto y el archivo se perdía
// en silencio (aunque el toast decía "Inténtalo de nuevo").
// Fix: snapshot de adjuntos antes de limpiar + _restoreChatAttachmentsAfterFailedSend
// en el catch (las entradas de archivo se re-encolan para re-subida con
// fileId nuevo; las fotos reusan su cloudUrl).
// Convención: estático + funcional contra el archivo del repo, sin rutas
// absolutas ni historial de git. Los checks SOLO pasan con el fix presente.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { webcrypto } = require('crypto');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// Extractor (regla C71: conserva `async`; sin parámetros por defecto aquí).
function extractFn(src, name) {
  const m = src.match(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  assert(m, 'funcion no encontrada: ' + name);
  const start = m.index;
  let brace = src.indexOf('{', start);
  let depth = 0, i = brace;
  for (;;) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

// ---------- estático ----------
const pushFn = extractFn(html, '_pushOptimisticChatMessage');
check('S1: snapshot de adjuntos ANTES de clearChatFileAttachment() en el push',
  pushFn.indexOf('_c76FilesSnap') !== -1 &&
  pushFn.indexOf('_c76FilesSnap') < pushFn.indexOf('clearChatFileAttachment()') &&
  pushFn.indexOf('_c76PhotosSnap') < pushFn.indexOf('clearChatPhotoAttachment()'));
check('S2: el catch del set() restaura adjuntos con los fileIds liberados',
  /_restoreChatAttachmentsAfterFailedSend\(_c76FilesSnap,\s*_c76PhotosSnap,\s*_releasedIds\)/.test(pushFn) &&
  /_releasedIds\[fm\.fileId\]\s*=\s*true/.test(pushFn));

const restoreFn = extractFn(html, '_restoreChatAttachmentsAfterFailedSend');
check('S3: el restore re-encola entradas liberadas (fileId=null, uploading, pump)',
  /a\.fileId\s*=\s*null/.test(restoreFn) &&
  /a\.uploading\s*=\s*true/.test(restoreFn) &&
  /_pumpChatFileUploadQueue\(\)/.test(restoreFn));
check('S4: las fotos restauradas reusan su cloudUrl (no se re-suben)',
  /p\.localUrl\s*=\s*p\.cloudUrl/.test(restoreFn) &&
  !/cloudUrl\s*=\s*null/.test(restoreFn));

// ---------- funcional (funciones REALES en el vm) ----------
function makeDb() {
  const store = new Map();
  return {
    store,
    database() {
      return {
        ref(p) {
          return {
            set(v) { store.set(p, v); return Promise.resolve(); },
            remove() {
              for (const k of [...store.keys()]) if (k === p || k.startsWith(p + '/')) store.delete(k);
              return Promise.resolve();
            },
            transaction(fn) {
              return Promise.resolve().then(() => {
                const cur = store.has(p) ? store.get(p) : null;
                const nv = fn(cur);
                if (nv === undefined) return { committed: false };
                if (nv === null) store.delete(p); else store.set(p, nv);
                return { committed: true, snapshot: { val: () => nv } };
              });
            },
          };
        },
      };
    },
  };
}

async function main() {
  const db = makeDb();
  // trozos del intento original (ya liberados por C50-C1 en el escenario)
  db.store.set('chatFiles/cf_old/chunk_00000', 'data:application/pdf;base64,QUJD');

  const sandbox = {
    console,
    setTimeout, clearTimeout,
    crypto: webcrypto,
    DrexCloud: db,
    chatFileAttachments: [],
    chatPhotoAttachments: [],
    _chatFileMetaCache: {},
    _chatFileQueueRunning: false,
    CHAT_FILE_CHUNK_CHARS: 300 * 1024,
    CHAT_FILE_UPLOAD_CONCURRENCY: 2,
    readFileAsDataURL: () => Promise.resolve('data:application/pdf;base64,QUJDREVG'),
    appT: s => s,
    showMiniToast: () => {},
    updateChatToolbarMode: () => {},
    _renderChatFileAttachments: () => {},
    _renderChatPhotoThumbnails: () => {},
  };
  vm.createContext(sandbox);
  for (const fn of ['isValidChatUid', '_releaseChatFileRef', '_releaseChatFileRefsOfMsg', // C200: dependencia transitiva del parche
                    '_restoreChatAttachmentsAfterFailedSend', '_pumpChatFileUploadQueue',
                    '_uploadChatFileEntry', '_writeChatFileChunksLimited']) {
    vm.runInContext(extractFn(html, fn) + `\nglobalThis.${fn} = ${fn};`, sandbox);
  }
  const run = (code) => vm.runInContext(code, sandbox);

  // Entrada de archivo como la deja clearChatFileAttachment(): cancelada,
  // con fileId cuyos trozos el catch libera (C50-C1) ANTES del restore.
  const fileEntry = {
    id: 'cfa_1', file: { name: 'informe.pdf' }, name: 'informe.pdf',
    size: 12, mime: 'application/pdf',
    fileId: 'cf_old', chunks: 1, uploaded: 1, uploading: false,
    progress: 100, failed: false, started: true, cancelled: true,
  };
  // Foto: clearChatPhotoAttachment() revocó el object URL local.
  const photoEntry = { id: 123, localUrl: null, cloudUrl: 'https://cloud.example/foto.jpg', uploading: false };

  sandbox.__fe = fileEntry; sandbox.__pe = photoEntry;
  // Orden real del catch: primero se liberan los trozos (C50-C1)...
  run(`_releaseChatFileRefsOfMsg({ files: [{ fileId: __fe.fileId }] }, '-Nmsg1')`);
  await new Promise(r => setTimeout(r, 50)); // fire-and-forget: dejar aterrizar
  // ...y luego se restauran los adjuntos (C76-F1).
  run(`_restoreChatAttachmentsAfterFailedSend([__fe], [__pe], { cf_old: true })`);

  check('F1: la entrada de archivo vuelve al composer', sandbox.chatFileAttachments.indexOf(fileEntry) !== -1);
  check('F2: la entrada liberada se marca para re-subida (sin fileId stale)',
    fileEntry.fileId === null && fileEntry.uploading === true && fileEntry.cancelled === false);

  // Esperar a que la cola REAL termine la re-subida.
  for (let i = 0; i < 200 && fileEntry.uploading; i++) await new Promise(r => setTimeout(r, 25));
  check('F3: la re-subida completa con fileId NUEVO', !fileEntry.uploading && !!fileEntry.fileId && fileEntry.fileId !== 'cf_old');
  const newChunks = [...db.store.keys()].filter(k => k.startsWith('chatFiles/' + fileEntry.fileId + '/chunk_'));
  check('F4: los trozos existen bajo el fileId nuevo', newChunks.length === 1);
  check('F5: los trozos viejos siguen liberados', ![...db.store.keys()].some(k => k.startsWith('chatFiles/cf_old/')));

  // El retry usa el filtro VERBATIM de sendChatMessageInternal (index.html)
  const pendingFiles = sandbox.chatFileAttachments.filter(a => !a.uploading && !a.failed && a.fileId);
  check('F6: el retry incluye el archivo re-subido (no sale solo con texto)',
    pendingFiles.length === 1 && pendingFiles[0].fileId === fileEntry.fileId);

  check('F7: la foto vuelve al composer reusando su cloudUrl',
    sandbox.chatPhotoAttachments.indexOf(photoEntry) !== -1 &&
    photoEntry.localUrl === 'https://cloud.example/foto.jpg' && photoEntry.uploading === false);

  // Idempotencia: restaurar dos veces no duplica.
  run(`_restoreChatAttachmentsAfterFailedSend([__fe], [__pe], {})`);
  check('F8: restore idempotente (sin duplicados)',
    sandbox.chatFileAttachments.filter(a => a === fileEntry).length === 1 &&
    sandbox.chatPhotoAttachments.filter(p => p === photoEntry).length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERROR', e); process.exit(1); });
