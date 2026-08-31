/* ==========================================================================
   UI NOTIFICATION LIBRARY — professional toasts & confirm dialogs
   Dependencies: /styles.css (uses design tokens & .ui-* classes)
   ========================================================================== */
(function () {
  'use strict';

  var ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
  };
  var TITLES = { success: 'Success', error: 'Error', warning: 'Notice', info: 'Heads Up' };

  function ensureContainer() {
    var c = document.getElementById('ui-toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'ui-toast-container';
      c.className = 'ui-toast-container';
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    return c;
  }

  /* Show a dismissible toast notification. Returns the toast element. */
  function uiToast(message, type, duration) {
    type = type || 'info';
    duration = typeof duration === 'number' ? duration : 4200;
    var container = ensureContainer();
    var toast = document.createElement('div');
    toast.className = 'ui-toast ui-toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML =
      '<span class="ui-toast-icon">' + (ICONS[type] || ICONS.info) + '</span>' +
      '<div class="ui-toast-body"><div class="ui-toast-title"></div><div class="ui-toast-message"></div></div>' +
      '<button type="button" class="ui-toast-close" aria-label="Dismiss">&times;</button>';
    toast.querySelector('.ui-toast-title').textContent = TITLES[type] || 'Notice';
    toast.querySelector('.ui-toast-message').textContent = String(message || '');

    var remove = function () {
      if (toast.dataset.leaving) return;
      toast.dataset.leaving = '1';
      toast.classList.add('leaving');
      setTimeout(function () { toast.remove(); }, 260);
    };
    toast.querySelector('.ui-toast-close').addEventListener('click', remove);
    container.appendChild(toast);
    requestAnimationFrame(function () { requestAnimationFrame(function () { toast.classList.add('show'); }); });
    if (duration > 0) setTimeout(remove, duration);
    return toast;
  }

  /* Professional confirmation dialog. Resolves true/false. */
  function uiConfirm(message, opts) {
    opts = opts || {};
    var confirmText = opts.confirmText || 'Confirm';
    var cancelText = opts.cancelText || 'Cancel';
    var danger = !!opts.danger;

    return new Promise(function (resolve) {
      var existing = document.getElementById('ui-confirm-root');
      if (existing) existing.remove();

      var root = document.createElement('div');
      root.id = 'ui-confirm-root';
      root.className = 'ui-confirm-backdrop';
      root.setAttribute('role', 'presentation');
      document.body.appendChild(root);

      var box = document.createElement('div');
      box.className = 'ui-confirm-box';
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML =
        '<div class="ui-confirm-icon' + (danger ? ' danger' : '') + '">' + (danger
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>') + '</div>' +
        '<div class="ui-confirm-message"></div>' +
        '<div class="ui-confirm-actions">' +
          '<button type="button" class="ui-btn ui-btn-cancel" data-act="cancel"></button>' +
          '<button type="button" class="ui-btn ui-btn-ok' + (danger ? ' danger' : '') + '" data-act="ok"></button>' +
        '</div>';
      box.querySelector('.ui-confirm-message').textContent = String(message || 'Are you sure?');
      box.querySelector('.ui-btn-cancel').textContent = cancelText;
      box.querySelector('.ui-btn-ok').textContent = confirmText;
      root.appendChild(box);

      var closed = false;
      function close(result) {
        if (closed) return;
        closed = true;
        root.classList.add('leaving');
        document.removeEventListener('keydown', onKey);
        setTimeout(function () {
          root.remove();
          resolve(result);
        }, 220);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); close(true); }
      }
      box.querySelector('[data-act="ok"]').addEventListener('click', function () { close(true); });
      box.querySelector('[data-act="cancel"]').addEventListener('click', function () { close(false); });
      root.addEventListener('click', function (e) { if (e.target === root) close(false); });
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('show'); }); });
      box.querySelector('.ui-btn-ok').focus();
    });
  }

  /* Wire up every <form data-message="..."> so onSubmit shows a confirm dialog. */
  function uiConfirmForms(rootEl) {
    var root = rootEl || document;
    Array.prototype.forEach.call(root.querySelectorAll('form[data-message]'), function (form) {
      if (form.dataset.uiBound) return;
      form.dataset.uiBound = '1';
      form.addEventListener('submit', function (e) {
        if (form.dataset.uiConfirmed === '1') return;
        e.preventDefault();
        uiConfirm(form.getAttribute('data-message'), {
          confirmText: form.getAttribute('data-confirm-text') || 'Confirm',
          cancelText: form.getAttribute('data-cancel-text') || 'Cancel',
          danger: form.getAttribute('data-danger') === 'true'
        }).then(function (ok) {
          if (ok) {
            form.dataset.uiConfirmed = '1';
            form.submit();
          }
        });
      });
    });
  }

  /* Wire up every <a data-ui-confirm="message"> so clicks show a confirm dialog before navigating. */
  function uiConfirmLinks(rootEl) {
    var root = rootEl || document;
    Array.prototype.forEach.call(root.querySelectorAll('a[data-ui-confirm]'), function (a) {
      if (a.dataset.uiBound) return;
      a.dataset.uiBound = '1';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        uiConfirm(a.getAttribute('data-ui-confirm'), {
          confirmText: a.getAttribute('data-confirm-text') || 'Continue',
          cancelText: a.getAttribute('data-cancel-text') || 'Cancel',
          danger: a.getAttribute('data-danger') === 'true'
        }).then(function (ok) {
          if (ok) window.location.href = a.getAttribute('href') || a.href;
        });
      });
    });
  }

  /* Show professional toasts from ?error=?success=?warning=?info= URL params. */
  function uiShowUrlAlerts() {
    var qs = new URLSearchParams(location.search);
    var map = { error: 'error', success: 'success', warning: 'warning', info: 'info' };
    Object.keys(map).forEach(function (key) {
      var v = qs.get(key);
      if (v) uiToast(decodeURIComponent(v.replace(/\+/g, ' ')), map[key]);
    });
  }

  if (typeof window.uiToast === 'undefined') window.uiToast = uiToast;
  if (typeof window.uiConfirm === 'undefined') window.uiConfirm = uiConfirm;
  window.uiConfirmForms = uiConfirmForms;
  window.uiConfirmLinks = uiConfirmLinks;
  window.uiShowUrlAlerts = uiShowUrlAlerts;
})();