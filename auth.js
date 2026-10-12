/* Login wall helpers (Oct 12 2026). Token in localStorage; the server (alberta-snow-events) decides everything. */
(function () {
  var API = 'https://alberta-snow-events.krepchin.workers.dev';
  var KEY = 'asr_token', GKEY = 'asr_group';
  var A = window.ASRAuth = {
    API: API,
    token: function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    group: function () { try { return localStorage.getItem(GKEY) || ''; } catch (e) { return ''; } },
    save: function (t, g) { try { localStorage.setItem(KEY, t); localStorage.setItem(GKEY, g); } catch (e) {} },
    clear: function () { try { localStorage.removeItem(KEY); localStorage.removeItem(GKEY); } catch (e) {} },
    side: function () { try { return sessionStorage.getItem('asr_side') || ''; } catch (e) { return ''; } },
    setSide: function (s) { try { sessionStorage.setItem('asr_side', s); } catch (e) {} },
    /* 'both' accounts go back to the side they last used this session (default gov). */
    landing: function (g) { if (g === 'both') g = A.side() === 'emcon' ? 'emcon' : 'gov'; return g === 'emcon' ? 'landing-emcon.html' : 'landing-gov.html'; },
    api: function (path, opt) {
      opt = opt || {}; var h = opt.headers || {};
      var t = A.token(); if (t && !h.Authorization) h.Authorization = 'Bearer ' + t;
      if (opt.body && typeof opt.body !== 'string') { h['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.body); }
      opt.headers = h; return fetch(API + path, opt);
    },
    toLogin: function () {
      var here = location.pathname.split('/').pop() + location.search + location.hash;
      location.replace('login.html?next=' + encodeURIComponent(here));
    },
    /* Resolves with {username, group} or redirects to login.html?next=... */
    require: function () {
      if (!A.token()) { A.toLogin(); return new Promise(function () {}); }
      return A.api('/auth/me').then(function (r) {
        if (r.status === 401) { A.clear(); A.toLogin(); return new Promise(function () {}); }
        return r.ok ? r.json() : { group: A.group() };   // network/server trouble: keep the session, don't bounce
      }, function () { return { group: A.group() }; });
    },
    signOut: function () {
      var done = function () { A.clear(); location.href = 'login.html'; };
      A.api('/auth/logout', { method: 'POST' }).then(done, done);
    }
  };
  /* '‹ Home' links (a[data-home]) go to the signed-in group's landing page. */
  function setHome(g) { var l = document.querySelectorAll('a[data-home]'); for (var i = 0; i < l.length; i++) l[i].href = A.landing(g); }
  /* Side theming (Oct 12 2026): thin top band + small pill. theme-public / theme-gov / theme-emcon on <body>. */
  function theme() {
    var page = location.pathname.split('/').pop() || 'index.html';
    var pub = ['index.html', 'outlook.html', 'forecast.html', 'login.html', 'admin.html'].indexOf(page) >= 0;
    if (page === 'admin.html') return;
    var g = A.group(), t = pub ? 'public' : page === 'landing-emcon.html' ? 'emcon' : page === 'landing-gov.html' ? 'gov'
      : g === 'emcon' ? 'emcon' : g === 'both' && A.side() === 'emcon' ? 'emcon' : 'gov';
    var C = { public: ['#7cc4ff', 'PUBLIC'], gov: ['#14e0c0', 'ALBERTA GOVERNMENT'], emcon: ['#ff8a1f', 'EMCON SERVICES'] }[t];
    var st = document.createElement('style');
    st.textContent = 'body.theme-' + t + '::before{content:"";position:fixed;top:0;left:0;right:0;height:5px;background:' + C[0] + ';z-index:9999;pointer-events:none}' +
      '.side-pill{display:inline-block;margin-left:.4rem;padding:1px 6px;border-radius:999px;border:1px solid ' + C[0] + ';color:' + C[0] +
      ';font:700 9px/1.5 system-ui,sans-serif;letter-spacing:.06em;vertical-align:middle;white-space:nowrap}';
    document.head.appendChild(st);
    document.body.classList.add('theme-' + t);
    var h = document.querySelector('h1');
    if (h) { var p = document.createElement('span'); p.className = 'side-pill'; p.textContent = C[1]; h.insertAdjacentElement('afterend', p); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    theme();
    setHome(A.group());
    var so = document.querySelectorAll('[data-signout]'); for (var i = 0; i < so.length; i++) so[i].addEventListener('click', function (e) { e.preventDefault(); A.signOut(); });
    if (A.token()) A.api('/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (m) { if (m && m.group) setHome(m.group); }, function () {});
  });
})();
