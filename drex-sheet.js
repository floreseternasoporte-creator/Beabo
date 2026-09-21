/* ============================================================
   DrexSheet — Hoja inferior reutilizable estilo Meta
   API:
     window.DrexSheet.show({ icon:'check'|'info'|'warn',
                             title:'', body:'',
                             actions:[{ label:'', primary:true|false, onClick:function }] })
     window.DrexSheet.hide()
   - Sube desde abajo hasta media pantalla, backdrop semitransparente.
   - Botón cerrar (X), tap en el backdrop o tecla Escape para cerrar.
   - icon:'check' muestra un círculo de verificación grande (verde Meta).
   - onClick de una acción: si devuelve false, la hoja NO se cierra.
   ============================================================ */
(function () {
  'use strict';

  var backdropEl = null;
  var sheetEl = null;
  var iconEl = null, titleEl = null, bodyEl = null, actionsEl = null, closeBtn = null;
  var escHandler = null;
  var prevBodyOverflow = '';

  var ICON_SVG = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="width:34px;height:34px"><path stroke-linecap="round" stroke-linejoin="round" d="m5 13 4 4L19 7"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:34px;height:34px"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 11v5"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:34px;height:34px"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3 2.5 20h19L12 3z"/><path stroke-linecap="round" d="M12 10v4"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/></svg>'
  };
  var ICON_CLASS = {
    check: 'drex-sheet-icon--check',
    info: 'drex-sheet-icon--info',
    warn: 'drex-sheet-icon--warn'
  };

  function build() {
    if (sheetEl) return;
    backdropEl = document.createElement('div');
    backdropEl.id = 'drex-sheet-backdrop';
    backdropEl.className = 'drex-sheet-backdrop';
    backdropEl.addEventListener('click', hide);

    sheetEl = document.createElement('div');
    sheetEl.id = 'drex-sheet';
    sheetEl.className = 'drex-sheet';
    sheetEl.setAttribute('role', 'dialog');
    sheetEl.setAttribute('aria-modal', 'true');

    var handle = document.createElement('div');
    handle.className = 'drex-sheet-handle';
    sheetEl.appendChild(handle);

    closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'drex-sheet-close';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="width:18px;height:18px"><path stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>';
    closeBtn.addEventListener('click', hide);
    sheetEl.appendChild(closeBtn);

    iconEl = document.createElement('div');
    iconEl.className = 'drex-sheet-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    sheetEl.appendChild(iconEl);

    titleEl = document.createElement('h3');
    titleEl.className = 'drex-sheet-title';
    sheetEl.appendChild(titleEl);

    bodyEl = document.createElement('p');
    bodyEl.className = 'drex-sheet-body';
    sheetEl.appendChild(bodyEl);

    actionsEl = document.createElement('div');
    actionsEl.className = 'drex-sheet-actions';
    sheetEl.appendChild(actionsEl);

    document.body.appendChild(backdropEl);
    document.body.appendChild(sheetEl);

    escHandler = function (e) {
      if (e && (e.key === 'Escape' || e.keyCode === 27)) hide();
    };
  }

  function isVisible() {
    return !!(sheetEl && sheetEl.classList.contains('drex-sheet--open'));
  }

  function show(opts) {
    opts = opts || {};
    build();

    var icon = (opts.icon === 'check' || opts.icon === 'warn') ? opts.icon : 'info';
    iconEl.innerHTML = ICON_SVG[icon];
    iconEl.className = 'drex-sheet-icon ' + ICON_CLASS[icon];

    titleEl.textContent = opts.title || '';
    titleEl.style.display = opts.title ? '' : 'none';
    bodyEl.textContent = opts.body || '';
    bodyEl.style.display = opts.body ? '' : 'none';

    actionsEl.innerHTML = '';
    var actions = Array.isArray(opts.actions) ? opts.actions : [];
    actions.forEach(function (a) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drex-sheet-btn' + (a.primary ? ' drex-sheet-btn--primary' : ' drex-sheet-btn--secondary');
      btn.textContent = a.label || '';
      btn.addEventListener('click', function () {
        var keepOpen = false;
        try { keepOpen = (typeof a.onClick === 'function') && a.onClick() === false; } catch (_) { keepOpen = false; }
        if (!keepOpen) hide();
      });
      actionsEl.appendChild(btn);
    });
    actionsEl.style.display = actions.length ? '' : 'none';

    sheetEl.scrollTop = 0;
    if (!isVisible()) {
      prevBodyOverflow = document.body.style.overflow || '';
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', escHandler);
    }
    // Doble rAF: garantiza que la transición CSS se dispare.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        backdropEl.classList.add('drex-sheet-backdrop--open');
        sheetEl.classList.add('drex-sheet--open');
      });
    });
    try { closeBtn.focus({ preventScroll: true }); } catch (_) {}
  }

  function hide() {
    if (!sheetEl) return;
    if (!isVisible()) return;
    backdropEl.classList.remove('drex-sheet-backdrop--open');
    sheetEl.classList.remove('drex-sheet--open');
    document.removeEventListener('keydown', escHandler);
    try { document.body.style.overflow = prevBodyOverflow; } catch (_) {}
  }

  window.DrexSheet = { show: show, hide: hide, isVisible: isVisible };
})();
