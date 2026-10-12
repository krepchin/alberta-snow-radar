/* Cooperative touch gestures for Leaflet maps (touch devices only).
   One finger scrolls the page; two fingers pan/pinch the map; taps still work. */
(function () {
  var TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  var st = document.createElement('style');
  st.textContent =
    '.leaflet-container.coop-touch{touch-action:pan-x pan-y !important}' +
    '.leaflet-container.coop-touch .leaflet-pane,.leaflet-container.coop-touch .leaflet-tile,.leaflet-container.coop-touch .leaflet-interactive{touch-action:pan-x pan-y !important}' +
    '.coop-hint{position:absolute;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .3s ease}' +
    '.coop-hint.show{opacity:1}' +
    '.coop-hint span{background:rgba(5,8,15,.82);color:#e6eef8;border:1px solid rgba(20,224,192,.45);border-radius:12px;padding:.55rem .9rem;font:600 .85rem/1.2 var(--font,system-ui,sans-serif)}';
  document.head.appendChild(st);
  window.coopMap = function (map) {
    if (!TOUCH || !map || map._coop) return;
    map._coop = true;
    var el = map.getContainer();
    map.dragging.disable();           // single-finger drag no longer captured
    map.touchZoom.enable();           // two-finger pinch zoom + pan (Leaflet pans to the finger midpoint)
    el.classList.add('coop-touch');
    var hint = document.createElement('div');
    hint.className = 'coop-hint'; hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = '<span>Use two fingers to move the map</span>';
    el.appendChild(hint);
    var sx = 0, sy = 0, one = false, last = -1e9, tmr;
    el.addEventListener('touchstart', function (e) {
      one = e.touches.length === 1;
      if (one) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
      else { hint.classList.remove('show'); }
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (!one || e.touches.length !== 1) { one = false; return; }
      var t = e.touches[0];
      if (Math.abs(t.clientX - sx) + Math.abs(t.clientY - sy) < 10) return;
      one = false;
      var now = Date.now();
      if (now - last < 10000) return;
      last = now;
      hint.classList.add('show');
      clearTimeout(tmr); tmr = setTimeout(function () { hint.classList.remove('show'); }, 1200);
    }, { passive: true });
  };
})();
