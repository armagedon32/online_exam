/* Notification bell — auto-injects into student navbar (.nav-right) or admin sidebar (.sidebar) */
(function () {
  'use strict';
  var POLL_MS = 20000;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function timeAgo(dt) {
    var t = new Date(String(dt).replace(' ', 'T'));
    var diff = (Date.now() - t.getTime()) / 1000;
    if (isNaN(diff) || diff < 0) return dt || '';
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return dt ? String(dt).slice(0, 10) : '';
  }

  function inject() {
    if (document.getElementById('notifBell')) return;
    var isAdmin = !!document.querySelector('.sidebar');
    var link = isAdmin ? '/admin/messages' : '/student/messages';

    var wrap = document.createElement('div');
    wrap.id = 'notifBell';
    wrap.style.cssText = 'position:relative; display:inline-block; margin-right:4px;';
    wrap.innerHTML =
      '<button id="notifBellBtn" type="button" title="Notifications" ' +
      'style="position:relative; background:none; border:none; cursor:pointer; padding:6px; color:inherit; display:flex; align-items:center; border-radius:8px;">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>' +
      '<span id="notifBadge" style="display:none; position:absolute; top:-2px; right:-2px; background:#ef4444; color:#fff; font-size:10px; font-weight:700; min-width:16px; height:16px; line-height:16px; border-radius:50%; padding:0 4px; text-align:center;"></span>' +
      '</button>' +
      '<div id="notifDrop" style="display:none; position:absolute; right:0; top:38px; width:330px; max-width:92vw; background:#fff; color:#111827; border:1px solid #e5e7eb; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.18); z-index:2000; overflow:hidden;">' +
      '<div style="padding:10px 14px; border-bottom:1px solid #eef2f7; display:flex; justify-content:space-between; align-items:center; background:#f8fafc;">' +
      '<strong style="font-size:13px;">Notifications</strong>' +
      '<button id="notifReadBtn" type="button" style="font-size:11px; color:#6366f1; background:none; border:none; cursor:pointer;">Mark all read</button>' +
      '</div>' +
      '<ul id="notifList" style="list-style:none; margin:0; padding:0; max-height:330px; overflow-y:auto;"></ul>' +
      '<div style="padding:9px 14px; border-top:1px solid #eef2f7; background:#f8fafc;">' +
      '<a href="' + link + '" style="font-size:12px; color:#6366f1; text-decoration:none; font-weight:600;">💬 Messages</a>' +
      '</div>' +
      '</div>';

    var host = isAdmin ? document.querySelector('.sidebar') : document.querySelector('.nav-right');
    if (!host) return;
    if (isAdmin) {
      var logo = host.querySelector('.logo');
      if (logo && logo.parentNode) host.insertBefore(wrap, logo.nextSibling);
      else host.insertBefore(wrap, host.firstChild);
      wrap.style.cssText += 'margin:14px auto; display:block; width:fit-content;';
    } else {
      host.insertBefore(wrap, host.firstChild);
    }

    var btn = wrap.querySelector('#notifBellBtn');
    var drop = wrap.querySelector('#notifDrop');
    var badge = wrap.querySelector('#notifBadge');
    var list = wrap.querySelector('#notifList');

    function updateBadge(u) {
      if (u > 0) { badge.textContent = u > 99 ? '99+' : u; badge.style.display = 'block'; }
      else badge.style.display = 'none';
    }

    function render(items, unread) {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<li style="padding:20px; text-align:center; color:#9ca3af; font-size:12px;">No notifications yet</li>';
      } else {
        items.forEach(function (n) {
          var li = document.createElement('li');
          li.setAttribute('data-id', n.id);
          li.style.cssText = 'padding:11px 14px; border-bottom:1px solid #f3f4f6; cursor:pointer;' + (!n.is_read ? 'background:#eef2ff;' : '');
          var icon = n.type === 'lesson' ? '📚' : n.type === 'assignment' ? '📝' : '💬';
          li.innerHTML = '<div style="display:flex; gap:9px; align-items:flex-start;">' +
            '<span style="font-size:15px; margin-top:1px;">' + icon + '</span>' +
            '<div style="flex:1; min-width:0;">' +
            '<div style="font-size:12.5px; font-weight:600; word-break:break-word;">' + esc(n.title) + '</div>' +
            '<div style="font-size:11.5px; color:#6b7280; margin-top:2px; word-break:break-word; overflow:hidden; ' + (n.body && n.body.length > 120 ? 'height:32px;' : '') + '">' + esc(n.body) + '</div>' +
            '<div style="font-size:10px; color:#9ca3af; margin-top:4px;">' + timeAgo(n.created_at) + '</div>' +
            '</div></div>';
          if (n.link) {
            li.addEventListener('click', function () {
              fetch('/api/notifications/read', { method: 'POST' }).catch(function () {});
              window.location.href = n.link;
            });
          }
          list.appendChild(li);
        });
      }
      updateBadge(unread);
    }

    function update() {
      fetch('/api/notifications')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (drop.style.display === 'block') render(d.items || [], d.unread || 0);
          else updateBadge(d.unread || 0);
        })
        .catch(function () {});
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = drop.style.display === 'block';
      drop.style.display = open ? 'none' : 'block';
      if (!open) update();
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) drop.style.display = 'none';
    });
    wrap.querySelector('#notifReadBtn').addEventListener('click', function (e) {
      e.stopPropagation();
      fetch('/api/notifications/read', { method: 'POST' })
        .then(function () { update(); })
        .catch(function () {});
    });

    update();
    setInterval(update, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();