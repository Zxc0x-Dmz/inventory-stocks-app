/* Inventory/Stocks app.  Runs in three modes:
 *   EMBED - opened from the Apps Script link (talks through google.script.run)
 *   LIVE  - opened from GitHub Pages / installed on the phone (talks to the Apps Script URL)
 *   DEMO  - nothing connected yet; sample data kept on this device only
 */
(function () {
  'use strict';

  var MODELS = {
    OK4: { name: 'OKAI 400C', kind: 'Scooter' },
    NB3: { name: 'Ninebot C1 A300', kind: 'Scooter' },
    NB2: { name: 'Ninebot A200', kind: 'E-bike' },
    UNI: { name: 'Universal / shared', kind: 'All models' }
  };
  var SYSTEMS = { ELC: 'Electrical', WHL: 'Wheels & brakes', BDY: 'Body & frame', DRV: 'Drivetrain', FST: 'Fasteners' };
  var COUNT_EVERY = { A: 14, B: 31, C: 92 };
  var USD_PER_EUR = 1.123, AED_PER_USD = 3.6725, AED_PER_EUR = USD_PER_EUR * AED_PER_USD;
  function price(p) { var v = p && p.price_eur; return v === '' || v == null || !isFinite(Number(v)) ? null : Number(v); }
  function money(v, cur) { return v == null ? '—' : (cur || '€') + ' ' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  var QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
  var SCAN_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

  /* ---------------- small helpers ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function uid() { return (cfg.device || 'D') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  function daysSince(d) { if (!d || !/^\d{4}-\d\d-\d\d/.test(d)) return 9999; return Math.floor((Date.now() - new Date(d.slice(0, 10)).getTime()) / 864e5); }
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      if (qsa('script[src="' + src + '"]').length) return ok();
      var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { bad(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  var toastT;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast hidden'; }, kind === 'bad' ? 5000 : 2600);
  }
  function beep(ok) {
    try {
      var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok === false ? 220 : 1320; o.connect(g); g.connect(a.destination); g.gain.value = .08;
      o.start(); o.stop(a.currentTime + (ok === false ? .35 : .09));
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(ok === false ? [80, 60, 80] : 60);
  }

  /* ---------------- config & transport ---------------- */
  var cfg = load('inv.cfg', {});
  if (!cfg.device) { cfg.device = 'D' + Math.random().toString(36).slice(2, 6).toUpperCase(); save('inv.cfg', cfg); }
  if (cfg.me !== undefined || (!cfg.user && cfg.pin)) { delete cfg.me; delete cfg.pin; save('inv.cfg', cfg); }   // old shared-PIN setup
  var DEMO_ADMIN_PIN = '1234';
  function signedIn() { return !!(cfg.user && cfg.pin); }
  function isSup() { return cfg.role === 'supervisor'; }
  var EMBED = !!(window.google && google.script && google.script.run);
  function mode() { return EMBED ? 'EMBED' : cfg.url ? 'LIVE' : 'DEMO'; }

  /* demo storage: same interface as the Google Sheet store in Code.gs */
  function DemoStore() {
    this.d = load('inv.demo', null);
    if (!this.d) { this.d = demoData(); this.persist(); }
    if (!this.d.t.Staff.length || this.d.t.Staff[0].role === undefined) { this.d.t.Staff = DEMO_STAFF.map(function (r) { return Object.assign({}, r); }); this.persist(); }
  }
  DemoStore.prototype.persist = function () { save('inv.demo', this.d); };
  DemoStore.prototype.rows = function (n) { return this.d.t[n]; };
  DemoStore.prototype.tail = function (n, k) { return this.d.t[n].slice(-k); };
  DemoStore.prototype.update = function (n, row, patch) { Object.keys(patch).forEach(function (k) { row[k] = String(patch[k]); }); this.persist(); };
  DemoStore.prototype.append = function (n, o) { var r = {}; TABLES[n].forEach(function (c) { r[c] = o[c] == null ? '' : String(o[c]); }); this.d.t[n].push(r); this.persist(); };
  DemoStore.prototype.hasMovement = function (id) { return this.d.t.Movements.some(function (m) { return m.id === id; }); };
  DemoStore.prototype.version = function () { return this.d.v; };
  DemoStore.prototype.bump = function () { this.d.v++; this.persist(); };

  /* demo people: Mechanic A / 1111, Mechanic B / 2222, Supervisor / 9999.  Admin / 1234 also works. */
  var DEMO_STAFF = [
    { name: 'Mechanic A', pin_hash: 'f6634054eb9f58c426a0d041df3c4abac9dc0fcf92986945932fbcac0bfb48a1', role: 'mechanic', active: 'yes' },
    { name: 'Mechanic B', pin_hash: 'f97188b65c3b3bcfd71e64ebfb1375453a74a9d96bbfa550202d97cd1dc305af', role: 'mechanic', active: 'yes' },
    { name: 'Supervisor', pin_hash: '550d30d3f03371426753e0bb8e37d72f54227fb8de59a65ada78d114bdfc08ce', role: 'supervisor', active: 'yes' }
  ];

  function demoData() {
    var t = { Parts: [], Locations: [], Movements: [], Counts: [], Staff: DEMO_STAFF.map(function (r) { return Object.assign({}, r); }) };
    var rack = { OK4: 1, NB3: 2, NB2: 3, UNI: 4 }, perRack = {}, tote = 1, stamp = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
    (window.DEMO_PARTS || []).forEach(function (p, i) {
      t.Parts.push({ sku: p.sku, name: p.name, model: p.model, system: p.system, abc: p.abc, ns_sku: p.ns_sku, tier_code: p.tier_code, fits: p.fits, unit: 'pcs', notes: p.notes || '',
        price_eur: p.price_eur == null ? '' : String(p.price_eur), weight_g: p.weight_g == null ? '' : String(p.weight_g), photo_id: p.photo_id || '' });
      var j = perRack[p.model] = (perRack[p.model] || 0) + 1;
      var loc = 'R' + rack[p.model] + '-S' + (1 + Math.floor((j - 1) / 6)) + '-B' + ('0' + (((j - 1) % 6) + 1)).slice(-2);
      var qty = p.abc === 'C' ? 40 + (i * 37) % 160 : (i * 7) % 18;
      t.Locations.push({ loc: loc, type: 'BIN', sku: p.sku, qty: String(qty), min: String(p.abc === 'C' ? 30 : p.abc === 'A' ? 2 : 4), sealed_date: '', last_count: stamp, notes: '' });
      if (p.abc === 'A') {
        t.Locations.push({ loc: 'T-' + ('000' + tote++).slice(-4), type: 'TOTE', sku: p.sku, qty: '20', min: '0', sealed_date: stamp, last_count: stamp, notes: 'Above rack R' + rack[p.model] });
      }
    });
    return { t: t, v: 1 };
  }

  var demo = null;
  function demoCore() { if (!demo) demo = new Core(new DemoStore()); return demo; }

  function sha256Hex(text) {
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.reject(new Error('Demo sign-in needs an https or localhost page'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function bizError(msg, extra, code) { var e = new Error(msg); e.extra = extra; e.business = true; e.code = code || (extra && extra.code); return e; }

  /** Demo mode: the same checks the Apps Script backend does (see run_ in Code.gs). */
  function demoCall(op, p, auth) {
    var core = demoCore(), who = null;
    var user = String(auth.user || '').trim(), pin = String(auth.pin || '');
    var steps = Promise.resolve();
    if (!PUBLIC_OPS[op]) {
      steps = steps.then(function () {
        if (!user || !pin) throw bizError('Please sign in', null, 'AUTH');
        if (user === ADMIN_NAME) { if (pin !== DEMO_ADMIN_PIN) throw bizError('Wrong name or PIN', null, 'AUTH'); who = { name: ADMIN_NAME, role: 'supervisor' }; return; }
        return sha256Hex(staffKey_(user, pin)).then(function (h) {
          who = matchStaff_(core.s.rows('Staff'), user, h);
          if (!who) throw bizError('Wrong name or PIN', null, 'AUTH');
        });
      });
    }
    if (op === 'photo') return steps.then(function () { return { ok: true, id: p.id, data: (window.DEMO_PHOTOS && window.DEMO_PHOTOS[p.id]) || null }; });
    if ((op === 'addStaff' || op === 'setStaff') && p.new_pin !== undefined && p.new_pin !== '') {
      steps = steps.then(function () {
        if (!pinOk_(p.new_pin)) throw bizError('PIN must be 4 to 8 digits');
        return sha256Hex(staffKey_(p.name, p.new_pin)).then(function (h) { p.pin_hash = h; });
      });
    }
    return steps.then(function () {
      delete p.new_pin;
      return new Promise(function (ok) { setTimeout(ok, 120); });
    }).then(function () {
      try { var r = core.handle(op, p, who); if (r && r.ok === undefined) r.ok = true; return JSON.parse(JSON.stringify(r)); }
      catch (e) { if (e.business) throw e; throw bizError(e.message, e.extra); }
    });
  }

  /** auth = {user, pin}; defaults to the person signed in on this device. */
  function api(op, p, auth) {
    var m = mode();
    auth = auth || { user: cfg.user || '', pin: cfg.pin || '' };
    p = JSON.parse(JSON.stringify(p || {}));
    if (m === 'DEMO') return demoCall(op, p, auth);
    var call = m === 'EMBED'
      ? new Promise(function (ok, bad) { google.script.run.withSuccessHandler(ok).withFailureHandler(bad).api(op, p, auth); })
      : fetch(cfg.url, { method: 'POST', body: JSON.stringify({ op: op, p: p, user: auth.user, pin: auth.pin }) }).then(function (r) {
          if (!r.ok) throw new Error('Server answered ' + r.status);
          return r.json();
        });
    return call.then(function (r) {
      if (!r || r.ok === false) throw bizError((r && r.error) || 'Request failed', r && r.extra, r && r.code);
      return r;
    });
  }

  /** The signed-in person was refused (PIN reset, disabled, or wrong): back to the sign-in screen. */
  function authLost(msg) {
    cfg.user = ''; cfg.pin = ''; cfg.role = ''; save('inv.cfg', cfg);
    showSignIn(msg || 'Please sign in again.');
  }

  /* ---------------- data ---------------- */
  var snap = { parts: [], locations: [], staff: [], counts: [], version: -1 };
  var P = {}, L = {}, BY = {};
  var online = true;

  function index() {
    P = {}; L = {}; BY = {};
    snap.parts.forEach(function (p) { P[p.sku] = p; });
    snap.locations.forEach(function (l) { L[String(l.loc).toUpperCase()] = l; (BY[l.sku] = BY[l.sku] || []).push(l); });
    var dl = $('skuList');
    dl.innerHTML = snap.parts.map(function (p) { return '<option value="' + esc(p.sku) + '">' + esc(p.name) + '</option>'; }).join('');
  }

  function refresh() {
    if (!signedIn()) return Promise.resolve();
    return api('snapshot').then(function (r) {
      snap = r; online = true;
      var me = (snap.staff || []).filter(function (x) { return x.name === cfg.user; })[0];
      if (me && me.role !== cfg.role) { cfg.role = me.role; save('inv.cfg', cfg); }
      applyPending();
      index(); renderAll(); setStatus();
    }).catch(function (e) {
      online = false; setStatus();
      if (e.code === 'AUTH') authLost(e.message);
      else if (snap.version < 0) toast('Cannot reach the stock sheet: ' + e.message, 'bad');
    });
  }

  var pollBusy = false;
  function poll() {
    if (document.hidden || pollBusy || mode() === 'DEMO' || !signedIn()) return;
    pollBusy = true;
    api('version').then(function (r) {
      online = true;
      if (r.version !== snap.version && !queue.some(function (q) { return q.status === 'wait'; })) return refresh();
      setStatus();
    }).catch(function (e) { if (e.code === 'AUTH') authLost(e.message); else { online = false; setStatus(); } }).then(function () { pollBusy = false; flush(); });
  }

  /* ---------------- offline-safe action queue ---------------- */
  var queue = load('inv.queue', []).filter(function (q) { return q.status === 'wait' || q.ts.slice(0, 10) === today(); });
  function saveQueue() { save('inv.queue', queue.slice(-200)); }

  /** Local effect of a movement so the screen updates instantly. */
  function effect(p, sign) {
    var src = L[p.loc], dst = p.to_loc && L[p.to_loc], q = num(p.qty) * sign;
    if (!src) return;
    if (p.type === 'OUT' || p.type === 'SCRAP') src.qty = String(num(src.qty) - q);
    else if (p.type === 'RETURN' || p.type === 'RECEIVE') src.qty = String(num(src.qty) + q);
    else if (p.type === 'SEAL') { if (sign > 0) { p._was = src.qty; src.qty = String(p.qty); src.sealed_date = today(); } }
    else if (dst) { src.qty = String(num(src.qty) - q); dst.qty = String(num(dst.qty) + q); }
  }
  function applyPending() {
    index();
    queue.forEach(function (q) { if (q.status === 'wait' && q.op === 'move') effect(q.p, 1); });
  }

  function enqueue(op, p, label) {
    // the item keeps the sign-in of the person who did it, so it is logged under them even if
    // someone else signs in on this device before it is sent
    var item = { id: p.id, op: op, p: p, label: label, status: 'wait', ts: new Date().toISOString(), by: cfg.user, auth: { user: cfg.user, pin: cfg.pin } };
    queue.push(item); saveQueue();
    if (op === 'move') effect(p, 1);
    renderAll(); flush();
    return item;
  }

  var flushing = false;
  function flush() {
    if (flushing) return;
    var next = queue.filter(function (q) { return q.status === 'wait'; })[0];
    if (!next) { setStatus(); return; }
    flushing = true; setStatus();
    api(next.op, next.p, next.auth).then(function (r) {
      next.status = 'sent'; online = true; saveQueue();
      if (r.loc && L[r.loc.loc]) L[r.loc.loc].qty = String(r.loc.qty);
      if (r.to && L[r.to.loc]) L[r.to.loc].qty = String(r.to.qty);
      if (r.version) snap.version = r.version;
      flushing = false; renderAll(); flush();
    }).catch(function (e) {
      flushing = false;
      if (!e.business) { online = false; setStatus(); setTimeout(flush, 8000); return; }
      // rejected by the rules: undo the local effect and tell the user
      if (next.op === 'move') { if (next.p.type === 'SEAL' && next.p._was != null && L[next.p.loc]) L[next.p.loc].qty = next.p._was; else effect(next.p, -1); }
      if (e.extra && e.extra.code === 'SHORT' && !next.p.force) {
        next.status = 'held'; saveQueue(); renderAll();
        askShort(next, e);
      } else {
        next.status = 'err'; next.err = e.code === 'AUTH' ? 'Sign-in refused: ' + e.message : e.message; saveQueue(); renderAll();
        beep(false); toast(next.err, 'bad');
        if (e.code === 'AUTH' && next.auth && next.auth.user === cfg.user && next.auth.pin === cfg.pin) authLost(e.message);
        flush();
      }
    });
  }

  function askShort(item, e) {
    beep(false);
    modal('<h3>Bin shows less than you took</h3><p>' + esc(e.message) + '. You took <b>' + item.p.qty + '</b>.</p>' +
      '<p class="hint">If the parts really were in the bin, the system count is wrong. Saying yes records the take and puts this bin on the supervisor\'s recount list.</p>' +
      '<div class="btns"><button class="big" data-x="no">Cancel this take</button><button class="big bad" data-x="yes">Yes, I took them</button></div>',
      function (x) {
        if (x === 'yes') { item.p.force = true; item.status = 'wait'; effect(item.p, 1); }
        else { item.status = 'err'; item.err = 'Cancelled (bin short)'; }
        saveQueue(); renderAll(); flush();
      });
  }

  /* ---------------- status / header ---------------- */
  function setStatus() {
    var w = queue.filter(function (q) { return q.status === 'wait'; }).length, el = $('status'), m = mode();
    var txt, cls;
    if (m === 'DEMO') { txt = 'Demo · this device only'; cls = 'demo'; }
    else if (!online) { txt = 'Offline' + (w ? ' · ' + w + ' waiting' : ''); cls = 'off'; }
    else { txt = w ? 'Sending ' + w + '…' : 'Live · synced'; cls = 'live'; }
    el.className = 'status ' + cls; $('statusText').textContent = txt;
    $('meBtn').textContent = signedIn() ? '👤 ' + cfg.user + (isSup() ? ' ★' : '') : '👤 Sign in';
    document.body.classList.toggle('sup', isSup());
  }

  /* ---------------- tabs ---------------- */
  var current = 'take';
  function showTab(t) {
    current = t;
    qsa('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    qsa('.tab').forEach(function (s) { s.classList.toggle('on', s.id === 'tab-' + t); });
    renderAll();
    var f = { take: 'scanInput', restock: 'restockInput', count: 'countInput' }[t];
    if (f && window.innerWidth > 800) setTimeout(function () { $(f).focus(); }, 50);
  }
  qsa('#tabs button').forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });

  function renderAll() {
    setStatus();
    if (current === 'take') renderTake();
    if (current === 'restock') renderRestock();
    if (current === 'stock') renderStock();
    if (current === 'count') renderCount();
    if (current === 'labels') renderLabels();
    if (current === 'setup') renderSetup();
    fillPhotos();
  }

  /* ---------------- scanning ---------------- */
  /** Turns any scanned text into {loc} or {sku}. */
  function resolve(code) {
    var s = String(code || '').trim();
    if (!s) return null;
    var up = s.toUpperCase();
    if (L[up]) return { loc: L[up] };
    if (P[up]) return { sku: up };
    var ns = snap.parts.filter(function (p) { return p.ns_sku && p.ns_sku === s; })[0];
    if (ns) return { sku: ns.sku };
    return null;
  }
  function vehicleFrom(text) {
    var s = String(text || '').trim();
    if (/^https?:\/\//i.test(s)) {
      try {
        var u = new URL(s), q = null;
        u.searchParams.forEach(function (v) { if (!q && /^[A-Za-z0-9-]{4,}$/.test(v)) q = v; });
        var seg = u.pathname.split('/').filter(Boolean).pop();
        s = q || seg || s;
      } catch (e) {}
    }
    return s.toUpperCase();
  }

  function onEnter(id, fn) {
    $(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var v = this.value; this.value = ''; if (v.trim()) fn(v); }
    });
  }

  // USB / Bluetooth scanners type fast and end with Enter.  Catch them even when no box has focus.
  var wedge = '', wedgeT = 0;
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('modal').classList.contains('hidden') || !$('signin').classList.contains('hidden')) return;
    var now = Date.now();
    if (now - wedgeT > 80) wedge = '';
    wedgeT = now;
    if (e.key === 'Enter') {
      if (wedge.length >= 3) {
        var target = { take: 'scanInput', restock: 'restockInput', count: 'countInput' }[current];
        if (!target) { showTab('take'); target = 'scanInput'; }
        handlers[target](wedge);
      }
      wedge = '';
    } else if (e.key.length === 1) wedge += e.key;
  });

  /* camera */
  var camStream = null, camTimer = null, camHtml5 = null, camTarget = null;
  qsa('[data-cam]').forEach(function (b) { b.onclick = function () { openCam(b.dataset.cam); }; });
  $('camClose').onclick = closeCam;

  function openCam(target) {
    camTarget = target;
    $('camModal').classList.remove('hidden');
    $('camHint').textContent = 'Point the camera at the barcode';
    if (!window.isSecureContext) { $('camHint').textContent = 'Camera needs a secure (https) page. Use the installed app link.'; return; }
    if ('BarcodeDetector' in window) {
      BarcodeDetector.getSupportedFormats().then(function (sup) {
        var want = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'data_matrix'].filter(function (f) { return sup.indexOf(f) >= 0; });
        var det = new BarcodeDetector({ formats: want.length ? want : undefined });
        return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } }).then(function (st) {
          camStream = st; var v = $('camVideo'); v.style.display = ''; v.srcObject = st; return v.play().then(function () {
            var tick = function () {
              if (!camStream) return;
              det.detect(v).then(function (codes) {
                if (codes && codes.length) camDone(codes[0].rawValue); else camTimer = setTimeout(tick, 120);
              }).catch(function () { camTimer = setTimeout(tick, 250); });
            };
            tick();
          });
        });
      }).catch(camFallback);
    } else camFallback();
  }
  function camFallback(err) {
    if (err && err.name === 'NotAllowedError') { $('camHint').textContent = 'Camera permission was refused. Allow it in the browser settings.'; return; }
    $('camVideo').style.display = 'none';
    var box = $('camBox'); if (!$('reader')) { var d = document.createElement('div'); d.id = 'reader'; box.appendChild(d); }
    loadScript(SCAN_LIB).then(function () {
      camHtml5 = new Html5Qrcode('reader');
      return camHtml5.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, function (txt) { camDone(txt); });
    }).catch(function (e) { $('camHint').textContent = 'Camera not available: ' + (e.message || e); });
  }
  function stopCam() {
    clearTimeout(camTimer);
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
    if (camHtml5) { var h = camHtml5; camHtml5 = null; h.stop().catch(function () {}).then(function () { var r = $('reader'); if (r) r.remove(); }); }
  }
  function closeCam() { stopCam(); $('camModal').classList.add('hidden'); }
  function camDone(text) {
    beep(true); closeCam();
    if (handlers[camTarget]) handlers[camTarget](text);
    else { $(camTarget).value = camTarget === 'takeVehicle' ? vehicleFrom(text) : text; }
  }

  /* ---------------- modal ---------------- */
  var modalCb = null;
  function modal(html, cb) {
    $('modalBody').innerHTML = html; modalCb = cb || null;
    $('modal').classList.remove('hidden');
    var f = $('modalBody').querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 60);
    fillPhotos();
  }
  function closeModal() { $('modal').classList.add('hidden'); $('modalBody').innerHTML = ''; }
  $('modal').addEventListener('click', function (e) {
    if (e.target.id === 'modal') { closeModal(); return; }
    var b = e.target.closest('[data-x]');
    if (b) { var cb = modalCb, x = b.dataset.x; if (x !== 'stay') closeModal(); if (cb) cb(x, b); }
  });

  /* ---------------- part photos ----------------
   * Photos stay private in Google Drive.  The backend sends a small thumbnail after the PIN check
   * and this device keeps it in Cache Storage, so each photo is downloaded once. */
  var PHOTO_CACHE = 'stocks-photos-v1', photoMem = {}, photoBusy = {};
  function photoKey(id) { return new URL('__photo/' + encodeURIComponent(id), location.href).href; }
  function cacheGet(id) {
    if (!window.caches || !/^https?:/.test(location.protocol)) return Promise.resolve(null);
    return caches.open(PHOTO_CACHE).then(function (c) { return c.match(photoKey(id)); }).then(function (r) { return r ? r.text() : null; }).catch(function () { return null; });
  }
  function cachePut(id, data) {
    if (!window.caches || !/^https?:/.test(location.protocol)) return;
    caches.open(PHOTO_CACHE).then(function (c) { return c.put(photoKey(id), new Response(data, { headers: { 'Content-Type': 'text/plain' } })); }).catch(function () {});
  }
  /** Data URL of a part photo, or null.  A missing photo is remembered until the app is reopened. */
  function getPhoto(id) {
    if (!id) return Promise.resolve(null);
    if (photoMem[id] !== undefined) return Promise.resolve(photoMem[id]);
    if (photoBusy[id]) return photoBusy[id];
    return (photoBusy[id] = cacheGet(id).then(function (hit) {
      if (hit) return hit;
      return api('photo', { id: id }).then(function (r) { if (r.data) cachePut(id, r.data); return r.data || null; });
    }).then(function (d) { photoMem[id] = d; delete photoBusy[id]; return d; },
      function () { delete photoBusy[id]; return null; }));   // offline: try again later
  }
  /** Fills every photo placeholder on screen. */
  function fillPhotos() {
    qsa('[data-photo]').forEach(function (el) {
      if (el.dataset.state) return;
      el.dataset.state = 'loading';
      getPhoto(el.dataset.photo).then(function (d) {
        if (d) { el.style.backgroundImage = 'url("' + d + '")'; el.dataset.state = 'ok'; el.onclick = function (e) { e.stopPropagation(); bigPhoto(d); }; }
        else el.dataset.state = 'none';
      });
    });
  }
  function bigPhoto(d) {
    var o = document.createElement('div'); o.className = 'photoBig'; o.innerHTML = '<img alt="">'; o.firstChild.src = d;
    o.onclick = function () { o.remove(); }; document.body.appendChild(o);
  }
  var photoT = null;
  function photoBox(part) {
    if (!part.photo_id) return '';
    clearTimeout(photoT); photoT = setTimeout(fillPhotos, 0);   // runs once the card is on screen
    return '<div class="pphoto" data-photo="' + esc(part.photo_id) + '" title="Tap to enlarge"></div>';
  }

  /* ---------------- part card ---------------- */
  function partCard(part, loc, opts) {
    opts = opts || {};
    var m = MODELS[part.model] || MODELS.UNI, bins = (BY[part.sku] || []).filter(function (l) { return l.type === 'BIN'; });
    var totes = (BY[part.sku] || []).filter(function (l) { return l.type === 'TOTE'; });
    var toteQty = totes.reduce(function (a, l) { return a + num(l.qty); }, 0);
    var facts = '';
    if (loc) {
      var low = loc.type === 'BIN' && num(loc.min) > 0 && num(loc.qty) <= num(loc.min);
      facts += '<div class="fact"><small>' + (loc.type === 'TOTE' ? 'Sealed tote' : 'Bin') + '</small><b class="mono">' + esc(loc.loc) + '</b></div>';
      if (!opts.blind) facts += '<div class="fact' + (low ? ' low' : '') + '"><small>' + (loc.type === 'TOTE' ? 'In tote' : 'In bin') + '</small><b>' + num(loc.qty) + '</b></div>';
      if (!opts.blind && loc.type === 'BIN') facts += '<div class="fact"><small>Min</small><b>' + num(loc.min) + '</b></div>';
      if (loc.type === 'TOTE' && loc.sealed_date) facts += '<div class="fact"><small>Sealed</small><b style="font-size:15px">' + esc(loc.sealed_date) + '</b></div>';
    }
    if (!opts.blind && loc && loc.type === 'BIN') facts += '<div class="fact"><small>In sealed totes</small><b>' + toteQty + '</b></div>';
    return '<div class="card m-' + esc(part.model) + '"><div class="band"><span>' + esc(m.name) + '</span><span>' + esc(SYSTEMS[part.system] || part.system) + ' · ' + esc(part.abc) + '</span></div>' +
      '<div class="body">' + photoBox(part) + '<div class="name">' + esc(part.name) + '</div><div class="sku">' + esc(part.sku) + (part.ns_sku ? ' · NS ' + esc(part.ns_sku) : '') + '</div>' +
      '<div class="facts">' + facts + '</div>' + (opts.extra || '') + '</div></div>';
  }

  /* ---------------- TAKE ---------------- */
  var act = 'OUT', take = null;  // take = {loc}
  qsa('#actionSeg button').forEach(function (b) {
    b.onclick = function () { act = b.dataset.act; qsa('#actionSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); renderTake(); };
  });
  qsa('.stepper').forEach(function (s) {
    var inp = s.querySelector('input');
    qsa('button', s).forEach(function (b) { b.onclick = function () { inp.value = Math.max(1, num(inp.value) + num(b.dataset.step)); }; });
  });

  function scanTake(code) {
    var r = resolve(code);
    if (!r) { beep(false); toast('Not found: ' + code + '. Is the label set up?', 'bad'); take = null; renderTake(); return; }
    var loc = r.loc;
    if (!loc) {
      var bins = (BY[r.sku] || []).filter(function (l) { return l.type === 'BIN'; });
      bins.sort(function (a, b) { return num(b.qty) - num(a.qty); });
      loc = bins[0];
      if (!loc) { beep(false); toast(r.sku + ' has no picking bin yet. Add one in Setup.', 'bad'); return; }
    }
    if (!loc.sku || !P[loc.sku]) { beep(false); toast(loc.loc + ' has no part assigned. Set it up in Setup.', 'bad'); return; }
    if (loc.type === 'TOTE' && (act === 'OUT' || act === 'SCRAP')) {
      beep(false); toast(loc.loc + ' is a sealed tote. Use Restock to break the seal into the bin.', 'bad'); return;
    }
    beep(true);
    take = { loc: loc.loc };
    $('takeQty').value = 1; $('takeNote').value = '';
    renderTake();
    if (act === 'OUT' && !$('takeVehicle').value && window.innerWidth > 800) $('takeVehicle').focus();
  }

  function renderTake() {
    var loc = take && L[take.loc], part = loc && P[loc.sku];
    $('takeCard').classList.toggle('hidden', !part);
    $('takeForm').classList.toggle('hidden', !part);
    if (part) $('takeCard').innerHTML = partCard(part, loc);
    $('whoRow').style.display = act === 'OUT' || act === 'RETURN' ? '' : 'none';
    $('takeWho').textContent = 'Logged under your name: ' + (cfg.user || '-');
    $('takeGo').textContent = { OUT: 'Take out of bin', RETURN: 'Put back in bin', SCRAP: 'Write off as damaged', RECEIVE: 'Add delivery to bin' }[act];
    $('takeGo').className = 'big ' + (act === 'SCRAP' ? 'bad' : act === 'OUT' ? 'go' : 'ok');
    // recent list
    var mine = queue.slice(-25).reverse();
    $('recent').innerHTML = mine.length ? mine.map(function (q) {
      var st = { wait: ['wait', 'Waiting'], sent: ['sent', 'Saved'], err: ['err', 'Failed'], held: ['wait', 'Check'] }[q.status] || ['', q.status];
      return '<div class="item"><span class="swatch sw-' + esc((P[q.p.sku || (L[q.p.loc] || {}).sku] || {}).model || 'UNI') + '"></span><div class="grow"><div class="t1">' + esc(q.label) + '</div>' +
        '<div class="t2">' + esc(q.ts.slice(11, 16)) + ' · ' + esc(q.p.loc) + (q.p.to_loc ? ' → ' + esc(q.p.to_loc) : '') + (q.p.vehicle ? ' · ' + esc(q.p.vehicle) : '') + (q.by ? ' · ' + esc(q.by) : '') + (q.err ? ' · ' + esc(q.err) : '') + '</div></div>' +
        '<span class="pill ' + st[0] + '">' + st[1] + '</span></div>';
    }).join('') : '<p class="hint">Nothing yet. Scan a bin label to start.</p>';
  }

  $('takeGo').onclick = function () {
    var loc = take && L[take.loc]; if (!loc) return;
    var part = P[loc.sku], qty = Math.round(num($('takeQty').value));
    var veh = vehicleFrom($('takeVehicle').value);
    if (qty < 1) return toast('Quantity must be 1 or more', 'bad');
    if (!signedIn()) return showSignIn();
    if (act === 'OUT' && !veh) { $('takeVehicle').focus(); return toast('Scan or type the scooter / bike ID', 'bad'); }
    var p = { id: uid(), type: act, loc: loc.loc, sku: loc.sku, qty: qty, vehicle: act === 'OUT' || act === 'RETURN' ? veh : '', note: $('takeNote').value.trim(), device: cfg.device };
    var verb = { OUT: '−', RETURN: '+', SCRAP: '✕ −', RECEIVE: '+' }[act];
    enqueue('move', p, verb + qty + ' ' + part.name);
    toast(verb + qty + ' ' + part.name + ' · ' + loc.loc + ' now ' + num(L[loc.loc].qty), 'good');
    var nowLoc = L[loc.loc];
    if (nowLoc.type === 'BIN' && num(nowLoc.min) > 0 && num(nowLoc.qty) <= num(nowLoc.min) && (act === 'OUT' || act === 'SCRAP')) {
      var totes = (BY[loc.sku] || []).filter(function (l) { return l.type === 'TOTE' && num(l.qty) > 0; });
      setTimeout(function () {
        toast('Low stock in ' + loc.loc + ' (' + num(nowLoc.qty) + ' left). ' + (totes.length ? 'Open sealed tote ' + totes[0].loc + '.' : 'No sealed tote left: reorder.'), 'bad');
      }, 1800);
    }
    take = null; $('takeVehicle').value = '';
    renderTake();
    $('scanInput').focus();
  };

  /* ---------------- RESTOCK ---------------- */
  var rsMode = 'open', rs = null;
  qsa('#restockSeg button').forEach(function (b) {
    b.onclick = function () {
      rsMode = b.dataset.rs; qsa('#restockSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('restockHint').textContent = rsMode === 'open' ? 'Scan the clear top tote. Its stock moves into the blue picking bin.' : 'Count the parts, put them in the tote, tape it shut, then scan the tote label and enter the count.';
      rs = null; renderRestock();
    };
  });
  function scanRestock(code) {
    var r = resolve(code), loc = r && r.loc;
    if (r && r.sku) loc = (BY[r.sku] || []).filter(function (l) { return l.type === 'TOTE' && (rsMode === 'seal' || num(l.qty) > 0); })[0];
    if (!loc || loc.type !== 'TOTE') { beep(false); toast(r ? 'No sealed tote found for that. Scan the tote label (T-…).' : 'Not found: ' + code, 'bad'); return; }
    if (!P[loc.sku]) { beep(false); toast(loc.loc + ' has no part assigned. Set it up in Setup.', 'bad'); return; }
    beep(true); rs = { loc: loc.loc };
    $('rsQty').value = rsMode === 'open' ? Math.max(1, num(loc.qty)) : Math.max(1, num(loc.qty));
    renderRestock();
  }
  function renderRestock() {
    var loc = rs && L[rs.loc], part = loc && P[loc.sku];
    $('restockCard').classList.toggle('hidden', !part); $('restockForm').classList.toggle('hidden', !part);
    if (!part) return;
    $('restockCard').innerHTML = partCard(part, loc);
    var bins = (BY[part.sku] || []).filter(function (l) { return l.type === 'BIN'; });
    $('rsDestRow').style.display = rsMode === 'open' ? '' : 'none';
    $('rsDest').innerHTML = bins.map(function (b) { return '<option value="' + esc(b.loc) + '">' + esc(b.loc) + ' (now ' + num(b.qty) + ')</option>'; }).join('') || '<option value="">No picking bin for this part</option>';
    $('rsQtyLbl').textContent = rsMode === 'open' ? 'Quantity to move into the bin' : 'Counted quantity sealed in the tote';
    $('rsGo').textContent = rsMode === 'open' ? 'Break seal and move to bin' : 'Seal tote';
  }
  $('rsGo').onclick = function () {
    var loc = rs && L[rs.loc]; if (!loc) return;
    var part = P[loc.sku], qty = Math.round(num($('rsQty').value));
    if (qty < 1) return toast('Quantity must be 1 or more', 'bad');
    if (!signedIn()) return showSignIn();
    var p;
    if (rsMode === 'open') {
      var dest = $('rsDest').value; if (!dest) return toast('Add a picking bin for this part first (Setup).', 'bad');
      p = { id: uid(), type: 'RESTOCK', loc: loc.loc, to_loc: dest, sku: loc.sku, qty: qty, device: cfg.device };
      enqueue('move', p, '⇪ ' + qty + ' ' + part.name + ' tote → bin');
      toast('Moved ' + qty + ' into ' + dest + '. Write OPENED on the tote.', 'good');
    } else {
      p = { id: uid(), type: 'SEAL', loc: loc.loc, sku: loc.sku, qty: qty, device: cfg.device };
      enqueue('move', p, '▣ Sealed ' + qty + ' ' + part.name);
      toast('Tote ' + loc.loc + ' sealed with ' + qty + '. Print a seal label in Labels.', 'good');
    }
    rs = null; renderRestock();
  };

  /* ---------------- STOCK ---------------- */
  var stockModel = '';
  function partRows() {
    return snap.parts.map(function (p) {
      var locs = BY[p.sku] || [], bins = locs.filter(function (l) { return l.type === 'BIN'; }), totes = locs.filter(function (l) { return l.type === 'TOTE'; });
      var binQty = bins.reduce(function (a, l) { return a + num(l.qty); }, 0), toteQty = totes.reduce(function (a, l) { return a + num(l.qty); }, 0);
      var min = bins.reduce(function (a, l) { return a + num(l.min); }, 0), pr = price(p);
      return { p: p, bins: bins, totes: totes, binQty: binQty, toteQty: toteQty, min: min, low: bins.length > 0 && min > 0 && binQty <= min,
        value: pr == null ? null : pr * (binQty + toteQty) };
    });
  }
  function renderStock() {
    $('modelChips').innerHTML = [''].concat(Object.keys(MODELS)).map(function (k) {
      return '<button class="chip' + (stockModel === k ? ' on' : '') + '" data-m="' + k + '">' + (k ? '<i class="sw-' + k + '"></i>' + k : 'All') + '</button>';
    }).join('');
    qsa('#modelChips .chip').forEach(function (c) { c.onclick = function () { stockModel = c.dataset.m; renderStock(); }; });
    var q = $('stockSearch').value.trim().toLowerCase(), low = $('lowOnly').checked, stocked = $('stockedOnly').checked;
    var rows = partRows().filter(function (r) {
      if (stockModel && r.p.model !== stockModel) return false;
      if (low && !r.low) return false;
      if (stocked && !r.bins.length && !r.totes.length) return false;
      if (q) {
        var hay = (r.p.sku + ' ' + r.p.name + ' ' + r.p.ns_sku + ' ' + r.p.tier_code + ' ' + (r.p.notes || '') + ' ' + r.bins.concat(r.totes).map(function (l) { return l.loc; }).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    rows.sort(function (a, b) { return (b.low - a.low) || a.p.sku.localeCompare(b.p.sku); });
    var tb = rows.reduce(function (a, r) { return a + r.binQty; }, 0), tt = rows.reduce(function (a, r) { return a + r.toteQty; }, 0);
    var tv = rows.reduce(function (a, r) { return a + (r.value || 0); }, 0);
    var noPrice = rows.filter(function (r) { return r.value == null && r.binQty + r.toteQty > 0; }).length;
    $('stockSummary').innerHTML =
      '<div class="fact"><small>Parts shown</small><b>' + rows.length + '</b></div>' +
      '<div class="fact"><small>Units in picking bins</small><b>' + tb.toLocaleString() + '</b></div>' +
      '<div class="fact"><small>Units in sealed totes</small><b>' + tt.toLocaleString() + '</b></div>' +
      '<div class="fact' + (rows.some(function (r) { return r.low; }) ? ' low' : '') + '"><small>Low stock</small><b>' + rows.filter(function (r) { return r.low; }).length + '</b></div>' +
      '<div class="fact"><small>Stock value' + (noPrice ? ' (' + noPrice + ' parts have no price)' : '') + '</small><b>' + money(tv) + '</b><small>' + money(tv * AED_PER_EUR, 'AED') + '</small></div>';
    var show = rows.slice(0, 400);
    $('stockTable').innerHTML = '<thead><tr><th></th><th>SKU</th><th>Part</th><th>Bin</th><th class="n">In bin</th><th class="n">Min</th><th class="n">Totes</th><th class="n">Total</th><th class="n">Value €</th></tr></thead><tbody>' +
      show.map(function (r) {
        return '<tr class="' + (r.low ? 'low' : '') + '" data-sku="' + esc(r.p.sku) + '"><td><span class="swatch sw-' + esc(r.p.model) + '" style="height:18px;display:block"></span></td>' +
          '<td class="mono">' + esc(r.p.sku) + '</td><td>' + esc(r.p.name) + (r.low ? ' <span class="pill err">LOW</span>' : '') + '</td>' +
          '<td class="mono">' + esc(r.bins.map(function (l) { return l.loc; }).join(', ') || '—') + '</td>' +
          '<td class="n bin">' + r.binQty + '</td><td class="n">' + r.min + '</td><td class="n">' + r.toteQty + '</td><td class="n">' + (r.binQty + r.toteQty) + '</td><td class="n">' + (r.value == null ? '<span class="hint">—</span>' : r.value.toFixed(2)) + '</td></tr>';
      }).join('') + '</tbody>' + (rows.length > show.length ? '<tfoot><tr><td colspan="9" class="hint">Showing 400 of ' + rows.length + '. Search to narrow down.</td></tr></tfoot>' : '');
    qsa('#stockTable tbody tr').forEach(function (tr) { tr.onclick = function () { partDetail(tr.dataset.sku); }; });
  }
  ['stockSearch'].forEach(function (id) { $(id).addEventListener('input', renderStock); });
  ['lowOnly', 'stockedOnly'].forEach(function (id) { $(id).addEventListener('change', renderStock); });

  function partDetail(sku) {
    var p = P[sku]; if (!p) return;
    var locs = (BY[sku] || []);
    var units = locs.reduce(function (a, l) { return a + num(l.qty); }, 0), pr = price(p);
    var info = '<div class="facts">' +
      '<div class="fact"><small>Unit price</small><b style="font-size:16px">' + money(pr) + '</b></div>' +
      '<div class="fact"><small>Stock value</small><b style="font-size:16px">' + money(pr == null ? null : pr * units) + '</b></div>' +
      (num(p.weight_g) > 0 ? '<div class="fact"><small>Weight / piece</small><b style="font-size:16px">' + esc(p.weight_g) + ' g</b></div>' : '') + '</div>' +
      (p.notes ? '<p class="hint">' + esc(p.notes) + '</p>' : '');
    modal(partCard(p, null, { extra: info +
      '<h4 style="margin:14px 0 6px">Locations</h4>' + (locs.length ? locs.map(function (l) {
        return '<div class="item" style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #eee"><b class="mono" style="flex:1">' + esc(l.loc) + '</b><span>' + (l.type === 'TOTE' ? 'Tote' : 'Bin') + '</span><b>' + num(l.qty) + '</b><span class="hint">' + (l.type === 'BIN' ? 'min ' + num(l.min) : esc(l.sealed_date)) + ' · counted ' + esc(l.last_count || 'never') + '</span></div>';
      }).join('') : '<p class="hint">No bin yet. Add one in Setup.</p>') +
      '<h4 style="margin:14px 0 6px">Recent movements</h4><div id="histBox" class="hint">Loading…</div>' }) +
      '<div class="btns"><button class="big" data-x="close">Close</button></div>');
    api('history', { sku: sku, limit: 30 }).then(function (r) {
      var box = $('histBox'); if (!box) return;
      box.innerHTML = r.rows.length ? r.rows.map(function (m) {
        return '<div style="padding:4px 0;border-bottom:1px solid #f0f0f0"><b>' + esc(m.type) + ' ' + esc(m.qty) + '</b> · ' + esc(String(m.ts).replace('T', ' ').slice(0, 16)) + ' · ' + esc(m.from_loc || '') + (m.to_loc ? ' → ' + esc(m.to_loc) : '') + (m.mechanic ? ' · ' + esc(m.mechanic) : '') + (m.vehicle ? ' · ' + esc(m.vehicle) : '') + (m.note ? ' · ' + esc(m.note) : '') + '</div>';
      }).join('') : 'No movements yet.';
    }).catch(function (e) { var box = $('histBox'); if (box) box.textContent = 'Could not load history: ' + e.message; });
  }

  /* ---------------- COUNT (blind) ---------------- */
  var dayPicked = null;
  $('schedDay').onchange = function () { dayPicked = num(this.value); renderCount(); };
  function shelfOf(loc) { return loc.split('-').slice(0, 2).join('-'); }

  /** Locations to count for a weekday (1=Mon … 5=Fri; 0 = overdue). */
  function schedule(day) {
    var bins = snap.locations.filter(function (l) { return l.type === 'BIN' && P[l.sku]; });
    var withPart = function (fn) { return bins.filter(function (l) { return fn(P[l.sku]); }); };
    if (day === 1) return { title: 'OK4 (OKAI 400C) A-items', list: withPart(function (p) { return p.abc === 'A' && (p.model === 'OK4' || p.model === 'UNI'); }) };
    if (day === 2) return { title: 'NB3 (Ninebot C1 A300) A-items', list: withPart(function (p) { return p.abc === 'A' && p.model === 'NB3'; }) };
    if (day === 3) return { title: 'NB2 (Ninebot A200) A-items', list: withPart(function (p) { return p.abc === 'A' && p.model === 'NB2'; }) };
    if (day === 4 || day === 5) {
      var pool = withPart(day === 4 ? function (p) { return p.abc === 'B'; } : function (p) { return p.abc === 'C' && p.system === 'FST'; });
      var shelves = {};
      pool.forEach(function (l) { (shelves[shelfOf(l.loc)] = shelves[shelfOf(l.loc)] || []).push(l); });
      var keys = Object.keys(shelves);
      if (!keys.length) return { title: day === 4 ? 'B-items' : 'C-items (fasteners)', list: [] };
      var startedToday = keys.filter(function (k) { return shelves[k].some(function (l) { return l.last_count === today(); }) && shelves[k].some(function (l) { return l.last_count !== today(); }); })[0];
      var oldest = function (k) { return shelves[k].reduce(function (a, l) { var d = l.last_count || '0000'; return d < a ? d : a; }, '9999'); };
      keys.sort(function (a, b) { return oldest(a).localeCompare(oldest(b)) || a.localeCompare(b); });
      var pick = startedToday || keys[0];
      return { title: (day === 4 ? 'B-items' : 'C-items (fasteners)') + ' · shelf ' + pick, list: shelves[pick] };
    }
    return { title: 'Overdue counts', list: bins.filter(function (l) { return daysSince(l.last_count) > (COUNT_EVERY[P[l.sku].abc] || 31); }) };
  }

  function renderCount() {
    var wd = new Date().getDay();
    var day = dayPicked != null ? dayPicked : (wd >= 1 && wd <= 5 ? wd : 0);
    $('schedDay').value = String(day);
    var s = schedule(day), done = s.list.filter(function (l) { return l.last_count === today(); }).length;
    $('schedTitle').textContent = (dayPicked == null && day === wd ? "Today's count: " : '') + s.title;
    $('schedHint').textContent = s.list.length ? done + ' of ' + s.list.length + ' bins counted today. You will not see the system number while counting.' : 'Nothing to count in this group yet (no bins set up for it).';
    s.list.sort(function (a, b) { return (a.last_count === today()) - (b.last_count === today()) || a.loc.localeCompare(b.loc); });
    $('schedList').innerHTML = s.list.map(function (l) {
      var p = P[l.sku], did = l.last_count === today();
      return '<div class="item"><span class="swatch sw-' + esc(p.model) + '"></span><div class="grow"><div class="t1"><span class="mono">' + esc(l.loc) + '</span> · ' + esc(p.name) + '</div><div class="t2">' + esc(p.sku) + ' · last counted ' + esc(l.last_count || 'never') + '</div></div>' +
        (did ? '<span class="pill done">Counted ✓</span>' : '<button data-count="' + esc(l.loc) + '">Count</button>') + '</div>';
    }).join('');
    qsa('[data-count]').forEach(function (b) { b.onclick = function () { countLoc(b.dataset.count); }; });

    var rv = snap.counts || [];
    $('reviewN').textContent = rv.length;
    $('reviewList').innerHTML = rv.length ? rv.map(function (c) {
      var p = P[c.sku] || { name: c.sku, model: 'UNI' }, flag = c.counted === '' || c.counted == null;
      return '<div class="item"><span class="swatch sw-' + esc(p.model) + '"></span><div class="grow"><div class="t1"><span class="mono">' + esc(c.loc) + '</span> · ' + esc(p.name) + '</div>' +
        '<div class="t2">' + (flag ? esc(c.counter) + '. Count the bin and enter the real number.' : 'System ' + esc(c.expected) + ' · counted ' + esc(c.counted) + ' · difference <b>' + (num(c.variance) > 0 ? '+' : '') + esc(c.variance) + '</b> · by ' + esc(c.counter) + ' · ' + esc(String(c.ts).slice(0, 10))) + '</div></div>' +
        (isSup() ? '<button class="ok" data-acc="' + esc(c.id) + '">' + (flag ? 'Enter count' : 'Accept') + '</button><button class="no" data-rej="' + esc(c.id) + '">Recount</button>' : '<span class="pill wait">Supervisor</span>') + '</div>';
    }).join('') + (isSup() ? '' : '<p class="hint">A supervisor accepts or rejects these.</p>') : '<p class="hint">No differences waiting.</p>';
    qsa('[data-acc]').forEach(function (b) { b.onclick = function () { resolveCount(b.dataset.acc, true); }; });
    qsa('[data-rej]').forEach(function (b) { b.onclick = function () { resolveCount(b.dataset.rej, false); }; });
  }

  function resolveCount(id, accept) {
    var c = (snap.counts || []).filter(function (x) { return String(x.id) === String(id); })[0]; if (!c) return;
    var flag = c.counted === '' || c.counted == null;
    var go = function (counted) {
      api('resolveCount', { id: id, accept: accept, counted: counted, device: cfg.device })
        .then(function () { toast(accept ? 'Stock corrected for ' + c.loc : c.loc + ' sent back for recount', 'good'); return refresh(); })
        .catch(function (e) { toast(e.message, 'bad'); });
    };
    if (accept && flag) {
      modal('<h3>Real count for ' + esc(c.loc) + '</h3><input id="flagN" type="number" inputmode="numeric" class="countBig"><div class="btns"><button class="big" data-x="no">Cancel</button><button class="big ok" data-x="stay" id="flagGo">Set stock</button></div>');
      $('flagGo').onclick = function () { var v = $('flagN').value; if (v === '') return; closeModal(); go(num(v)); };
      return;
    }
    if (!accept) {
      // a rejected difference leaves stock as it is; ask for a fresh count of that bin
      go(); setTimeout(function () { countLoc(c.loc); }, 300); return;
    }
    go();
  }

  function scanCount(code) {
    var r = resolve(code), loc = r && r.loc;
    if (r && r.sku) loc = (BY[r.sku] || []).filter(function (l) { return l.type === 'BIN'; })[0];
    if (!loc) { beep(false); toast('Not found: ' + code, 'bad'); return; }
    beep(true); countLoc(loc.loc);
  }

  function countLoc(locId, attempt) {
    var loc = L[locId], part = loc && P[loc.sku]; if (!part) return;
    attempt = attempt || 1;
    var byWeight = part.abc === 'C' && num(part.weight_g) > 0;
    modal(partCard(part, loc, { blind: true }) +
      (attempt > 1 ? '<p style="color:var(--bad);font-weight:700">That does not match the system. Please empty the bin and count again carefully.</p>' : '') +
      '<label class="lbl">How many are in ' + esc(loc.loc) + '?' + (part.abc === 'C' ? ' (use the counting scale)' : '') + '</label>' +
      '<input id="cntN" type="number" inputmode="numeric" class="countBig" min="0">' +
      (byWeight ? '<label class="tog" style="margin-top:8px"><input type="checkbox" id="cntG"> Enter grams from the scale (' + esc(part.weight_g) + ' g per piece)</label>' +
        '<p class="hint" id="cntGHint" style="display:none">Put the parts on the scale without the bin (or tare the empty bin first).</p>' : '') +
      '<div class="btns"><button class="big" data-x="cancel">Cancel</button><button class="big ok" data-x="stay" id="cntGo">Submit count</button></div>');
    var grams = function () { return byWeight && $('cntG').checked; };
    if (byWeight) {
      $('cntG').onchange = function () {
        $('cntN').value = ''; $('cntN').placeholder = grams() ? 'grams' : '';
        $('cntGHint').style.display = grams() ? '' : 'none'; $('cntGHint').textContent = 'Put the parts on the scale without the bin (or tare the empty bin first).';
        $('cntN').focus();
      };
      $('cntN').addEventListener('input', function () {
        if (!grams()) return;
        var n = piecesFromGrams_(this.value, part.weight_g);
        $('cntGHint').textContent = this.value === '' ? '' : this.value + ' g ÷ ' + part.weight_g + ' g = ' + n + ' pieces';
      });
    }
    var send = function () {
      var v = $('cntN').value; if (v === '') return toast(grams() ? 'Enter the grams from the scale' : 'Enter the number you counted', 'bad');
      if (grams()) v = piecesFromGrams_(v, part.weight_g);
      $('cntGo').disabled = true;
      api('count', { id: uid(), loc: loc.loc, counted: num(v), attempt: attempt }).then(function (r) {
        if (r.recount) { beep(false); countLoc(locId, 2); return; }
        closeModal();
        if (r.match) { beep(true); toast(loc.loc + ' matches ✓', 'good'); }
        else { beep(false); toast(loc.loc + ' saved. Difference sent to the supervisor.', 'bad'); }
        loc.last_count = today();
        refresh();
      }).catch(function (e) { $('cntGo').disabled = false; toast(e.business ? e.message : 'Counting needs a connection. Try again.', 'bad'); });
    };
    $('cntGo').onclick = send;
    $('cntN').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  }

  /* ---------------- LABELS ---------------- */
  var lbMode = 'BIN', lbSel = {};
  var LAYOUTS = { '3x8': [3, 8, 70, 37], '3x7': [3, 7, 70, 42.3], '2x7': [2, 7, 99.1, 38.1], '2x4': [2, 4, 99.1, 67.7] };
  qsa('#labelSeg button').forEach(function (b) {
    b.onclick = function () { lbMode = b.dataset.lb; lbSel = {}; qsa('#labelSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); $('labelLayout').style.display = lbMode === 'BIN' ? '' : 'none'; renderLabels(); };
  });
  $('labelSearch').addEventListener('input', renderLabels);
  $('labelAll').onchange = function () { var on = this.checked; labelPool().forEach(function (l) { lbSel[l.loc] = on; }); renderLabels(); };
  function labelPool() {
    var q = $('labelSearch').value.trim().toLowerCase();
    return snap.locations.filter(function (l) {
      if (l.type !== lbMode || !P[l.sku]) return false;
      if (!q) return true;
      var p = P[l.sku];
      return (l.loc + ' ' + p.sku + ' ' + p.name + ' ' + p.model).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return a.loc.localeCompare(b.loc, undefined, { numeric: true }); });
  }
  function renderLabels() {
    var pool = labelPool();
    var n = Object.keys(lbSel).filter(function (k) { return lbSel[k]; }).length;
    $('labelList').innerHTML = pool.length ? pool.map(function (l) {
      var p = P[l.sku];
      return '<label class="item"><input type="checkbox" style="width:auto" data-lb="' + esc(l.loc) + '"' + (lbSel[l.loc] ? ' checked' : '') + '><span class="swatch sw-' + esc(p.model) + '" style="height:22px"></span><div class="grow"><div class="t1"><span class="mono">' + esc(l.loc) + '</span> · ' + esc(p.name) + '</div><div class="t2">' + esc(p.sku) + (l.type === 'TOTE' ? ' · qty ' + num(l.qty) + ' · sealed ' + esc(l.sealed_date || '-') : '') + '</div></div></label>';
    }).join('') : '<p class="hint">No ' + (lbMode === 'BIN' ? 'bins' : 'totes') + ' set up yet. Add them in Setup.</p>';
    qsa('[data-lb]', $('labelList')).forEach(function (c) { c.onchange = function () { lbSel[c.dataset.lb] = c.checked; $('labelPrint').textContent = 'Print selected labels (' + Object.keys(lbSel).filter(function (k) { return lbSel[k]; }).length + ')'; }; });
    $('labelPrint').textContent = 'Print selected labels (' + n + ')';
  }
  function qrSvg(text) {
    if (!window.qrcode) return '';
    var q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  }
  $('labelPrint').onclick = function () {
    var chosen = snap.locations.filter(function (l) { return lbSel[l.loc] && l.type === lbMode && P[l.sku]; })
      .sort(function (a, b) { return a.loc.localeCompare(b.loc, undefined, { numeric: true }); });
    if (!chosen.length) return toast('Tick the labels to print first', 'bad');
    loadScript(QR_LIB).catch(function () { toast('QR code library could not load. Labels will print without QR codes.', 'bad'); }).then(function () {
      var html = '';
      if (lbMode === 'BIN') {
        var L4 = LAYOUTS[$('labelLayout').value], cols = L4[0], rows = L4[1], w = L4[2], h = L4[3], per = cols * rows;
        var padT = Math.max(0, (297 - rows * h) / 2), padL = Math.max(0, (210 - cols * w) / 2);
        for (var i = 0; i < chosen.length; i += per) {
          html += '<div class="page" style="padding:' + padT + 'mm ' + padL + 'mm;grid-template-columns:repeat(' + cols + ',' + w + 'mm);grid-template-rows:repeat(' + rows + ',' + h + 'mm)">';
          chosen.slice(i, i + per).forEach(function (l) {
            var p = P[l.sku], m = MODELS[p.model];
            html += '<div class="lab c-' + p.model + '"><div class="lh"><span>' + esc(m.name) + '</span><span>' + esc(p.system) + ' · ' + esc(p.abc) + '</span></div>' +
              '<div class="lb"><div class="lq">' + qrSvg(l.loc) + '</div><div class="lt"><div class="lsku">' + esc(p.sku) + '</div><div class="lname">' + esc(p.name) + '</div><div class="lloc">' + esc(l.loc) + '</div></div></div></div>';
          });
          html += '</div>';
        }
      } else {
        for (var j = 0; j < chosen.length; j += 2) {
          html += '<div class="page" style="grid-template-rows:148.5mm 148.5mm">';
          chosen.slice(j, j + 2).forEach(function (l) {
            var p = P[l.sku], m = MODELS[p.model];
            html += '<div class="lab tote c-' + p.model + '"><div class="lh"><span>SEALED BULK · ' + esc(m.name) + '</span><span>' + esc(l.loc) + '</span></div>' +
              '<div class="lb"><div class="lq">' + qrSvg(l.loc) + '</div><div class="lt"><div><div class="lname">' + esc(p.name) + '</div><div class="lsku">' + esc(p.sku) + '</div></div>' +
              '<div><div class="tmeta">EXACT QUANTITY</div><div class="tq">' + num(l.qty) + '</div><div class="tmeta">Sealed ' + esc(l.sealed_date || today()) + (l.notes ? ' · ' + esc(l.notes) : '') + '</div></div>' +
              '<div class="sealbox">Seal broken on ____/____/______ by __________</div></div></div></div>';
          });
          html += '</div>';
        }
      }
      $('printArea').innerHTML = html;
      setTimeout(function () { window.print(); }, 150);
    });
  };

  /* ---------------- SETUP ---------------- */
  function renderSetup() {
    var m = mode();
    $('connFields').style.display = EMBED ? 'none' : '';
    $('cfgSave').style.display = EMBED ? 'none' : '';
    $('demoPanel').style.display = m === 'DEMO' ? '' : 'none';
    $('connHint').textContent = m === 'EMBED' ? 'Opened from the Apps Script link. Connected to the Google Sheet.' :
      m === 'LIVE' ? 'Connected to the Google Sheet. Every device using this URL sees the same stock.' :
      'Not connected: demo mode. Paste the web app URL from the Apps Script setup to go live.';
    if (document.activeElement !== $('cfgUrl')) $('cfgUrl').value = cfg.url || '';
    $('meInfo').textContent = signedIn() ? cfg.user + ' · ' + (ROLES[cfg.role] || 'Mechanic') + (cfg.user === ADMIN_NAME ? ' (admin PIN: use it to create the first supervisor)' : '') : 'Not signed in';
    var staff = snap.staff || [];
    $('staffList').innerHTML = staff.length ? staff.map(function (x) {
      var me = x.name === cfg.user;
      return '<div class="item staffrow' + (x.active ? '' : ' off') + '"><div class="grow"><div class="t1">' + esc(x.name) + (me ? ' (you)' : '') + '</div>' +
        '<div class="t2"><b>' + esc(ROLES[x.role] || x.role) + '</b>' + (x.active ? '' : ' · disabled') + (x.has_pin ? '' : ' · no PIN yet') + '</div></div>' +
        '<button data-pin="' + esc(x.name) + '">Reset PIN</button>' +
        (me ? '' : '<button data-role="' + esc(x.name) + '">' + (x.role === 'supervisor' ? 'Make mechanic' : 'Make supervisor') + '</button>' +
        '<button class="' + (x.active ? 'no' : 'ok') + '" data-onoff="' + esc(x.name) + '">' + (x.active ? 'Disable' : 'Enable') + '</button>') + '</div>';
    }).join('') : '<p class="hint">No staff yet. Add the 5 people above, each with their own PIN.</p>';
    qsa('[data-pin]', $('staffList')).forEach(function (b) { b.onclick = function () { resetPin(b.dataset.pin); }; });
    qsa('[data-role]', $('staffList')).forEach(function (b) {
      b.onclick = function () { var x = staffBy(b.dataset.role); setStaff({ name: x.name, role: x.role === 'supervisor' ? 'mechanic' : 'supervisor' }, x.name + ' is now a ' + (x.role === 'supervisor' ? 'mechanic' : 'supervisor')); };
    });
    qsa('[data-onoff]', $('staffList')).forEach(function (b) {
      b.onclick = function () { var x = staffBy(b.dataset.onoff); setStaff({ name: x.name, active: !x.active }, x.name + (x.active ? ' disabled' : ' enabled')); };
    });
  }
  function staffBy(name) { return (snap.staff || []).filter(function (x) { return x.name === name; })[0]; }
  function setStaff(p, okMsg) {
    return api('setStaff', p).then(function () { toast(okMsg, 'good'); return refresh(); }).catch(function (e) { toast(e.message, 'bad'); throw e; });
  }
  function resetPin(name) {
    modal('<h3>New PIN for ' + esc(name) + '</h3><p class="hint">4 to 8 digits. Tell ' + esc(name) + ' the new PIN. The old one stops working.</p>' +
      '<input id="newPin" type="password" inputmode="numeric" maxlength="8" class="countBig" autocomplete="new-password">' +
      '<div class="btns"><button class="big" data-x="cancel">Cancel</button><button class="big ok" data-x="stay" id="newPinGo">Save PIN</button></div>');
    $('newPinGo').onclick = function () {
      var v = $('newPin').value.trim(); if (!pinOk_(v)) return toast('PIN must be 4 to 8 digits', 'bad');
      closeModal();
      var mine = name === cfg.user;
      api('setStaff', { name: name, new_pin: v }).then(function () {
        if (mine) { cfg.pin = v; save('inv.cfg', cfg); }
        toast('PIN changed for ' + name, 'good'); return refresh();
      }).catch(function (e) { toast(e.message, 'bad'); });
    };
  }
  function saveUrl(url) {
    url = String(url || '').trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(url)) { toast('The URL should start with https://script.google.com/ and end with /exec', 'bad'); return false; }
    if (url !== (cfg.url || '')) { cfg.user = ''; cfg.pin = ''; cfg.role = ''; }   // another stock sheet has its own staff
    cfg.url = url; save('inv.cfg', cfg);
    snap = { parts: [], locations: [], staff: [], counts: [], version: -1 }; index();
    return true;
  }
  $('cfgSave').onclick = function () {
    var was = cfg.url || '';
    if (!saveUrl($('cfgUrl').value)) return;
    if ((cfg.url || '') !== was || !signedIn()) { showSignIn(mode() === 'DEMO' ? 'Demo mode. Sign in.' : 'Connected. Sign in with your name and PIN.'); return; }
    toast('Connecting…'); refresh().then(function () { if (online) toast('Connected ✓', 'good'); });
  };
  $('signOut').onclick = function () {
    var w = queue.filter(function (q) { return q.status === 'wait' && q.by === cfg.user; }).length;
    cfg.user = ''; cfg.pin = ''; cfg.role = ''; save('inv.cfg', cfg);
    showSignIn(w ? 'Signed out. ' + w + ' of your actions are still waiting to send and will be sent under your name.' : 'Signed out.');
  };
  $('locSku').addEventListener('input', function () { var p = P[this.value.trim().toUpperCase()]; $('locSkuName').textContent = p ? p.name + ' (' + MODELS[p.model].name + ')' : ''; });
  $('locSave').onclick = function () {
    var p = { loc: $('locId').value.trim().toUpperCase(), sku: $('locSku').value.trim().toUpperCase(), min: num($('locMin').value), qty: num($('locQty').value), device: cfg.device };
    api('saveLocation', p).then(function () { toast('Saved ' + p.loc, 'good'); $('locId').value = ''; $('locQty').value = 0; return refresh(); }).catch(function (e) { toast(e.message, 'bad'); });
  };
  $('bulkGo').onclick = function () {
    var rows = $('bulkText').value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      var c = s.split(/[,;\t]/).map(function (x) { return x.trim(); });
      return { loc: (c[0] || '').toUpperCase(), sku: (c[1] || '').toUpperCase(), qty: num(c[2]), min: c[3] === undefined ? (/^T/i.test(c[0]) ? 0 : 2) : num(c[3]) };
    });
    if (!rows.length) return;
    var out = $('bulkOut'), done = [], i = 0;
    $('bulkGo').disabled = true;
    var next = function () {
      if (i >= rows.length) {
        $('bulkGo').disabled = false;
        var ok = done.filter(function (r) { return r.ok; }).length, bad = done.filter(function (r) { return r.error; });
        out.innerHTML = ok + ' loaded, ' + done.filter(function (r) { return r.skipped; }).length + ' skipped (already exist), ' + bad.length + ' with problems' +
          (bad.length ? ':<br>' + bad.map(function (r) { return esc(r.loc) + ': ' + esc(r.error); }).join('<br>') : '.');
        return refresh();
      }
      var chunk = rows.slice(i, i + 40); i += 40;
      out.textContent = 'Loading ' + Math.min(i, rows.length) + ' of ' + rows.length + '…';
      api('saveLocations', { rows: chunk, device: cfg.device }).then(function (r) { done = done.concat(r.results); next(); })
        .catch(function (e) { $('bulkGo').disabled = false; out.textContent = 'Stopped: ' + e.message; });
    };
    next();
  };
  $('staffAdd').onclick = function () {
    var n = $('staffName').value.trim(), pin = $('staffPin').value.trim(), role = $('staffRole').value;
    if (!n) return toast('Enter a name', 'bad');
    if (!pinOk_(pin)) return toast('PIN must be 4 to 8 digits', 'bad');
    api('addStaff', { name: n, role: role, new_pin: pin }).then(function () {
      $('staffName').value = ''; $('staffPin').value = ''; toast('Added ' + n + ' (' + ROLES[role] + ')', 'good'); return refresh();
    }).catch(function (e) { toast(e.message, 'bad'); });
  };
  $('partSave').onclick = function () {
    var p = { sku: $('partSku').value.trim().toUpperCase(), name: $('partName').value.trim(), abc: $('partAbc').value, ns_sku: $('partNs').value.trim(),
      price_eur: $('partPrice').value.trim(), weight_g: $('partWeight').value.trim() };
    if (!p.name) return toast('Enter the part name', 'bad');
    api('savePart', p).then(function () { toast('Saved ' + p.sku, 'good'); return refresh(); }).catch(function (e) { toast(e.message, 'bad'); });
  };
  $('demoReset').onclick = function () { localStorage.removeItem('inv.demo'); demo = null; queue = []; saveQueue(); refresh(); toast('Demo data reset', 'good'); };

  /* ---------------- sign-in ---------------- */
  function showSignIn(msg) {
    $('signin').classList.remove('hidden');
    $('siMsg').textContent = msg || '';
    $('siMsg').className = 'hint' + (/^(Signed out|Demo|Connected)/.test(msg || '') ? ' info' : '');
    $('siPin').value = '';
    $('siConn').style.display = EMBED ? 'none' : '';
    $('siUrl').value = cfg.url || '';
    var m = mode();
    $('siConnHint').textContent = m === 'DEMO' ? 'Demo mode (sample data on this device). Demo PINs: Mechanic A 1111, Mechanic B 2222, Supervisor 9999, Admin 1234.' : 'Connected to ' + (m === 'EMBED' ? 'the Apps Script link.' : cfg.url);
    if (m === 'DEMO') $('siConn').open = true;
    setStatus();
    var sel = $('siName');
    sel.innerHTML = '<option value="">Loading names…</option>';
    api('staffNames', {}, { user: '', pin: '' }).then(function (r) {
      var names = (r.names || []).concat([ADMIN_NAME]);
      sel.innerHTML = '<option value="">Choose your name…</option>' + names.map(function (n) {
        return '<option value="' + esc(n) + '">' + esc(n === ADMIN_NAME ? 'Admin (first setup)' : n) + '</option>';
      }).join('');
      if (cfg.lastUser && names.indexOf(cfg.lastUser) >= 0) sel.value = cfg.lastUser;
    }).catch(function (e) {
      sel.innerHTML = '<option value="' + ADMIN_NAME + '">Admin (first setup)</option>';
      $('siMsg').className = 'hint'; $('siMsg').textContent = 'Cannot reach the stock sheet: ' + e.message + '. Check the connection below.';
      $('siConn').open = true;
    });
  }
  function doSignIn() {
    var user = $('siName').value, pin = $('siPin').value.trim();
    if (!user) return toast('Choose your name', 'bad');
    if (!pin) return toast('Type your PIN', 'bad');
    $('siGo').disabled = true; $('siMsg').textContent = '';
    api('whoami', {}, { user: user, pin: pin }).then(function (r) {
      cfg.user = r.name; cfg.pin = pin; cfg.role = r.role; cfg.lastUser = r.name; save('inv.cfg', cfg);
      $('signin').classList.add('hidden'); $('siPin').value = '';
      toast('Signed in as ' + r.name + ' (' + ROLES[r.role] + ')', 'good');
      snap.version = -1;
      return refresh().then(flush);
    }).catch(function (e) {
      $('siMsg').className = 'hint'; $('siMsg').textContent = e.message; beep(false);
    }).then(function () { $('siGo').disabled = false; });
  }
  $('siGo').onclick = doSignIn;
  $('siPin').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSignIn(); });
  $('siUrlSave').onclick = function () { if (saveUrl($('siUrl').value)) showSignIn(mode() === 'DEMO' ? 'Demo mode. Sign in.' : 'Connected. Sign in with your name and PIN.'); };
  $('meBtn').onclick = function () { if (!signedIn()) showSignIn(); else showTab('setup'); };

  /* ---------------- start ---------------- */
  var handlers = { scanInput: scanTake, restockInput: scanRestock, countInput: scanCount };
  onEnter('scanInput', scanTake); onEnter('restockInput', scanRestock); onEnter('countInput', scanCount);
  $('takeVehicle').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.value = vehicleFrom(this.value); $('takeGo').focus(); } });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  window.addEventListener('online', function () { online = true; flush(); });
  setInterval(poll, 8000);
  setInterval(flush, 15000);
  if (!EMBED && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});

  setStatus();
  // Setup link: <app link>#connect=<Apps Script /exec URL> connects this device in one tap.
  // The /exec URL stays out of the public code; share the setup link only with your team.
  var hc = /^#connect=(.+)$/.exec(location.hash || '');
  if (hc && !EMBED) {
    history.replaceState(null, '', location.pathname + location.search);
    var want = decodeURIComponent(hc[1]).trim();
    if (want !== (cfg.url || '') && saveUrl(want)) { showSignIn('Connected. Sign in with your name and PIN.'); flush(); return; }
  }
  if (signedIn()) refresh().then(flush); else { showSignIn(); flush(); }
})();
