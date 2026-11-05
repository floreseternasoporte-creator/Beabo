// "escribiendo…" en filas de la bandeja + tarjetas de vista previa de enlaces en el chat.
// Pruebas conductuales: funciones REALES de index.html ejecutadas en vm con stubs; más guardias de fuente y
// pruebas de las funciones puras de lambda-link-preview.
// Uso: node tests/test-mensajeria-typing-links.js [ruta/index.html]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0;
function check(name, cond) { console.log((cond ? '  OK  ' : '  FAIL ') + name); if (!cond) failures++; }
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let i = src.indexOf('{', src.indexOf(')', start));
  for (let end = src.indexOf('}', i); end !== -1; end = src.indexOf('}', end + 1)) {
    const code = src.slice(start, end + 1);
    try { new vm.Script(code); return code; } catch (_) { /* seguir */ }
  }
  return null;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

(async () => {
  // ---------- A. escribiendo… en la bandeja ----------
  {
    const names = ['drexInboxIsTyping', 'drexInboxTypingHtml', 'drexInboxPatchRow', 'drexInboxTypingDrop', 'drexInboxTypingStop', 'drexInboxTypingSync'];
    const listeners = {}; const refs = [];
    const rows = {};
    const mkRow = id => (rows[id] = { dataset: {}, innerHTML: 'previo ' + id, style: {} });
    const inbox = { classList: { hidden: false, contains() { return this.hidden; } } };
    const ctx = {
      appT: s => s, escapeHtml: esc, CSS: { escape: s => s }, Date,
      document: { getElementById: id => (id === 'chat-inbox-view' ? inbox : null), querySelector: sel => { const m = sel.match(/data-conv-prev="([^"]+)"/); return m ? rows[m[1]] || null : null; } },
      DrexCloud: { auth: () => ({ currentUser: { uid: 'me' } }), database: () => ({ ref: p => ({ on: (ev, cb) => { listeners[p] = cb; refs.push(p); }, off: (ev, cb) => { if (listeners[p] === cb) delete listeners[p]; } }) }) },
      setTimeout: (fn, ms) => ({ fn, ms }), clearTimeout() {}, console,
    };
    vm.createContext(ctx);
    vm.runInContext('let _drexInboxTyping={};' + names.map(n => extractFn(html, n)).join('\n'), ctx);
    ['c1', 'c2', 'g1'].forEach(mkRow);
    const items = [{ id: 'c1' }, { id: 'c2' }, { id: 'g1', isGroup: true, groupId: 'g1' }, { id: 'r1', isRequest: true }];
    vm.runInContext('drexInboxTypingSync(items)', Object.assign(ctx, { items }));
    check('bandeja: un listener por conversación (DM y grupo), las solicitudes no suscriben', JSON.stringify(refs.sort()) === JSON.stringify(['typing/c1', 'typing/c2', 'typing/g1']));
    listeners['typing/c1']({ val: () => ({ u1: Date.now() }) });
    check('bandeja: otro usuario escribiendo => fila con "escribiendo..." en color de marca', rows.c1.innerHTML.includes('escribiendo...') && rows.c1.style.color === 'var(--drex-brand)' && vm.runInContext('drexInboxIsTyping("c1")', ctx));
    listeners['typing/c1']({ val: () => ({ u1: Date.now() - 20000 }) });
    check('bandeja: timestamp viejo (>5 s) => restaura la vista previa original', rows.c1.innerHTML === 'previo c1' && rows.c1.style.color === '' && !vm.runInContext('drexInboxIsTyping("c1")', ctx));
    listeners['typing/c2']({ val: () => ({ me: Date.now() }) });
    check('bandeja: mi propia escritura se ignora', rows.c2.innerHTML === 'previo c2');
    listeners['typing/g1']({ val: () => ({ u9: Date.now() }) });
    check('bandeja: grupos muestran "Alguien está escribiendo..."', rows.g1.innerHTML.includes('Alguien está escribiendo...'));
    const st = vm.runInContext('_drexInboxTyping.g1', ctx);
    check('bandeja: caduca solo (temporizador a ~5 s)', st.timer && st.timer.ms > 0 && st.timer.ms <= 5300);
    st.timer.fn();
    check('bandeja: al caducar el temporizador se restaura la fila', rows.g1.innerHTML === 'previo g1');
    listeners['typing/c1']({ val: () => ({ u1: Date.now() }) });
    vm.runInContext('drexInboxTypingStop()', ctx);
    check('bandeja: detener suelta todos los listeners y restaura filas', Object.keys(listeners).length === 0 && rows.c1.innerHTML === 'previo c1');
    inbox.classList.hidden = true;
    refs.length = 0; vm.runInContext('drexInboxTypingSync(items)', ctx);
    check('bandeja: con la bandeja oculta no se suscribe nada', refs.length === 0);
    inbox.classList.hidden = false;
    const many = Array.from({ length: 35 }, (_, i) => ({ id: 'k' + i })); refs.length = 0;
    vm.runInContext('drexInboxTypingSync(many)', Object.assign(ctx, { many }));
    check('bandeja: máximo 20 listeners (eficiencia)', refs.length === 20);
    vm.runInContext('drexInboxTypingStop()', ctx);
    check('bandeja: sync/stop/re-render conectados (sala abierta => stop; volver => sync; render => sync)',
      html.includes('try{drexInboxTypingSync(items)}catch(_){}const container=document.getElementById("chat-conversations-list")') && html.includes('markChatConversationRead(currentChatRoomId);try{drexInboxTypingStop()}catch(_){}') && html.includes('markChatConversationRead(groupId);try{drexInboxTypingStop()}catch(_){}') && html.includes('try{drexInboxTypingSync(allChatConversations)}catch(_){}'));
    // fila renderizada con el estado activo
    const rowCtx = { appT: s => s, escapeHtml: esc, drexInboxIsTyping: id => id === 'c9', drexInboxTypingHtml: () => '<span class="italic">escribiendo...</span>' };
    vm.createContext(rowCtx); vm.runInContext(extractFn(html, 'drexInboxRowHtml'), rowCtx);
    const base = { attrs: 'onclick="x()"', avatarHtml: '', nameHtml: 'N', previewHtml: 'hola <b>', timeStr: '', handle: '', unread: false, unreadCount: 0, isLast: true };
    const on = rowCtx.drexInboxRowHtml({ ...base, convId: 'c9' });
    const off = rowCtx.drexInboxRowHtml({ ...base, convId: 'c8' });
    check('fila: con escritura activa pinta "escribiendo", guarda la vista previa escapada y color de marca', on.includes('data-conv-prev="c9"') && on.includes('escribiendo...') && on.includes('data-orig="hola &lt;b&gt;"') && on.includes('var(--drex-brand)'));
    check('fila: sin escritura queda igual (solo añade data-conv-prev)', off.includes('data-conv-prev="c8"') && off.includes('hola <b>') && !off.includes('data-orig'));
  }

  // ---------- B. vista previa de enlaces ----------
  {
    const store = {};
    const ctx = { escapeHtml: esc, window: {}, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } }, URL, JSON, Date, setTimeout: (f) => 0, clearTimeout() {}, console };
    vm.createContext(ctx);
    const names = ['drexLpStore', 'drexLpSaveSoon', 'drexLpExtractUrl', 'drexLpSanitize', 'drexLpCardHtml'];
    vm.runInContext('const DREX_LP_KEY="k",DREX_LP_TTL=6048e5,DREX_LP_NEG_TTL=36e5,DREX_LP_MAX=120;let _drexLpMem=null,_drexLpSaveT=null;' + names.map(n => extractFn(html, n)).join('\n'), ctx);
    const ex = t => vm.runInContext('drexLpExtractUrl(' + JSON.stringify(t) + ')', ctx);
    check('enlaces: extrae la primera URL y quita puntuación final', ex('mira https://www.ejemplo.com/a/b?x=1#frag, genial.').href === 'https://www.ejemplo.com/a/b?x=1' && ex('(https://a.com/x).').host === 'a.com');
    check('enlaces: rechaza esquemas peligrosos, localhost, IPs, puertos IPv6 y credenciales',
      ['javascript:alert(1)', 'data:text/html,hola', 'ftp://a.com/x', 'http://localhost/x', 'http://127.0.0.1/x', 'http://192.168.0.1/', 'http://[::1]/', 'https://u:p@a.com/', 'http://intranet/', 'http://algo.local/', 'sin enlaces'].every(t => ex(t) === null));
    const long = 'https://a.com/' + 'x'.repeat(2100);
    check('enlaces: URLs de más de 2048 caracteres se ignoran', ex(long) === null);
    const san = d => vm.runInContext('drexLpSanitize(' + JSON.stringify(d) + ')', ctx);
    const s1 = san({ title: '  Hola   mundo ', description: 'd'.repeat(500), image: 'http://x.com/a.png', siteName: 5 });
    check('sanitizar: recorta, exige imagen https y descarta tipos raros', s1.title === 'Hola mundo' && s1.description.length === 240 && s1.image === '' && s1.siteName === '');
    check('sanitizar: rechaza javascript: como imagen y respuestas vacías', san({ title: 'T', image: 'javascript:alert(1)' }).image === '' && san({}) === null && san(null) === null && san('x') === null);
    const u = ex('https://ejemplo.com/p');
    const card = d => { ctx.__d = d; ctx.__u = u; return vm.runInContext('drexLpCardHtml(__d,__u,false)', ctx); };
    const evil = card({ title: '<img src=x onerror=alert(1)>', description: '"><script>x</script>', image: 'https://i.com/a.png"onerror="alert(1)', siteName: 'S' });
    check('tarjeta: todo escapado (sin etiquetas ni atributos inyectados)', !/<script|<img src=x/.test(evil) && evil.includes('&lt;img src=x onerror=alert(1)&gt;'));
    check('tarjeta: enlace seguro (_blank + noopener noreferrer nofollow) e imagen perezosa sin referrer', evil.includes('target="_blank"') && evil.includes('rel="noopener noreferrer nofollow"') && evil.includes('loading="lazy"') && evil.includes('referrerpolicy="no-referrer"'));
    const fb = card(null);
    check('tarjeta: sin metadatos cae a tarjeta de dominio (host + ruta), sin imagen', fb.includes('>ejemplo.com<') && fb.includes('ejemplo.com/p') && !fb.includes('<img'));
    // caché (localStorage) con expiración
    vm.runInContext('drexLpStore()["https://a.com/"]={t:1,exp:Date.now()+1000,d:{title:"T"}};drexLpSaveSoon()', ctx);
    check('caché: la memoria se hidrata desde localStorage al cargar', (() => { store.k = JSON.stringify({ 'https://z.com/': { exp: 9e15, d: { title: 'Z' } } }); const c2 = vm.createContext({ ...ctx, localStorage: ctx.localStorage }); vm.runInContext('const DREX_LP_KEY="k";let _drexLpMem=null;' + extractFn(html, 'drexLpStore') + ';var r=drexLpStore()["https://z.com/"].d.title', c2); return c2.r === 'Z'; })());
  }
  check('enlaces: se adjunta tras renderizar cada mensaje con texto; vacío por defecto => sin red (solo tarjeta de dominio)',
    html.includes('try{drexChatLinkPreviewAttach(wrapper,msg)}catch(_){}const bubble=wrapper.querySelector(".msg-bubble")') && html.includes('window.DREX_LINK_PREVIEW_URL=window.DREX_LINK_PREVIEW_URL||"";') && html.includes('if(typeof window!=="undefined"&&window.DREX_LINK_PREVIEW_URL)drexLpObserve(slot)'));
  check('enlaces: perezoso (IntersectionObserver), una sola petición en curso por URL y caché negativa', html.includes('new IntersectionObserver') && html.includes('_drexLpInflight[u.href]') && html.includes('DREX_LP_NEG_TTL'));
  check('enlaces: fetch sin credenciales ni referrer', html.includes('credentials:"omit",referrerPolicy:"no-referrer"'));
  check('enlaces: no se generan en ver-una-vez, temporales ni eliminados', html.includes('msg.viewOnce||msg.deletedForAll||msg.autoDestroyAt'));

  // ---------- C. lambda-link-preview (funciones puras) ----------
  try {
    const lp = await import(path.join(__dirname, '..', 'lambda-link-preview', 'index.js'));
    check('lambda: bloquea IPs internas y metadata de nube', ['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.0.1', '::1', 'fd00::1'].every(lp.isPrivateAddress) && !lp.isPrivateAddress('8.8.8.8'));
    check('lambda: normalizeTarget rechaza esquemas, credenciales, puertos y hosts locales', ['file:///etc/passwd', 'http://localhost', 'https://u:p@a.com', 'https://a.com:8443', 'http://10.0.0.1'].every(x => lp.normalizeTarget(x) === null) && lp.normalizeTarget('https://a.com/x#y').href === 'https://a.com/x');
    const md = lp.parseMetadata('<meta property="og:title" content="A &amp; B"><meta property="og:image" content="/i.png">', 'https://a.com/p');
    check('lambda: parsea og:* y resuelve imagen relativa a https', md.title === 'A & B' && md.image === 'https://a.com/i.png');
  } catch (e) { check('lambda: carga del módulo (' + e.message + ')', false); }

  // ---------- D. infra ----------
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  check('sw.js: versión de caché >= drex-v135', (/const DREX_SW_VERSION = 'drex-v(\d+)'/.exec(sw) || [0, 0])[1] >= 135);
  check('404.html sincronizado con index.html', fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8') === html);
  console.log('\nRESULTADO: ' + (failures ? failures + ' FALLO(S)' : 'OK'));
  process.exit(failures ? 1 : 0);
})();
