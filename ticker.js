/* Shared 511 road events ticker. <script src="ticker.js" data-page="outlook|gov|emcon">.
   Placement comes from the admin setting (GET /settings/ticker: off | gov | emcon | both, default both).
   outlook.html: shown unless 'off'. Landing pages: shown when the setting names that page or 'both'. Never invents events. */
(function(){
var me=document.currentScript,page=(me&&me.dataset.page)||'outlook';
var SET='https://alberta-snow-events.krepchin.workers.dev/settings/ticker',URL_='https://alberta-plow-relay.krepchin.workers.dev/roadevents';
var esc=function(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
var TY={closures:'Closure',accidentsAndIncidents:'Incident',roadwork:'Roadwork',generalInfo:'Advisory',specialEvents:'Event'};
function want(v){ return page==='outlook'?v!=='off':(v==='both'||v===page); }
var box=document.getElementById('rtk');
function mk(){ if(box) return box; box=document.createElement('div'); box.id='rtk'; box.setAttribute('role','marquee'); box.setAttribute('aria-label','Current 511 Alberta road events'); box.title='Tap to pause';
  box.innerHTML='<span class="st">Loading road events…</span>'; document.body.insertBefore(box,document.body.firstChild); return box; }
function st(t){ box.innerHTML='<span class="st">'+esc(t)+'</span>'; }
var timer=null,bound=false;
function go(){
  fetch(URL_,{cache:'no-store'}).then(function(r){return r.json().then(function(d){ if(!r.ok||d.error||!Array.isArray(d.events)) throw 0; return d; })}).then(function(d){
    if(!d.events.length){st('No road events right now');return}
    var one=d.events.map(function(e){var cl=e.full_closure||e.type==='closures';var desc=String(e.description||'').replace(/\s+/g,' ').replace(/\s*Activities:.*$/,'').trim();
      return '<span class="it"><b'+(cl?' class="cl"':'')+'>'+esc(TY[e.type]||e.type||'Event')+(e.road?' · '+esc(e.road):'')+'</b> '+esc(desc)+'</span>'}).join('')+'<span class="it" style="color:var(--tk-mute)">Source: 511 Alberta</span>';
    box.innerHTML='<span class="tr">'+one+one+'</span>';
    var tr=box.firstChild;tr.style.setProperty('--dur',Math.max(20,Math.round(tr.scrollWidth/2/45))+'s');
  },function(){st('Road events unavailable')});
}
function apply(v){
  if(!want(v)){ if(box) box.hidden=true; if(timer){clearInterval(timer);timer=null} return; }
  mk(); box.hidden=false;
  if(!bound){ bound=true; box.addEventListener('click',function(){box.classList.toggle('paused')}); }
  if(!timer){ go(); timer=setInterval(go,300000); }
}
function check(){ return fetch(SET,{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){return j&&j.ticker},function(){return 'both'}).then(function(v){apply(v||'both')}); }
function start(){ check(); setInterval(check,300000); }
if(document.body) start(); else document.addEventListener('DOMContentLoaded',start);
})();
