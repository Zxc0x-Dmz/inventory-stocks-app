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
  var APP_VERSION = '2.13 (2026-11-25)';   // shown on the sign-in and Setup screens
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
  // device storage; if the browser blocks it (private mode, embedded pages) keep things in memory for this session
  var memStore = {};
  function load(k, d) {
    try { var v = JSON.parse(localStorage.getItem(k)); if (v != null) return v; } catch (e) {}
    return memStore[k] != null ? JSON.parse(memStore[k]) : d;
  }
  function save(k, v) { var s = JSON.stringify(v); memStore[k] = s; try { localStorage.setItem(k, s); } catch (e) {} }
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
  // PREVIEW_ONLY: the one-file preview page (tools/build_preview.py) always runs on sample data
  function mode() { return EMBED ? 'EMBED' : window.PREVIEW_ONLY ? 'DEMO' : cfg.url ? 'LIVE' : 'DEMO'; }

  /* demo storage: same interface as the Google Sheet store in Code.gs */
  function DemoStore() {
    this.d = load('inv.demo', null);
    // sample parts changed in a new app version: start the demo again with the new ones
    if (!this.d || this.d.sig !== demoSig()) { this.d = demoData(); this.persist(); }
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

  function demoSig() { return (window.DEMO_PARTS || []).map(function (p) { return p.sku + ':' + (p.ns_sku || ''); }).join('|').length + '-' + (window.DEMO_PARTS || []).length + '-' + ((window.DEMO_PARTS || [])[0] || {}).ns_sku; }
  function demoData() {
    var t = { Parts: [], Locations: [], Movements: [], Counts: [], Staff: DEMO_STAFF.map(function (r) { return Object.assign({}, r); }) };
    var rack = { OK4: 1, NB3: 2, NB2: 3, UNI: 4 }, perRack = {}, tote = 1, stamp = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
    (window.DEMO_PARTS || []).forEach(function (p, i) {
      t.Parts.push({ sku: p.sku, name: p.name, model: p.model, system: p.system, abc: p.abc, ns_sku: p.ns_sku, tier_code: p.tier_code, fits: p.fits, unit: 'pcs', notes: p.notes || '',
        price_eur: p.price_eur == null ? '' : String(p.price_eur), weight_g: p.weight_g == null ? '' : String(p.weight_g), photo_id: p.photo_id || '', hs_code: p.hs_code || '' });
      var loc = 'R' + ('0' + (1 + Math.floor(i / 6) % 15)).slice(-2) + '-S' + (1 + (i % 6 < 3 ? 0 : 1)) + '-B' + ('0' + ((i % 3) + 1)).slice(-2);
      var qty = p.abc === 'C' ? 40 + (i * 37) % 160 : (i * 7) % 18;
      t.Locations.push({ loc: loc, type: 'BIN', sku: p.sku, qty: String(qty), min: String(p.abc === 'C' ? 30 : p.abc === 'A' ? 2 : 4), sealed_date: '', last_count: stamp, notes: '' });
      if (p.abc === 'A') {
        t.Locations.push({ loc: 'T-' + ('000' + tote++).slice(-4), type: 'TOTE', sku: p.sku, qty: '20', min: '0', sealed_date: stamp, last_count: stamp, notes: 'Top of ' + loc.slice(0, 3) });
      }
    });
    return { t: t, v: 1, sig: demoSig() };
  }

  var demo = null;
  function demoCore() { if (!demo) demo = new Core(new DemoStore()); return demo; }

  function sha256Hex(text) {
    try {
      if (window.crypto && crypto.subtle && window.TextEncoder) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        }, function () { return sha256Js(text); });
      }
    } catch (e) {}
    return Promise.resolve(sha256Js(text));   // pages where the browser's crypto is blocked
  }
  /** Plain-JS SHA-256 (UTF-8), same result as crypto.subtle; only used when that is not available. */
  function sha256Js(text) {
    var K = [], H = [], i, j;
    var isP = function (n) { for (var f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
    var frac = function (x) { return ((x - Math.floor(x)) * 4294967296) | 0; };
    for (i = 2, j = 0; j < 64; i++) if (isP(i)) { if (j < 8) H[j] = frac(Math.pow(i, 1 / 2)); K[j++] = frac(Math.pow(i, 1 / 3)); }
    var s = unescape(encodeURIComponent(text)), bytes = [];
    for (i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    var bitLen = bytes.length * 8;
    bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
    for (i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bitLen >>> (i * 8)) & 255);
    var rot = function (x, n) { return (x >>> n) | (x << (32 - n)); }, W = [];
    for (var o = 0; o < bytes.length; o += 64) {
      for (i = 0; i < 16; i++) W[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
      for (i = 16; i < 64; i++) {
        var s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }  function bizError(msg, extra, code) { var e = new Error(msg); e.extra = extra; e.business = true; e.code = code || (extra && extra.code); return e; }

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
    if (op === 'setPhoto') return steps.then(function () {
      var part = core.findPart_(String(p.sku || '').toUpperCase()); if (!part) throw bizError('Unknown part ' + p.sku);
      var id = String(part.photo_id || part.ns_sku || part.sku).replace(/_v[0-9a-z]+$/, '') + '_v' + Date.now().toString(36);
      window.DEMO_PHOTOS = window.DEMO_PHOTOS || {}; window.DEMO_PHOTOS[id] = p.data;
      core.s.update('Parts', part, { photo_id: id }); core.s.bump();
      return { ok: true, id: id };
    });
    if (op === 'savePhotos') return steps.then(function () {
      if (!who || who.role !== 'supervisor') throw bizError('Only a supervisor can do this', null, 'ROLE');
      window.DEMO_PHOTOS = window.DEMO_PHOTOS || {};
      (p.items || []).forEach(function (it) { window.DEMO_PHOTOS[it.id] = it.data; });   // demo: kept until the page reloads
      return { ok: true, saved: (p.items || []).length, skipped: 0 };
    });
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
  var P = {}, L = {}, BY = {}, LK = {}, BOXES = {};   // L: box -> first row · LK: box|sku -> row · BOXES: box -> rows (a box can hold several parts)
  var online = true;

  function index() {
    P = {}; L = {}; BY = {}; LK = {}; BOXES = {};
    snap.parts.forEach(function (p) { P[p.sku] = p; });
    snap.locations.forEach(function (l) {
      var k = normLoc_(l.loc);
      if (!L[k] || (!L[k].sku && l.sku)) { L[k] = l; L[String(l.loc).toUpperCase()] = l; }
      LK[k + '|' + l.sku] = l; (BOXES[k] = BOXES[k] || []).push(l);
      if (l.sku) (BY[l.sku] = BY[l.sku] || []).push(l);
    });
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
      syncPhotos();
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

  /** The row of part `sku` in box `loc` (or the box's first row when no part is given). */
  function lk(loc, sku) { var k = normLoc_(loc); return sku ? LK[k + '|' + sku] || null : L[k] || null; }
  /** Parts in a box (rows that hold a known part). */
  function inBox(loc) { return (BOXES[normLoc_(loc)] || []).filter(function (l) { return P[l.sku]; }); }

  /** Local effect of a movement so the screen updates instantly. */
  function effect(p, sign) {
    var src = lk(p.loc, p.sku), dst = p.to_loc && lk(p.to_loc, p.sku), q = num(p.qty) * sign;
    if (!src) return;
    if (p.type === 'OUT' || p.type === 'SCRAP') src.qty = String(num(src.qty) - q);
    else if (p.type === 'RETURN' || p.type === 'RECEIVE') src.qty = String(num(src.qty) + q);
    else if (p.type === 'SEAL') { if (sign > 0) { p._was = src.qty; src.qty = String(p.qty); src.sealed_date = today(); } }
    else if (dst) { src.qty = String(num(src.qty) - q); dst.qty = String(num(dst.qty) + q); }
  }
  var EFFECT_OPS = { move: 1, putAway: 1, moveStock: 1 };
  function applyPending() {
    index();
    queue.forEach(function (q) { if (q.status === 'wait' && EFFECT_OPS[q.op]) effect(q.p, 1); });
  }

  function enqueue(op, p, label) {
    // the item keeps the sign-in of the person who did it, so it is logged under them even if
    // someone else signs in on this device before it is sent
    var item = { id: p.id, op: op, p: p, label: label, status: 'wait', ts: new Date().toISOString(), by: cfg.user, auth: { user: cfg.user, pin: cfg.pin } };
    queue.push(item); saveQueue();
    if (EFFECT_OPS[op]) effect(p, 1);
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
      var a = r.loc && lk(r.loc.loc, r.loc.sku || next.p.sku), b = r.to && lk(r.to.loc, r.to.sku || next.p.sku);
      if (a) a.qty = String(r.loc.qty);
      if (b) b.qty = String(r.to.qty);
      if (r.version) snap.version = r.version;
      flushing = false; renderAll(); flush();
      if (next.op === 'putAway' || next.op === 'moveStock' || r.released) refresh();   // a box was set up, or let go of a part
    }).catch(function (e) {
      flushing = false;
      if (!e.business) { online = false; setStatus(); setTimeout(flush, 8000); return; }
      // rejected by the rules: undo the local effect and tell the user
      if (EFFECT_OPS[next.op]) { if (next.p.type === 'SEAL' && next.p._was != null && lk(next.p.loc, next.p.sku)) lk(next.p.loc, next.p.sku).qty = next.p._was; else effect(next.p, -1); }
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
    var tl = $('tabs').querySelector('[data-tab="take"] b'), sl = $('tabs').querySelector('[data-tab="setup"] b');
    tl.textContent = 'Parts'; sl.textContent = isSup() ? 'Setup' : 'Settings';
    if (!tabAllowed(current)) showTab('take');
  }

  /* ---------------- tabs ---------------- */
  var current = 'take';
  /** Mechanics get Parts and Settings. */
  function tabAllowed(t) { return isSup() || t === 'take' || t === 'setup'; }
  var tabTrail = [];   // tabs visited before this one, for the phone's Back button
  function showTab(t, fromBack) {
    if (!tabAllowed(t)) t = 'take';
    if (!fromBack && t !== current && current) { tabTrail.push(current); if (tabTrail.length > 20) tabTrail.shift(); }
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
    if (L[up] || L[normLoc_(s)]) { var box = L[up] || L[normLoc_(s)]; return { loc: box, box: box.loc, rows: inBox(box.loc) }; }
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
        var target = tabAllowed(current) ? { take: 'scanInput', restock: 'restockInput', count: 'countInput' }[current] : null;
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
    else if ($(camTarget)) { $(camTarget).value = camTarget === 'vehInput' ? vehicleFrom(text) : String(text).trim().toUpperCase(); }
  }

  /* ---------------- modal ---------------- */
  var modalCb = null;
  function modal(html, cb) {
    $('modalBody').innerHTML = html; modalCb = cb || null;
    $('modal').classList.remove('hidden');
    var f = $('modalBody').querySelector('input'); if (f) setTimeout(function () { f.focus(); }, 60);
    setTimeout(fillPhotos, 0);
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
  var photoRunning = 0, photoWaiting = [];
  function limitPhoto(fn) {
    return new Promise(function (ok, bad) {
      var go = function () { photoRunning++; fn().then(ok, bad).then(function () { photoRunning--; var n = photoWaiting.shift(); if (n) n(); }); };
      if (photoRunning < 4) go(); else photoWaiting.push(go);
    });
  }
  var photoScrollT = 0;
  window.addEventListener('scroll', function () { clearTimeout(photoScrollT); photoScrollT = setTimeout(fillPhotos, 150); }, { passive: true });
  /** Data URL of a part photo, or null.  A missing photo is remembered until the app is reopened. */
  function getPhoto(id) {
    if (!id) return Promise.resolve(null);
    if (photoMem[id] !== undefined) return Promise.resolve(photoMem[id]);
    if (photoBusy[id]) return photoBusy[id];
    return (photoBusy[id] = cacheGet(id).then(function (hit) {
      if (hit) return hit;
      if (photoSyncRun) return photoSyncRun.then(function () { return photoMem[id] !== undefined ? photoMem[id] : one(); });   // the background sync brings it
      return one();
    }).then(function (d) { photoMem[id] = d; delete photoBusy[id]; return d; },
      function () { delete photoBusy[id]; return null; }));   // offline: try again later
    function one() {
      return limitPhoto(function () { return api('photo', { id: id }); }).then(function (r) { if (r.data) cachePut(id, r.data); return r.data || null; });
    }
  }
  /** Fills every photo placeholder on screen. */
  function fillPhotos() {
    var hmax = window.innerHeight * 1.6;
    qsa('[data-photo]').forEach(function (el) {
      if (el.dataset.state) return;
      if (el.offsetParent === null || el.getBoundingClientRect().top > hmax) return;   // not on screen yet
      el.dataset.state = 'loading';
      getPhoto(el.dataset.photo).then(function (d) {
        if (d) { el.style.backgroundImage = 'url("' + d + '")'; el.dataset.state = 'ok'; el.innerHTML = ''; el.onclick = function (e) { e.stopPropagation(); bigPhoto(d); }; }
        else el.dataset.state = 'none';
      });
    });
  }
  /* Background photo sync: after sign-in this device downloads every photo it does not have yet (or that changed),
   * up to 40 per request, and keeps them in Cache Storage.  So photos show at once, also offline.
   * inv.photoVer = {photo id: 'updated' value of the copy saved here}. */
  var photoSyncBusy = false, photoSyncAt = 0, photoSyncRun = null;
  function syncPhotos(force) {
    if (photoSyncBusy || !signedIn() || mode() === 'DEMO') return;
    if (!force && Date.now() - photoSyncAt < 10 * 60000) return;    // at most every 10 minutes
    photoSyncBusy = true; photoSyncAt = Date.now();
    var ver = load('inv.photoVer', {}), used = {};
    (snap.parts || []).forEach(function (p) { if (p.photo_id) used[p.photo_id] = 1; });
    photoSyncRun = api('photoList').then(function (r) {
      var need = (r.list || []).filter(function (x) { return used[x[0]] && ver[x[0]] !== x[1]; });
      var done = 0, step = function () {
        if (done >= need.length) return;
        var batch = [], first = need[done][2];
        while (done < need.length && batch.length < 40 && need[done][2] - first <= 150) { batch.push(need[done]); done++; }
        return api('photos', { rows: batch.map(function (x) { return x[2]; }) }).then(function (b) {
          (b.items || []).forEach(function (it) {
            cachePut(it.id, it.data); ver[it.id] = it.updated;
            var old = photoMem[it.id]; photoMem[it.id] = it.data; delete photoBusy[it.id];
            qsa('[data-photo="' + it.id + '"]').forEach(function (el) { if (old !== it.data) delete el.dataset.state; });
          });
          save('inv.photoVer', ver); fillPhotos();
          return step();
        });
      };
      return step();
    }).catch(function () { photoSyncAt = 0; })   // offline or old backend: try again next time
      .then(function () { photoSyncBusy = false; photoSyncRun = null; });
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
      facts += '<div class="fact"><small>' + (loc.type === 'TOTE' ? 'White box' : 'Blue bin') + '</small><b class="mono">' + esc(loc.loc) + '</b></div>';
      if (!opts.blind) facts += '<div class="fact' + (low ? ' low' : '') + '"><small>' + (loc.type === 'TOTE' ? 'In tote' : 'In bin') + '</small><b>' + num(loc.qty) + '</b></div>';
      if (!opts.blind && loc.type === 'BIN') facts += '<div class="fact"><small>Min</small><b>' + num(loc.min) + '</b></div>';
      if (loc.type === 'TOTE' && loc.sealed_date) facts += '<div class="fact"><small>Sealed</small><b style="font-size:15px">' + esc(loc.sealed_date) + '</b></div>';
    }
    if (!opts.blind && loc && loc.type === 'BIN') facts += '<div class="fact"><small>In white boxes</small><b>' + toteQty + '</b></div>';
    return '<div class="card m-' + esc(part.model) + '"><div class="band"><span>' + esc(m.name) + '</span><span>' + esc(SYSTEMS[part.system] || part.system) + ' · ' + esc(part.abc) + '</span></div>' +
      '<div class="body">' + photoBox(part) + '<div class="name">' + esc(part.name) + '</div><div class="sku">SKU ' + esc(codeOf(part)) + '</div>' +
      '<div class="facts">' + facts + '</div>' + (opts.extra || '') + '</div></div>';
  }

  /* ---------------- PARTS (catalogue look: model cards, photo grid, part page) ----------------
   * Everything starts from finding the part: type a SKU / NetSuite no. / name, tap a card, or scan a label.
   * The part page has two big actions, TAKE OUT and ADD STOCK; Return, Damaged and Move are under More. */
  var MODEL_CARDS = [
    { k: 'OK4', t: 'ES400C', s: 'OKAI · Scooter' }, { k: 'NB3', t: 'C1', s: 'Ninebot · Scooter' },
    { k: 'NB2', t: 'A200', s: 'Ninebot · Bike' }, { k: 'UNI', t: 'Universal', s: 'Fits several' }
  ];
  var MODEL_TAG = { OK4: 'ES400C', NB3: 'C1', NB2: 'A200', UNI: 'Universal' };
  var gridModel = '', gridLimit = 48, sel = null;   // sel = {sku, box, mode, kind}
  /** Two kinds of container: blue picking bins on the racks (R1-S1-B02) and white storage boxes (T-0001). */
  var KIND = { BIN: { name: 'Blue bin', cls: 'kb', eg: 'C1-B001', re: /^((A200|C1|OK|UNI)-B\d{3,}|R\d+-S\d+-B\d+(-[A-Z])?)$/ },
               TOTE: { name: 'White box', cls: 'kw', eg: 'C1-T001', re: /^((A200|C1|OK|UNI)-T\d{3,}|T-?\d+)$/ } };
  function kindOf(loc) { return isTote_(loc) ? 'TOTE' : 'BIN'; }
  var CODE_MODEL = { NB2: 'A200', NB3: 'C1', OK4: 'OK', UNI: 'UNI' };   // first part of a box code
  function kindTag(k) { return '<span class="ktag ' + KIND[k].cls + '"><i></i>' + KIND[k].name + '</span>'; }

  function stockOf(sku) {
    var locs = (BY[sku] || []).slice().sort(function (a, b) { return num(b.qty) - num(a.qty); });
    var total = locs.reduce(function (a, l) { return a + num(l.qty); }, 0);
    var bins = locs.filter(function (l) { return l.type === 'BIN'; });
    var min = bins.reduce(function (a, l) { return a + num(l.min); }, 0);
    return { locs: locs, total: total, low: locs.length > 0 && total <= reorderLevel_(P[sku]) };
  }
  function codeOf(p) { return p.ns_sku || (/Catalogue code (\S+)/.exec(p.notes || '') || [])[1] || p.sku; }
  function matchParts(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return snap.parts.slice();
    var words = q.split(/\s+/);
    return snap.parts.filter(function (p) {
      var hay = (p.sku + ' ' + p.name + ' ' + (p.ns_sku || '') + ' ' + (p.notes || '') + ' ' + (p.tier_code || '') + ' ' + MODEL_TAG[p.model] + ' ' +
        (BY[p.sku] || []).map(function (l) { return l.loc; }).join(' ')).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }

  /* ---------------- TO ORDER ----------------
   * A part is on the list when it has been put in a box before and its stock (all boxes together) is at or below
   * its order level.  Banner on the Parts screen, a reminder once a day, and a list you can copy into WhatsApp or an email. */
  function toOrder() {
    return snap.parts.filter(function (p) { return stockOf(p.sku).low; }).map(function (p) {
      return { p: p, total: stockOf(p.sku).total, level: reorderLevel_(p) };
    }).sort(function (a, b) { return (a.total > 0) - (b.total > 0) || a.p.model.localeCompare(b.p.model) || a.p.name.localeCompare(b.p.name); });
  }
  function renderOrderBanner() {
    var list = toOrder(), out = list.filter(function (r) { return r.total <= 0; }).length;
    $('orderBanner').innerHTML = list.length ? '<button type="button" class="orderbar" id="orderOpen"><b>⚠ ' + list.length + ' part' + (list.length > 1 ? 's' : '') + ' to order</b>' +
      (out ? '<span>' + out + ' out of stock</span>' : '<span>running low</span>') + '<i>View list ›</i></button>' : '';
    if ($('orderOpen')) $('orderOpen').onclick = openOrderList;
    if (list.length && load('inv.orderNag', '') !== today() && signedIn()) {
      save('inv.orderNag', today());
      setTimeout(function () { toast(list.length + ' part' + (list.length > 1 ? 's' : '') + ' to order. See the list on the Parts screen.', 'bad'); }, 1200);
    }
  }
  function orderText(list) {
    return 'Parts to order (' + today() + ')\n' + list.map(function (r) {
      return '- ' + codeOf(r.p) + ' ' + r.p.name + ' [' + (MODEL_TAG[r.p.model] || r.p.model) + '] · ' + (r.total <= 0 ? 'OUT' : r.total + ' left') + ' (order at ' + r.level + ')';
    }).join('\n');
  }
  function openOrderList() {
    var list = toOrder();
    modal('<h3 class="formtitle">Parts to order (' + list.length + ')</h3>' +
      '<p class="hint">Stock at or below the order level, counted over all bins and boxes. Out of stock first.</p>' +
      '<div class="ordlist">' + list.map(function (r) {
        return '<button type="button" class="ordrow" data-sku="' + esc(r.p.sku) + '"><span class="pc-ph' + (r.p.photo_id ? '" data-photo="' + esc(r.p.photo_id) + '"' : ' none"') + '></span>' +
          '<span class="ot"><b>' + esc(r.p.name) + '</b><small class="mono">' + esc(codeOf(r.p)) + ' · ' + esc(MODEL_TAG[r.p.model] || r.p.model) + '</small></span>' +
          '<span class="oq' + (r.total <= 0 ? ' out' : '') + '">' + (r.total <= 0 ? 'OUT' : r.total + ' left') + '<small>order at ' + r.level + '</small></span></button>';
      }).join('') + '</div>' +
      '<div class="btns"><button type="button" class="big" data-x="close">Close</button><button type="button" class="big ok" data-x="stay" id="orderCopy">Copy list</button></div>');
    qsa('#modalBody .ordrow').forEach(function (b) { b.onclick = function () { closeModal(); openPart(b.dataset.sku); }; });
    $('orderCopy').onclick = function () {
      var t = orderText(list);
      (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('List copied. Paste it in WhatsApp or an email.', 'good'); },
        function () { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('List copied', 'good'); } catch (e) {} ta.remove(); });
    };
    setTimeout(fillPhotos, 0);
  }
  /* ---------------- PACK A BOX ----------------
   * Several parts into one box without scanning: choose blue bin / white box and the model, the app gives the box its
   * code (or pick a box already started), then type a part, tap it, enter how many, Add, and so on.  The label is
   * printed later from the Labels tab. */
  var pack = null;   // {kind, model, loc, added: [{sku, qty}]}
  var PACK_MODELS = [['NB3', 'C1'], ['NB2', 'A200'], ['OK4', 'OKAI 400C'], ['UNI', 'Universal']];
  function packStart() {
    pack = pack && pack.loc && !pack.done ? pack : { kind: 'TOTE', model: 'NB3', loc: '', added: [] };
    if (!pack.loc) packChoose(); else packFill();
  }
  function packChoose() {
    var auto = nextCode(pack.kind, pack.model);
    var started = sharedBoxes(pack.kind, pack.model, []);
    modal('<h3 class="formtitle">📦 Pack a box</h3>' +
      '<label class="lbl">Which kind of box?</label><div class="kinds">' + ['TOTE', 'BIN'].map(function (x) {
        return '<button type="button" class="kindbtn ' + KIND[x].cls + (x === pack.kind ? ' on' : '') + '" data-pk="' + x + '"><i></i>' + KIND[x].name + '</button>';
      }).join('') + '</div>' +
      '<label class="lbl">For which vehicle?</label><div class="rsrow">' + PACK_MODELS.map(function (m) {
        return '<button type="button" class="rs' + (m[0] === pack.model ? ' on' : '') + '" data-pm="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="picks"><button type="button" class="pickbox new on" data-pl="' + esc(auto) + '"><small>New ' + KIND[pack.kind].name.toLowerCase() + '</small><b class="mono">' + esc(auto) + '</b><span>next free number</span></button>' +
      started.map(function (b) { return '<button type="button" class="pickbox shared" data-pl="' + esc(b.loc) + '"><small>Keep packing</small><b class="mono">' + esc(b.loc) + '</b><span>' + b.n + ' part' + (b.n > 1 ? 's' : '') + ' inside</span></button>'; }).join('') + '</div>' +
      '<div class="btns"><button type="button" class="big" data-x="close">Cancel</button><button type="button" class="big ok" data-x="stay" id="packGo">Start packing</button></div>');
    var chosen = auto;
    qsa('#modalBody [data-pk]').forEach(function (b) { b.onclick = function () { pack.kind = b.dataset.pk; packChoose(); }; });
    qsa('#modalBody [data-pm]').forEach(function (b) { b.onclick = function () { pack.model = b.dataset.pm; packChoose(); }; });
    qsa('#modalBody [data-pl]').forEach(function (b) { b.onclick = function () { chosen = b.dataset.pl; qsa('#modalBody [data-pl]').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    $('packGo').onclick = function () { pack.loc = chosen; pack.added = []; packFill(); };
  }
  function packFill(q) {
    var inside = inBox(pack.loc).map(function (l) { return { sku: l.sku, qty: num(l.qty) }; });
    pack.added.forEach(function (a) { if (!inside.some(function (x) { return x.sku === a.sku; })) inside.push({ sku: a.sku, qty: a.qty }); });
    modal('<h3 class="formtitle">📦 Packing <span class="mono">' + esc(pack.loc) + '</span></h3><p class="hint">' + KIND[kindOf(pack.loc)].name + ' · ' + (inside.length ? inside.length + ' part' + (inside.length > 1 ? 's' : '') + ' in it' : 'empty so far') + '</p>' +
      (inside.length ? '<div class="packlist">' + inside.map(function (x) { var pt = P[x.sku] || { name: x.sku }; return '<div><b>' + x.qty + '</b> × ' + esc(pt.name) + '</div>'; }).join('') + '</div>' : '') +
      '<label class="lbl" for="packQ">Add a part: type its name or SKU</label><input id="packQ" type="search" autocomplete="off" placeholder="e.g. brake lever" value="' + esc(q || '') + '">' +
      '<div id="packHits" class="ordlist"></div>' +
      '<div class="btns"><button type="button" class="big" data-x="stay" id="packOther">Other box</button><button type="button" class="big ok" data-x="stay" id="packDone">Done</button></div>');
    var model = (/^(A200|C1|OK|UNI)-/.exec(pack.loc) || [])[1], mkey = { A200: 'NB2', C1: 'NB3', OK: 'OK4', UNI: 'UNI' }[model];
    var showHits = function () {
      var v = $('packQ').value.trim();
      if (!v) { $('packHits').innerHTML = ''; return; }
      var hits = matchParts(v).sort(function (a, b) { return (b.model === mkey) - (a.model === mkey); }).slice(0, 8);
      $('packHits').innerHTML = hits.length ? hits.map(function (pt) {
        return '<div class="packhit" data-sku="' + esc(pt.sku) + '"><button type="button" class="ordrow" data-pick="1"><span class="pc-ph' + (pt.photo_id ? '" data-photo="' + esc(pt.photo_id) + '"' : ' none"') + '></span>' +
          '<span class="ot"><b>' + esc(pt.name) + '</b><small class="mono">' + esc(codeOf(pt)) + ' · ' + esc(MODEL_TAG[pt.model] || pt.model) + '</small></span></button></div>';
      }).join('') : '<p class="hint">No part found. Try another word.</p>';
      qsa('#packHits [data-pick]').forEach(function (b) {
        b.onclick = function () {
          var box = b.parentNode, sku = box.dataset.sku;
          qsa('#packHits .packqty').forEach(function (x) { x.remove(); });
          var row = document.createElement('div'); row.className = 'packqty';
          row.innerHTML = '<div class="stepper sm"><button type="button" data-step="-1">−</button><input type="number" inputmode="numeric" min="1" value="1"><button type="button" data-step="1">+</button></div><button type="button" class="big ok">Add to ' + esc(pack.loc) + '</button>';
          box.appendChild(row); row.querySelector('input').select();
          row.querySelector('.big').onclick = function () {
            var qty = Math.round(num(row.querySelector('input').value)), pt = P[sku];
            if (qty < 1) return toast('Enter how many', 'bad');
            if (!signedIn()) return showSignIn();
            enqueue('putAway', { id: uid(), type: 'RECEIVE', sku: sku, loc: pack.loc, qty: qty, device: cfg.device }, '+' + qty + ' ' + pt.name + ' → ' + pack.loc);
            var a = pack.added.filter(function (x) { return x.sku === sku; })[0]; if (a) a.qty += qty; else pack.added.push({ sku: sku, qty: qty });
            toast('Added ' + qty + ' × ' + pt.name + ' to ' + pack.loc, 'good');
            packFill(); setTimeout(function () { if ($('packQ')) $('packQ').focus(); }, 60);
          };
        };
      });
      setTimeout(fillPhotos, 0);
    };
    $('packQ').addEventListener('input', showHits); showHits();
    $('packOther').onclick = function () { pack.loc = ''; packChoose(); };
    $('packDone').onclick = function () {
      var n = pack.added.length, loc = pack.loc; pack = null; closeModal(); renderAll();
      toast(n ? loc + ' packed (' + n + ' part' + (n > 1 ? 's' : '') + '). Its label is waiting in Labels.' : 'Nothing added to ' + loc, n ? 'good' : 'bad');
    };
  }
  $('packOpen').onclick = function () { if (!signedIn()) return showSignIn(); packStart(); };

  /** Boxes whose label is not printed yet (new boxes, or mixed boxes whose contents changed). */
  function needLabel() {
    return Object.keys(BOXES).filter(function (k) { var rows = inBox(k); return rows.length && rows.some(function (r) { return !r.label_printed; }); });
  }
  function renderLabelBanner() {
    var n = isSup() ? needLabel().length : 0;
    $('labelBanner').innerHTML = n ? '<button type="button" class="orderbar labelbar" id="labelOpen"><b>🏷 ' + n + ' box' + (n > 1 ? 'es' : '') + ' with no printed label yet</b><span>print from the Labels tab</span><i>Labels ›</i></button>' : '';
    if ($('labelOpen')) $('labelOpen').onclick = function () {
      var bins = needLabel().filter(function (k) { return kindOf(k) === 'BIN'; }).length;
      lbMode = bins ? 'BIN' : 'TOTE'; lbSel = {}; $('labelNew').checked = true;
      qsa('#labelSeg button').forEach(function (x) { x.classList.toggle('on', x.dataset.lb === lbMode); });
      $('labelLayout').style.display = lbMode === 'BIN' ? '' : 'none';
      showTab('labels');
    };
  }
  function renderTake() {
    renderOrderBanner();
    renderLabelBanner();
    var q = $('scanInput').value.trim(), onlyStock = $('inStockOnly').checked;
    $('modelCards').innerHTML = MODEL_CARDS.map(function (m) {
      var parts = snap.parts.filter(function (p) { return p.model === m.k; });
      var inStock = parts.filter(function (p) { return stockOf(p.sku).total > 0; }).length;
      return '<button type="button" class="mcard m-' + m.k + (gridModel === m.k ? ' on' : '') + '" data-model="' + m.k + '"><span class="mband"></span><span class="mt">' + m.t + '</span>' +
        '<span class="ms">' + m.s + '</span><span class="mc">' + parts.length + ' parts · ' + inStock + ' in stock</span></button>';
    }).join('');
    qsa('#modelCards [data-model]').forEach(function (b) { b.onclick = function () { gridModel = gridModel === b.dataset.model ? '' : b.dataset.model; gridLimit = 48; renderTake(); }; });

    var up = q.toUpperCase();
    var list = matchParts(q).filter(function (p) { return (!gridModel || p.model === gridModel) && (!onlyStock || stockOf(p.sku).total > 0); });
    list.sort(function (a, b) {
      var ea = a.sku === up || a.ns_sku === q, eb = b.sku === up || b.ns_sku === q;
      return (eb - ea) || (stockOf(b.sku).total > 0) - (stockOf(a.sku).total > 0) || a.name.localeCompare(b.name);
    });
    var m = MODEL_CARDS.filter(function (x) { return x.k === gridModel; })[0];
    $('gridTitle').textContent = (m ? m.t + ' parts' : 'All parts') + (q ? ' matching "' + q + '"' : '');
    $('gridCount').textContent = list.length;
    $('partGrid').innerHTML = list.length ? list.slice(0, gridLimit).map(function (p) {
      var st = stockOf(p.sku);
      return '<button type="button" class="pc" data-sku="' + esc(p.sku) + '">' +
        (p.photo_id ? '<span class="pc-ph" data-photo="' + esc(p.photo_id) + '"><i>No photo yet</i></span>' : '<span class="pc-ph none"><i>No photo yet</i></span>') +
        '<span class="pc-b"><span class="pc-code">' + esc(codeOf(p)) + '</span><span class="pc-n">' + esc(p.name) + '</span>' +
        '<span class="pc-m"><i class="dot sw-' + esc(p.model) + '"></i>' + esc(MODEL_TAG[p.model] || p.model) + '</span>' +
        '<span class="pc-pw">' + [price(p) == null ? '' : '€ ' + price(p).toFixed(2), num(p.weight_g) > 0 ? esc(p.weight_g) + ' g' : ''].filter(Boolean).join(' · ') + '</span>' +
        '<span class="pc-s' + (st.total > 0 ? (st.low ? ' low' : ' ok') : '') + '">' + (st.total > 0 ? '<b>' + st.total + '</b> in ' + esc(st.locs.length === 1 ? st.locs[0].loc : st.locs.length + ' boxes') : 'Not in stock') + '</span></span></button>';
    }).join('') : '<p class="hint">No parts found. Check the SKU, or try part of the name.</p>';
    $('gridMore').classList.toggle('hidden', list.length <= gridLimit);
    $('gridMore').textContent = 'Show more (' + (list.length - gridLimit) + ' more)';
    qsa('#partGrid .pc').forEach(function (b) { b.onclick = function () { openPart(b.dataset.sku); }; });
    setTimeout(fillPhotos, 0);   // photos of the cards just drawn (also after a model tap or a search)
    renderRecent();
  }
  $('scanInput').addEventListener('input', function () { gridLimit = 48; renderTake(); });
  $('inStockOnly').addEventListener('change', function () { gridLimit = 48; renderTake(); });
  $('gridMore').onclick = function () { gridLimit += 48; renderTake(); };

  function renderRecent() {
    var mine = queue.slice(-25).reverse();
    $('todayN').textContent = mine.length || '';
    $('recent').innerHTML = mine.length ? mine.map(function (q) {
      var st = { wait: ['wait', 'Waiting'], sent: ['sent', 'Saved'], err: ['err', 'Failed'], held: ['wait', 'Check'] }[q.status] || ['', q.status];
      var sku = q.p.sku || (L[q.p.loc] || {}).sku;
      return '<div class="item"><span class="swatch sw-' + esc((P[sku] || {}).model || 'UNI') + '"></span><div class="grow"><div class="t1">' + esc(q.label) + '</div>' +
        '<div class="t2">' + esc(q.ts.slice(11, 16)) + ' · ' + esc(q.p.loc || '') + (q.p.to_loc ? ' → ' + esc(q.p.to_loc) : '') + (q.p.vehicle ? ' · ' + esc(q.p.vehicle) : '') + (q.by ? ' · ' + esc(q.by) : '') + (q.err ? ' · ' + esc(q.err) : '') + '</div></div>' +
        '<span class="pill ' + st[0] + '">' + st[1] + '</span></div>';
    }).join('') : '<p class="hint">Nothing yet today.</p>';
  }

  /** A box with one part: go straight on.  A box with several parts: show what is inside and let the user tap one. */
  function chooseInBox(box, cb, filter) {
    var rows = inBox(box).filter(filter || function () { return true; });
    if (!rows.length) return toast('Nothing usable in ' + box, 'bad');
    if (rows.length === 1) return cb(rows[0]);
    modal('<h3 class="formtitle">' + esc(normLoc_(box)) + ' · ' + KIND[kindOf(box)].name + '</h3><p class="hint">' + rows.length + ' parts in this box. Tap one.</p>' +
      '<div class="ordlist">' + rows.map(function (l, i) {
        var pt = P[l.sku];
        return '<button type="button" class="ordrow" data-i="' + i + '"><span class="pc-ph' + (pt.photo_id ? '" data-photo="' + esc(pt.photo_id) + '"' : ' none"') + '></span>' +
          '<span class="ot"><b>' + esc(pt.name) + '</b><small class="mono">' + esc(codeOf(pt)) + ' · ' + esc(MODEL_TAG[pt.model] || pt.model) + '</small></span>' +
          '<span class="oq">' + num(l.qty) + '<small>pcs</small></span></button>';
      }).join('') + '</div><div class="btns"><button type="button" class="big" data-x="close">Close</button></div>');
    qsa('#modalBody .ordrow').forEach(function (b) { b.onclick = function () { closeModal(); cb(rows[num(b.dataset.i)]); }; });
    setTimeout(fillPhotos, 0);
  }
  /** Scan / Enter in the search box: a box label or exact SKU opens the part; otherwise the grid shows matches. */
  function scanTake(code) {
    var r = resolve(code);
    if (r && r.loc) {
      if (!r.rows.length) { beep(false); return toast(r.box + ' is an empty box. Open a part and use Add stock.', 'bad'); }
      beep(true); $('scanInput').value = '';
      return chooseInBox(r.box, function (l) { openPart(l.sku, l.loc); });
    }
    if (r && r.sku) { beep(true); $('scanInput').value = ''; return openPart(r.sku); }
    var hits = matchParts(code);
    if (hits.length === 1) { beep(true); $('scanInput').value = ''; return openPart(hits[0].sku); }
    $('scanInput').value = code; showTab('take');
    if (!hits.length) { beep(false); toast('Not found: ' + code, 'bad'); }
  }

  /* --- part page --- */
  function openPart(sku, box) {
    var st = stockOf(sku);
    sel = { sku: sku, box: box || (st.locs.filter(function (l) { return num(l.qty) > 0; })[0] || st.locs[0] || {}).loc || '', mode: null };
    renderPart();
  }
  function boxChips(st, pick) {
    var list = pick ? st.locs.filter(pick) : st.locs;
    if (!list.length) return '<p class="hint">No box with this part yet.</p>';
    return '<div class="boxes">' + list.map(function (l) {
      return '<button type="button" class="boxchip' + (l.loc === sel.box ? ' on' : '') + '" data-box="' + esc(l.loc) + '">' + kindTag(kindOf(l.loc)) + '<b class="mono">' + esc(l.loc) + '</b><span>' + num(l.qty) + ' pcs</span></button>';
    }).join('') + '</div>';
  }
  function qtyField(v) {
    return '<label class="lbl">How many?</label><div class="stepper"><button type="button" data-step="-1">−</button><input id="fQty" type="number" inputmode="numeric" min="1" value="' + (v || 1) + '"><button type="button" data-step="1">+</button></div>';
  }
  /* Where to put a part: the app makes the label code, so nobody has to think one up.
   * The code says which vehicle it is for and counts up per model: C1-B001, C1-B002 ... (blue bins), C1-T001 ... (white boxes);
   * A200-..., OK-... (OKAI 400C) and UNI-... (shared parts) the same.  Labels are printed later from the Labels tab. */
  function nextCode(kind, model) {
    var pre = (CODE_MODEL[model] || 'UNI') + '-' + (kind === 'TOTE' ? 'T' : 'B'), max = 0, free = null;
    snap.locations.forEach(function (l) {
      var id = normLoc_(l.loc); if (id.indexOf(pre) !== 0) return;
      var n = Number(id.slice(pre.length)); if (!(n > 0)) return;
      max = Math.max(max, n);
      if (!free && !l.sku && num(l.qty) === 0 && !inBox(id).length) free = id;   // a box that has a code but no part in it
    });
    queue.forEach(function (q) { var to = q.p && normLoc_(q.p.loc || q.p.to || ''); if (to && to.indexOf(pre) === 0) max = Math.max(max, Number(to.slice(pre.length)) || 0); });   // not sent yet
    return free || normLoc_(pre + (max + 1));
  }
  /** Boxes of this kind and model that already hold other parts: a part can be put in with them (mixed box).
   *  Newest codes first, at most 6. */
  function sharedBoxes(kind, model, mine) {
    var pre = (CODE_MODEL[model] || 'UNI') + '-' + (kind === 'TOTE' ? 'T' : 'B'), have = {};
    (mine || []).forEach(function (l) { have[normLoc_(l.loc)] = 1; });
    return Object.keys(BOXES).filter(function (k) { return k.indexOf(pre) === 0 && !have[k] && inBox(k).length; })
      .sort(function (a, b) { return b.localeCompare(a, undefined, { numeric: true }); }).slice(0, 6)
      .map(function (k) { return { loc: k, n: inBox(k).length }; });
  }
  function boxInput(label, st) {
    var k = sel.kind, mine = st.locs.filter(function (l) { return kindOf(l.loc) === k; });
    var auto = nextCode(k, (P[sel.sku] || {}).model);
    if (!sel.pick || kindOf(sel.pick) !== k) sel.pick = (mine[0] || {}).loc || auto;
    var chip = function (id, top, sub, cls) {
      return '<button type="button" class="pickbox' + (cls || '') + (id === sel.pick ? ' on' : '') + '" data-pick="' + esc(id) + '"><small>' + top + '</small><b class="mono">' + esc(id) + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</button>';
    };
    var h = '<label class="lbl">' + label + '</label><div class="kinds">' + ['BIN', 'TOTE'].map(function (x) {
        return '<button type="button" class="kindbtn ' + KIND[x].cls + (x === k ? ' on' : '') + '" data-kind="' + x + '"><i></i>' + KIND[x].name + '</button>';
      }).join('') + '</div><div class="picks">';
    mine.forEach(function (l) { h += chip(l.loc, 'Same ' + KIND[k].name.toLowerCase(), num(l.qty) + ' pcs already' + (inBox(l.loc).length > 1 ? ' · ' + inBox(l.loc).length + ' parts inside' : '')); });
    sharedBoxes(k, (P[sel.sku] || {}).model, mine).forEach(function (b) { h += chip(b.loc, 'Shared ' + KIND[k].name.toLowerCase(), b.n + ' part' + (b.n > 1 ? 's' : '') + ' inside', ' shared'); });
    if (mine.every(function (l) { return l.loc !== auto; })) h += chip(auto, mine.length ? 'Or a new one' : 'New ' + KIND[k].name.toLowerCase(), 'next free number', ' new');
    h += '</div>';
    h += '<details class="more typebox"><summary>Or scan / type a label</summary><div class="scanrow"><input id="boxInput" class="scan" placeholder="e.g. ' + KIND[k].eg + '" value="' + esc(sel.pick) + '" autocomplete="off" autocapitalize="characters"><button type="button" class="cam" data-cam="boxInput" title="Scan box label">📷</button></div></details>';
    return h;
  }
  function vehField(required) {
    return '<label class="lbl" for="vehInput">Scooter / bike ID' + (required ? '' : ' (optional)') + '</label><div class="scanrow"><input id="vehInput" placeholder="Scan the vehicle QR or type it" autocomplete="off" autocapitalize="characters"><button type="button" class="cam" data-cam="vehInput" title="Scan vehicle QR">📷</button></div>';
  }
  function renderPart() {
    var p = P[sel.sku]; if (!p) return;
    var st = stockOf(p.sku), mode = sel.mode, h = '';
    h += '<div class="pd"><div class="pd-top">' +
      '<div class="pd-left">' + (p.photo_id ? '<div class="pd-ph" data-photo="' + esc(p.photo_id) + '"><i>No photo yet</i></div>' : '<div class="pd-ph none"><i>No photo yet</i></div>') +
      '<div class="photobtns"><button type="button" class="photobtn" id="photoCam">📷 Take photo</button><button type="button" class="photobtn" id="photoGal">🖼 From gallery</button></div>' +
      '<input type="file" id="photoCamPick" accept="image/*" capture="environment" hidden><input type="file" id="photoPick" accept="image/*" hidden></div>' +
      '<div class="pd-info"><span class="mtag m-' + esc(p.model) + '"><i class="dot sw-' + esc(p.model) + '"></i>' + esc(MODEL_TAG[p.model] || p.model) + ' · ' + esc((MODELS[p.model] || {}).name || '') + '</span>' +
      '<h3>' + esc(p.name) + '</h3><div class="pd-sku">SKU <b class="mono">' + esc(codeOf(p)) + '</b></div>' +
      '<div class="pd-total' + (st.low ? ' low' : '') + '">' + (st.total > 0 ? '<b>' + st.total + '</b> in stock' : st.locs.length ? '<b>0</b> in stock' : 'Not in stock yet') + (st.low ? ' <span class="pill err">ORDER</span>' : '') + '</div>' +
      '<details class="ordlvl"><summary>Order when ' + reorderLevel_(p) + ' or fewer left' + (String(p.reorder_at || '') === '' ? ' (default)' : '') + ' · change</summary>' +
      '<div class="stepper sm"><button type="button" data-step="-1">−</button><input id="ordLevel" type="number" inputmode="numeric" min="0" value="' + reorderLevel_(p) + '"><button type="button" data-step="1">+</button></div>' +
      '<button type="button" class="photobtn" id="ordSave">Save order level</button></details></div></div>' +
      '<div class="pd-facts"><div><small>Price</small><b>' + (price(p) == null ? '—' : '€ ' + price(p).toFixed(2)) + '</b>' + (price(p) == null ? '' : '<small>AED ' + (price(p) * AED_PER_EUR).toFixed(2) + '</small>') + '</div>' +
      '<div><small>Weight</small><b>' + (num(p.weight_g) > 0 ? esc(p.weight_g) + ' g' : '—') + '</b></div>' +
      '<div><small>HS code</small><b class="mono">' + (p.hs_code ? esc(p.hs_code) : '—') + '</b></div></div>' +
      (p.notes && !/^Catalogue code /.test(p.notes) ? '<p class="hint">' + esc(p.notes.replace(/ · Catalogue code \S+$/, '')) + '</p>' : '');
    if (!mode) {
      h += (st.locs.length ? '<label class="lbl">Where it is</label>' + boxChips(st) : '') +
        '<div class="bigacts"><button type="button" class="big go" id="doOut">− Take out</button><button type="button" class="big ok" id="doAdd">+ Add stock</button></div>' +
        '<details class="more"><summary>More</summary><div class="moreacts"><button type="button" data-mode="RETURN">↩ Return</button><button type="button" data-mode="SCRAP">✕ Damaged</button><button type="button" data-mode="MOVE">⇄ Move to another box</button></div></details>';
    } else {
      var title = { OUT: 'Take out', ADD: 'Add stock', RETURN: 'Return unused parts', SCRAP: 'Write off damaged parts', MOVE: 'Move to another box' }[mode];
      h += '<h4 class="formtitle">' + title + '</h4>';
      if (mode === 'OUT' || mode === 'SCRAP') h += '<label class="lbl">From which box?</label>' + boxChips(st, function (l) { return l.type === 'BIN' || num(l.qty) > 0; });
      if (mode === 'RETURN') h += '<label class="lbl">Back into which box?</label>' + boxChips(st, function (l) { return l.type === 'BIN'; });
      if (mode === 'MOVE') h += '<label class="lbl">From which box?</label>' + boxChips(st, function (l) { return num(l.qty) > 0; }) + boxInput('Move to a', st);
      if (mode === 'ADD') h += boxInput('Put it in a', st);
      h += qtyField(1);
      if (mode === 'RETURN') h += vehField(false);
      if (mode === 'SCRAP') h += '<label class="lbl" for="noteInput">What is wrong? (optional)</label><input id="noteInput" placeholder="e.g. cracked in transit">';
      h += '<div class="btns"><button type="button" class="big" id="doBack">Back</button><button type="button" class="big ' + (mode === 'SCRAP' ? 'bad' : mode === 'OUT' ? 'go' : 'ok') + '" id="doGo">' + title + '</button></div>' +
        '<p class="hint">Logged under your name: ' + esc(cfg.user || '-') + '</p>';
    }
    h += '</div>';
    modal(h);
    qsa('#modalBody [data-box]').forEach(function (b) {
      b.onclick = function () { sel.box = b.dataset.box; qsa('#modalBody [data-box]').forEach(function (x) { x.classList.toggle('on', x === b); }); if ($('boxInput') && mode === 'ADD') $('boxInput').value = sel.box; };
    });
    qsa('#modalBody [data-cam]').forEach(function (b) { b.onclick = function () { openCam(b.dataset.cam); }; });
    $('photoCam').onclick = function () { $('photoCamPick').click(); };    // opens the camera straight away
    $('ordSave').onclick = function () {
      var v = Math.max(0, Math.round(num($('ordLevel').value)));
      api('setReorder', { sku: p.sku, level: v }).then(function () {
        p.reorder_at = String(v); toast('Order ' + p.name + ' when ' + v + ' or fewer are left', 'good'); renderPart(); renderAll();
      }).catch(function (e) { toast(e.business ? e.message : 'Saving needs a connection. Try again.', 'bad'); });
    };
    $('photoGal').onclick = function () { $('photoPick').click(); };       // picks a saved photo
    $('photoCamPick').onchange = $('photoPick').onchange = function () { var f = this.files && this.files[0]; this.value = ''; if (f) uploadPhoto(p.sku, f); };
    qsa('#modalBody [data-kind]').forEach(function (b) { b.onclick = function () { var q = $('fQty').value; sel.kind = b.dataset.kind; sel.pick = null; renderPart(); $('fQty').value = q; }; });
    qsa('#modalBody [data-pick]').forEach(function (b) { b.onclick = function () {
      sel.pick = b.dataset.pick; $('boxInput').value = sel.pick;
      qsa('#modalBody [data-pick]').forEach(function (x) { x.classList.toggle('on', x === b); });
    }; });
    if (!mode) {
      $('doOut').onclick = function () {
        if (!st.locs.some(function (l) { return num(l.qty) > 0; }) && !st.locs.length) return toast('No stock of this part yet. Use Add stock first.', 'bad');
        sel.mode = 'OUT'; renderPart();
      };
      $('doAdd').onclick = function () { sel.mode = 'ADD'; sel.pick = null; sel.kind = sel.box ? kindOf(sel.box) : 'BIN'; renderPart(); };
      qsa('#modalBody [data-mode]').forEach(function (b) {
        b.onclick = function () {
          if (b.dataset.mode !== 'RETURN' && !st.locs.length) return toast('This part is not in any box yet.', 'bad');
          if (b.dataset.mode === 'RETURN' && !st.locs.some(function (l) { return l.type === 'BIN'; })) return toast('This part has no bin to return to. Use Add stock.', 'bad');
          sel.mode = b.dataset.mode; sel.pick = null;
          sel.kind = sel.box && kindOf(sel.box) === 'TOTE' ? 'BIN' : 'TOTE';   // moving: usually white box -> blue bin
          renderPart();
        };
      });
    } else {
      $('doBack').onclick = function () { sel.mode = null; renderPart(); };
      $('doGo').onclick = submitPart;
      if ($('vehInput')) $('vehInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.value = vehicleFrom(this.value); } });
    }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.stepper button'); if (!b) return;
    var inp = b.parentNode.querySelector('input'); inp.value = Math.max(inp.id === 'ordLevel' ? 0 : 1, num(inp.value) + num(b.dataset.step));
  });

  /** Take or pick a photo on the phone: made small, saved for this part, shown on every phone. */
  function uploadPhoto(sku, file) {
    if (!signedIn()) return showSignIn();
    var btns = qsa('.photobtns .photobtn'); btns.forEach(function (b) { b.disabled = true; }); if (btns[0]) btns[0].textContent = 'Saving photo…';
    var reader = new FileReader();
    reader.onload = function () {
      shrink(reader.result, 480, .75).then(function (d) { return d && d.length < 49000 ? d : shrink(reader.result, 320, .6); }).then(function (d) {
        if (!d) throw new Error('That file is not a photo');
        return api('setPhoto', { sku: sku, data: d }).then(function (r) {
          photoMem[r.id] = d; cachePut(r.id, d);
          if (P[sku]) P[sku].photo_id = r.id;
          toast('Photo saved for every phone', 'good');
          if (sel && sel.sku === sku) renderPart();
          renderAll();
        });
      }).catch(function (e) {
        toast(e.business ? e.message : 'Saving a photo needs a connection. Try again.', 'bad');
        btns.forEach(function (b) { b.disabled = false; }); if (btns[0]) btns[0].textContent = '📷 Take photo';
      });
    };
    reader.readAsDataURL(file);
  }

  function submitPart() {
    var p = P[sel.sku], mode = sel.mode, qty = Math.round(num($('fQty').value));
    if (!signedIn()) return showSignIn();
    if (qty < 1) return toast('Enter how many', 'bad');
    var box = sel.box, item;
    if (mode === 'ADD' || mode === 'MOVE') {
      var to = normLoc_($('boxInput').value);
      if (!KIND[sel.kind].re.test(to)) { $('boxInput').focus(); return toast('A ' + KIND[sel.kind].name.toLowerCase() + ' label looks like ' + KIND[sel.kind].eg + (sel.kind === 'BIN' ? ' (or R1-S1-B02-A)' : ''), 'bad'); }
      if (mode === 'ADD') {
        item = { id: uid(), type: 'RECEIVE', sku: p.sku, loc: to, qty: qty, device: cfg.device };
        enqueue('putAway', item, '+' + qty + ' ' + p.name + ' → ' + KIND[sel.kind].name.toLowerCase() + ' ' + to);
        var isNew = !L[to];
        toast('Added ' + qty + ' × ' + p.name + ' to ' + KIND[sel.kind].name.toLowerCase() + ' ' + to + (isNew ? ' (new: print its label later in Labels)' : ''), 'good');
      } else {
        if (!box) return toast('Tap the box to move from', 'bad');
        if (to === box) return toast('Choose a different box', 'bad');
        item = { id: uid(), type: 'TRANSFER', sku: p.sku, from: box, to: to, loc: box, to_loc: to, qty: qty, device: cfg.device };
        if (qty >= num((lk(box, p.sku) || {}).qty)) setTimeout(function () { toast('All moved: ' + box + ' no longer holds ' + p.name + '.', 'good'); }, 1800);
        enqueue('moveStock', item, '⇄ ' + qty + ' ' + p.name + ' ' + box + ' → ' + to);
        toast('Moved ' + qty + ' from ' + KIND[kindOf(box)].name.toLowerCase() + ' ' + box + ' to ' + KIND[sel.kind].name.toLowerCase() + ' ' + to, 'good');
      }
    } else {
      if (!box || !lk(box, p.sku)) return toast('Tap the box first', 'bad');
      var veh = $('vehInput') ? vehicleFrom($('vehInput').value) : '';
      if ((mode === 'OUT' || mode === 'SCRAP') && lk(box, p.sku).type === 'TOTE') return toast(box + ' is a white box. Use More → Move to put stock into a blue bin first.', 'bad');
      item = { id: uid(), type: mode, loc: box, sku: p.sku, qty: qty, vehicle: veh, note: $('noteInput') ? $('noteInput').value.trim() : '', device: cfg.device };
      var verb = { OUT: '−', RETURN: '+', SCRAP: '✕ −' }[mode];
      enqueue('move', item, verb + qty + ' ' + p.name);
      toast(verb + qty + ' ' + p.name + ' · ' + box + ' now ' + num(lk(box, p.sku).qty), 'good');
      var nowLoc = lk(box, p.sku);
      if (nowLoc.type === 'BIN' && num(nowLoc.min) > 0 && num(nowLoc.qty) <= num(nowLoc.min) && mode !== 'RETURN') {
        var totes = (BY[p.sku] || []).filter(function (l) { return l.type === 'TOTE' && num(l.qty) > 0; });
        setTimeout(function () { toast('Low stock in blue bin ' + box + ' (' + num(nowLoc.qty) + ' left). ' + (totes.length ? 'Refill it from white box ' + totes[0].loc + ' (More → Move).' : 'Reorder.'), 'bad'); }, 1800);
      }
    }
    closeModal(); sel = null; renderAll();
  }

  /* ---------------- RESTOCK ---------------- */
  var rsMode = 'open', rs = null;
  qsa('#restockSeg button').forEach(function (b) {
    b.onclick = function () {
      rsMode = b.dataset.rs; qsa('#restockSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $('restockHint').textContent = rsMode === 'open' ? 'Scan the white box. Its stock moves into the blue bin.' : 'Count the parts, put them in the white box, close it, then scan its label and enter the count.';
      rs = null; renderRestock();
    };
  });
  function scanRestock(code) {
    var r = resolve(code), loc = r && r.loc;
    var go = function (l) { rs = { loc: l.loc, sku: l.sku }; $('rsQty').value = Math.max(1, num(l.qty)); renderRestock(); };
    if (r && r.sku) loc = (BY[r.sku] || []).filter(function (l) { return l.type === 'TOTE' && (rsMode === 'seal' || num(l.qty) > 0); })[0];
    if (!loc || loc.type !== 'TOTE') { beep(false); toast(r ? 'No white box found for that. Scan the white box label.' : 'Not found: ' + code, 'bad'); return; }
    if (r && r.sku) { beep(true); return go(loc); }
    if (!inBox(loc.loc).length) { beep(false); toast(loc.loc + ' is empty. Use Add stock on a part first.', 'bad'); return; }
    beep(true); chooseInBox(loc.loc, go);
  }
  function renderRestock() {
    var loc = rs && lk(rs.loc, rs.sku), part = loc && P[loc.sku];
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
    var loc = rs && lk(rs.loc, rs.sku); if (!loc) return;
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
      var min = reorderLevel_(p), pr = price(p);
      return { p: p, bins: bins, totes: totes, binQty: binQty, toteQty: toteQty, min: min, low: locs.length > 0 && binQty + toteQty <= min,
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
    $('stockTable').innerHTML = '<thead><tr><th></th><th>SKU</th><th>Part</th><th>Bin</th><th class="n">In bin</th><th class="n">Order at</th><th class="n">Totes</th><th class="n">Total</th><th class="n">Value €</th></tr></thead><tbody>' +
      show.map(function (r) {
        return '<tr class="' + (r.low ? 'low' : '') + '" data-sku="' + esc(r.p.sku) + '"><td><span class="swatch sw-' + esc(r.p.model) + '" style="height:18px;display:block"></span></td>' +
          '<td class="mono">' + esc(codeOf(r.p)) + '</td><td>' + esc(r.p.name) + (r.low ? ' <span class="pill err">LOW</span>' : '') + '</td>' +
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
  function shelfOf(loc) { var m = /^(A200|C1|OK|UNI)-([BT])(\d+)$/.exec(loc); return m ? m[1] + '-' + m[2] + Math.floor(Number(m[3]) / 10) + 'x' : loc.split('-').slice(0, 2).join('-'); }   // counted in groups of ten

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
      return '<div class="item"><span class="swatch sw-' + esc(p.model) + '"></span><div class="grow"><div class="t1"><span class="mono">' + esc(l.loc) + '</span> · ' + esc(p.name) + '</div><div class="t2">SKU ' + esc(codeOf(p)) + ' · last counted ' + esc(l.last_count || 'never') + '</div></div>' +
        (did ? '<span class="pill done">Counted ✓</span>' : '<button data-count="' + esc(l.loc) + '" data-csku="' + esc(l.sku) + '">Count</button>') + '</div>';
    }).join('');
    qsa('[data-count]').forEach(function (b) { b.onclick = function () { countLoc(b.dataset.count, b.dataset.csku); }; });

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
      go(); setTimeout(function () { countLoc(c.loc, c.sku); }, 300); return;
    }
    go();
  }

  function scanCount(code) {
    var r = resolve(code), loc = r && r.loc;
    if (r && r.sku) loc = (BY[r.sku] || []).filter(function (l) { return l.type === 'BIN'; })[0];
    if (!loc) { beep(false); toast('Not found: ' + code, 'bad'); return; }
    beep(true);
    if (r && r.sku) return countLoc(loc.loc, loc.sku);
    chooseInBox(loc.loc, function (l) { countLoc(l.loc, l.sku); });
  }

  function countLoc(locId, sku, attempt) {
    var loc = sku ? lk(locId, sku) : lk(locId), part = loc && P[loc.sku]; if (!part) return;
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
      api('count', { id: uid(), loc: loc.loc, sku: loc.sku, counted: num(v), attempt: attempt }).then(function (r) {
        if (r.recount) { beep(false); countLoc(locId, loc.sku, 2); return; }
        closeModal();
        if (r.match) { beep(true); toast(loc.loc + ' · ' + part.name + ' matches ✓', 'good'); }
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
  $('labelNew').addEventListener('change', function () { lbSel = {}; renderLabels(); });
  $('labelAll').onchange = function () { var on = this.checked; labelPool().forEach(function (l) { lbSel[l.loc] = on; }); renderLabels(); };
  var RACKS = []; for (var rk = 1; rk <= 15; rk++) RACKS.push({ loc: 'R' + ('0' + rk).slice(-2), type: 'RACK' });
  function labelPool() {
    var q = $('labelSearch').value.trim().toLowerCase();
    if (lbMode === 'RACK') return RACKS.filter(function (r) { return !q || r.loc.toLowerCase().indexOf(q) >= 0; });
    return Object.keys(BOXES).map(function (k) { var rows = inBox(k); return rows.length ? { loc: k, type: rows[0].type, rows: rows } : null; })
      .filter(function (b) {
        if (!b || b.type !== lbMode) return false;
        if ($('labelNew').checked && !b.rows.some(function (r) { return !r.label_printed; })) return false;
        if (!q) return true;
        return (b.loc + ' ' + b.rows.map(function (l) { var p = P[l.sku]; return p.sku + ' ' + p.ns_sku + ' ' + p.name + ' ' + p.model; }).join(' ')).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return a.loc.localeCompare(b.loc, undefined, { numeric: true }); });
  }
  function renderLabels() {
    var pool = labelPool();
    var n = Object.keys(lbSel).filter(function (k) { return lbSel[k]; }).length;
    if (lbMode === 'RACK') {
      $('labelList').innerHTML = pool.map(function (r) {
        var n = snap.locations.filter(function (l) { return normLoc_(l.loc).indexOf(r.loc + '-') === 0; }).length;
        return '<label class="item"><input type="checkbox" style="width:auto" data-lb="' + r.loc + '"' + (lbSel[r.loc] ? ' checked' : '') + '><div class="grow"><div class="t1"><span class="mono">' + r.loc + '</span> · Rack ' + Number(r.loc.slice(1)) + '</div><div class="t2">' + n + ' bins set up · bin labels look like ' + r.loc + '-S2-B05</div></div></label>';
      }).join('');
      qsa('[data-lb]', $('labelList')).forEach(function (c) { c.onchange = function () { lbSel[c.dataset.lb] = c.checked; $('labelPrint').textContent = 'Print selected signs (' + Object.keys(lbSel).filter(function (k) { return lbSel[k]; }).length + ')'; }; });
      $('labelPrint').textContent = 'Print selected signs (' + n + ')';
      return;
    }
    var nb = needLabel(), segN = { BIN: 0, TOTE: 0 };
    nb.forEach(function (k) { segN[kindOf(k)]++; });
    qsa('#labelSeg button').forEach(function (x) {
      var base = { BIN: 'Bin labels', TOTE: 'White box labels', RACK: 'Rack signs' }[x.dataset.lb];
      x.textContent = base + (segN[x.dataset.lb] ? ' (' + segN[x.dataset.lb] + ' new)' : '');
    });
    $('labelList').innerHTML = pool.length ? pool.map(function (b) {
      var p = P[b.rows[0].sku], mixed = b.rows.length > 1;
      return '<label class="item"><input type="checkbox" style="width:auto" data-lb="' + esc(b.loc) + '"' + (lbSel[b.loc] ? ' checked' : '') + '><span class="lqrp" data-qr="' + esc(b.loc) + '" title="Tap to see the QR code big"></span><span class="swatch sw-' + esc(p.model) + '" style="height:22px"></span><div class="grow"><div class="t1"><span class="mono">' + esc(b.loc) + '</span> · ' +
        (mixed ? 'Mixed box · ' + b.rows.length + ' parts' : esc(p.name)) + '</div><div class="t2">' +
        (mixed ? esc(b.rows.map(function (l) { return P[l.sku].name + ' (' + num(l.qty) + ')'; }).join(', ')) : 'SKU ' + esc(codeOf(p)) + (b.type === 'TOTE' ? ' · qty ' + num(b.rows[0].qty) : '')) + '</div></div>' +
        (b.rows.some(function (r) { return !r.label_printed; }) ? '<span class="pill err">Not printed yet</span>' : '<span class="pill done">Printed ' + esc(b.rows[0].label_printed) + '</span>') + '</label>';
    }).join('') : '<p class="hint">' + ($('labelNew').checked ? 'All ' + (lbMode === 'BIN' ? 'blue bin' : 'white box') + ' labels are printed. Untick "Only labels not printed yet" to print one again.' : 'No ' + (lbMode === 'BIN' ? 'blue bins' : 'white boxes') + ' set up yet. They appear here after Add stock.') + '</p>';
    qsa('[data-lb]', $('labelList')).forEach(function (c) { c.onchange = function () { lbSel[c.dataset.lb] = c.checked; $('labelPrint').textContent = 'Print selected labels (' + Object.keys(lbSel).filter(function (k) { return lbSel[k]; }).length + ')'; }; });
    $('labelPrint').textContent = 'Print selected labels (' + n + ')';
    fillQrs();
  }
  /** Draws the QR code of every box in the Labels list (the code is the box code, e.g. C1-T001). Tap one to see it big. */
  function fillQrs() {
    var els = qsa('#labelList [data-qr]'); if (!els.length) return;
    loadScript(QR_LIB).then(function () {
      var tries = 0, go = function () {
        if (!window.qrcode) { if (tries++ < 20) setTimeout(go, 150); return; }
        qsa('#labelList [data-qr]').forEach(function (el) {
          if (!el.innerHTML) el.innerHTML = qrSvg(el.dataset.qr);
          el.onclick = function (e) { e.preventDefault(); e.stopPropagation(); bigQr(el.dataset.qr); };
        });
      };
      go();
    }).catch(function () {
      qsa('#labelList [data-qr]').forEach(function (el) { el.textContent = 'QR'; el.classList.add('off'); });
    });
  }
  function bigQr(loc) {
    var rows = inBox(loc);
    modal('<h3 class="formtitle mono" style="text-align:center">' + esc(loc) + '</h3><div class="qrbig">' + qrSvg(loc) + '</div>' +
      '<p class="hint" style="text-align:center">' + KIND[kindOf(loc)].name + ' · ' + esc(rows.map(function (l) { return P[l.sku].name + ' (' + num(l.qty) + ')'; }).join(', ')) + '</p>' +
      '<p class="hint" style="text-align:center">This QR code goes on the printed label. Scanning it opens this box.</p>' +
      '<div class="btns"><button type="button" class="big" data-x="close">Close</button></div>');
  }
  function qrSvg(text) {
    if (!window.qrcode) return '';
    var q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  }
  $('labelPrint').onclick = function () {
    if (lbMode === 'RACK') {
      var signs = RACKS.filter(function (r) { return lbSel[r.loc]; });
      if (!signs.length) return toast('Tick the rack signs to print first', 'bad');
      var sh = '';
      for (var si = 0; si < signs.length; si += 2) {
        sh += '<div class="page" style="grid-template-rows:148.5mm 148.5mm">' + signs.slice(si, si + 2).map(function (r) {
          return '<div class="lab racksign"><div class="rs-k">RACK</div><div class="rs-n">' + r.loc + '</div><div class="rs-h">Shelves S1, S2, S3 … from the bottom · bins B01, B02 … from the left<br>Bin label example: <b>' + r.loc + '-S2-B05</b></div></div>';
        }).join('') + '</div>';
      }
      $('printArea').innerHTML = sh;
      setTimeout(function () { window.print(); }, 150);
      return;
    }
    var chosen = labelPool().filter(function (b) { return lbSel[b.loc]; });
    if (!chosen.length) return toast('Tick the labels to print first', 'bad');
    loadScript(QR_LIB).catch(function () { toast('QR code library could not load. Labels will print without QR codes.', 'bad'); }).then(function () {
      var html = '';
      if (lbMode === 'BIN') {
        var L4 = LAYOUTS[$('labelLayout').value], cols = L4[0], rows = L4[1], w = L4[2], h = L4[3], per = cols * rows;
        var padT = Math.max(0, (297 - rows * h) / 2), padL = Math.max(0, (210 - cols * w) / 2);
        for (var i = 0; i < chosen.length; i += per) {
          html += '<div class="page" style="padding:' + padT + 'mm ' + padL + 'mm;grid-template-columns:repeat(' + cols + ',' + w + 'mm);grid-template-rows:repeat(' + rows + ',' + h + 'mm)">';
          chosen.slice(i, i + per).forEach(function (b) {
            var p = P[b.rows[0].sku], m = MODELS[p.model], mixed = b.rows.length > 1;
            html += '<div class="lab c-' + p.model + '"><div class="lh"><span>' + esc(m.name) + '</span><span>' + (mixed ? 'MIXED · ' + b.rows.length : esc(p.system) + ' · ' + esc(p.abc)) + '</span></div>' +
              '<div class="lb"><div class="lq">' + qrSvg(b.loc) + '</div><div class="lt">' +
              (mixed ? '<div class="lname lmix">' + b.rows.map(function (l) { return esc(P[l.sku].name); }).join(' · ') + '</div>'
                     : '<div class="lsku">' + esc(codeOf(p)) + '</div><div class="lname">' + esc(p.name) + '</div>') +
              '<div class="lloc">' + esc(b.loc) + '</div></div></div></div>';
          });
          html += '</div>';
        }
      } else {
        for (var j = 0; j < chosen.length; j += 2) {
          html += '<div class="page" style="grid-template-rows:148.5mm 148.5mm">';
          chosen.slice(j, j + 2).forEach(function (b) {
            var l = b.rows[0], p = P[l.sku], m = MODELS[p.model];
            if (b.rows.length > 1) {
              html += '<div class="lab tote c-' + p.model + '"><div class="lh"><span>MIXED BOX · ' + esc(m.name) + '</span><span>' + esc(b.loc) + '</span></div>' +
                '<div class="lb"><div class="lq">' + qrSvg(b.loc) + '</div><div class="lt"><div class="lmixlist">' + b.rows.map(function (x) {
                  return '<div><b>' + num(x.qty) + '</b> × ' + esc(P[x.sku].name) + ' <span>' + esc(codeOf(P[x.sku])) + '</span></div>';
                }).join('') + '</div><div class="tmeta">Packed ' + esc(today()) + '</div></div></div></div>';
              return;
            }
            html += '<div class="lab tote c-' + p.model + '"><div class="lh"><span>SEALED BULK · ' + esc(m.name) + '</span><span>' + esc(l.loc) + '</span></div>' +
              '<div class="lb"><div class="lq">' + qrSvg(l.loc) + '</div><div class="lt"><div><div class="lname">' + esc(p.name) + '</div><div class="lsku">' + esc(codeOf(p)) + '</div></div>' +
              '<div><div class="tmeta">EXACT QUANTITY</div><div class="tq">' + num(l.qty) + '</div><div class="tmeta">Sealed ' + esc(l.sealed_date || today()) + (l.notes ? ' · ' + esc(l.notes) : '') + '</div></div>' +
              '<div class="sealbox">Seal broken on ____/____/______ by __________</div></div></div></div>';
          });
          html += '</div>';
        }
      }
      $('printArea').innerHTML = html;
      setTimeout(function () {
        window.print();
        var locs = chosen.map(function (b) { return b.loc; });
        modal('<h3 class="formtitle">Did the labels print OK?</h3><p class="hint">' + locs.length + ' label' + (locs.length > 1 ? 's' : '') + ': ' + esc(locs.join(', ')) + '</p>' +
          '<div class="btns"><button type="button" class="big" data-x="no">No, keep them on the list</button><button type="button" class="big ok" data-x="yes">Yes, mark printed</button></div>', function (x) {
          if (x !== 'yes') return;
          api('markPrinted', { locs: locs }).then(function () { toast(locs.length + ' label' + (locs.length > 1 ? 's' : '') + ' marked printed', 'good'); lbSel = {}; return refresh(); })
            .catch(function (e) { toast(e.business ? e.message : 'Needs a connection. Try again.', 'bad'); });
        });
      }, 150);
    });
  };

  /* ---------------- SETUP ---------------- */
  function renderSetup() {
    var m = mode();
    $('connFields').style.display = EMBED || window.PREVIEW_ONLY ? 'none' : '';
    $('cfgSave').style.display = EMBED ? 'none' : '';
    $('demoPanel').style.display = m === 'DEMO' ? '' : 'none';
    $('connHint').textContent = m === 'EMBED' ? 'Opened from the Apps Script link. Connected to the Google Sheet.' :
      m === 'LIVE' ? 'Connected to the Google Sheet. Every device using this URL sees the same stock.' :
      'Not connected: demo mode. Paste the web app URL from the Apps Script setup to go live.';
    if (document.activeElement !== $('cfgUrl')) $('cfgUrl').value = cfg.url || '';
    $('appVer').textContent = 'App version ' + APP_VERSION;
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
    if (window.PREVIEW_ONLY) save('inv.previewOut', true);
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
      return { loc: (c[0] || '').toUpperCase(), sku: (c[1] || '').toUpperCase(), qty: num(c[2]), min: c[3] === undefined ? (isTote_(c[0]) ? 0 : 2) : num(c[3]) };
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
  /* --- Part photos: read the catalogue file in this browser, shrink each photo, save to the Photos tab --- */
  function jsonAfter(text, marker) {
    var i = text.indexOf(marker); if (i < 0) return null;
    i = text.indexOf('{', i); var depth = 0, str = false, q = '', esc2 = false;
    for (var j = i; j < text.length; j++) {
      var c = text[j];
      if (str) { if (esc2) esc2 = false; else if (c === '\\') esc2 = true; else if (c === q) str = false; continue; }
      if (c === '"' || c === "'") { str = true; q = c; } else if (c === '{') depth++; else if (c === '}') { if (--depth === 0) return JSON.parse(text.slice(i, j + 1)); }
    }
    return null;
  }
  function shrink(dataUrl, max, quality) {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        ok(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { ok(null); };
      img.src = dataUrl;
    });
  }
  $('photoGo').onclick = function () {
    var f = $('photoFile').files[0], out = $('photoOut');
    if (!f) return toast('Choose the catalogue file first', 'bad');
    $('photoGo').disabled = true; out.textContent = 'Reading the file…';
    f.text().then(function (text) {
      var data = jsonAfter(text, 'const DATA ='), thumbs = jsonAfter(text, 'const THUMBS =');
      if (!data || !thumbs || !data.parts) throw new Error('This is not the spare parts catalogue file');
      var want = {}; snap.parts.forEach(function (p) { if (p.photo_id) want[p.photo_id] = 1; });
      var pick = {};
      data.parts.forEach(function (cp) {
        var code = String(cp.sku || '').trim();
        if (!code || code === '#N/A' || code === 'Not found') code = ((/^img\d*\/(.+?) - /.exec(cp.id || '') || [])[1] || '').trim();
        if (!code || !want[code] || pick[code]) return;
        var src = [cp.id].concat(cp.alts || []).filter(function (k) { return k && thumbs[k]; })[0];
        if (src) pick[code] = thumbs[src];
      });
      var ids = Object.keys(pick), done = 0, saved = 0;
      if (!ids.length) throw new Error('No photos in the file match the parts list');
      var next = function () {
        if (done >= ids.length) {
          out.textContent = saved + ' photos saved. Phones show them the next time a part is opened.';
          photoMem = {}; qsa('[data-photo]').forEach(function (el) { delete el.dataset.state; }); renderAll(); syncPhotos(true);
          $('photoGo').disabled = false; return;
        }
        var batch = ids.slice(done, done + 12);
        Promise.all(batch.map(function (id) { return shrink(pick[id], 360, .72).then(function (d) { return d && d.length < 49000 ? { id: id, data: d } : shrink(pick[id], 240, .6).then(function (d2) { return d2 ? { id: id, data: d2 } : null; }); }); }))
          .then(function (items) { return api('savePhotos', { items: items.filter(Boolean) }); })
          .then(function (r) {
            saved += r.saved; done += batch.length;
            out.textContent = 'Saving photos… ' + done + ' of ' + ids.length;
            next();
          }).catch(function (e) { out.textContent = 'Stopped after ' + saved + ' photos: ' + e.message + '. Tap Load photos again to continue.'; $('photoGo').disabled = false; });
      };
      out.textContent = ids.length + ' photos found. Saving…'; next();
    }).catch(function (e) { out.textContent = e.message; $('photoGo').disabled = false; });
  };
  $('demoReset').onclick = function () { delete memStore['inv.demo']; try { localStorage.removeItem('inv.demo'); } catch (e) {} demo = null; queue = []; saveQueue(); refresh(); toast('Demo data reset', 'good'); };

  /* ---------------- sign-in ---------------- */
  function showSignIn(msg) {
    $('signin').classList.remove('hidden');
    $('siMsg').textContent = msg || '';
    $('siMsg').className = 'hint' + (/^(Signed out|Demo|Connected)/.test(msg || '') ? ' info' : '');
    $('siPin').value = '';
    $('siConn').style.display = EMBED || window.PREVIEW_ONLY ? 'none' : '';
    $('siUrl').value = cfg.url || '';
    var m = mode();
    $('siVer').textContent = 'App version ' + APP_VERSION;
    $('siConnHint').textContent = m === 'DEMO' ? 'Not connected yet: this is demo mode with sample data (demo PINs: Mechanic A 1111, Mechanic B 2222, Supervisor 9999, Admin 1234). Type your workshop code to connect to your stock.' : 'Connected to your stock sheet.';
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

  /* Workshop code: connect.json (next to the app) holds the /exec URL locked with PBKDF2 + AES-GCM.
     Made by tools/make_connect_code.js.  The code is typed once per device instead of the long URL. */
  function b64bytes(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function unlockUrl(code) {
    var norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm.length < 6) return Promise.reject(new Error('Type the full workshop code'));
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('This browser cannot unlock the code. Paste the link instead.'));
    return fetch('connect.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('No workshop code is set up for this app. Paste the link instead.');
      return r.json();
    }).then(function (c) {
      return crypto.subtle.importKey('raw', new TextEncoder().encode(norm), 'PBKDF2', false, ['deriveKey']).then(function (base) {
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64bytes(c.salt), iterations: c.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      }).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64bytes(c.iv) }, key, b64bytes(c.ct));
      }).then(function (buf) { return new TextDecoder().decode(buf); }, function () { throw new Error('Wrong workshop code'); });
    });
  }
  function connectWithCode() {
    var btn = $('siCodeGo'); btn.disabled = true; btn.textContent = 'Checking…';
    unlockUrl($('siCode').value).then(function (url) {
      if (saveUrl(url)) { $('siCode').value = ''; showSignIn('Connected. Sign in with your name and PIN.'); }
    }).catch(function (e) { beep(false); toast(e.message, 'bad'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Connect'; });
  }
  $('siCodeGo').onclick = connectWithCode;
  $('siCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') connectWithCode(); });
  $('meBtn').onclick = function () { if (!signedIn()) showSignIn(); else showTab('setup'); };

  /* ---------------- start ---------------- */
  var handlers = { scanInput: scanTake, restockInput: scanRestock, countInput: scanCount };
  onEnter('scanInput', scanTake);
  onEnter('restockInput', scanRestock);
  onEnter('countInput', scanCount);

  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  window.addEventListener('online', function () { online = true; flush(); });
  setInterval(poll, 8000);
  setInterval(flush, 15000);
  try {
    if (!EMBED && !window.PREVIEW_ONLY && 'serviceWorker' in navigator && location.protocol === 'https:') {
      var hadSw = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').then(function (reg) { reg.update(); }).catch(function () {});
      // a new version took over: reload once so the screens match it (pending actions are safe in the queue)
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        try { if (hadSw && !sessionStorage.getItem('inv.reloaded')) { sessionStorage.setItem('inv.reloaded', '1'); location.reload(); } } catch (e) {}
      });
    }
  } catch (e) {}   // some embedded pages do not allow offline storage; the app still works online

  /* ---------- updates: the website publishes version.json; a phone with an older copy updates itself ---------- */
  var updating = false;
  function forceUpdate(why) {
    if (updating) return; updating = true;
    toast(why || 'Updating to the new version…', 'good');
    var jobs = [];
    try { if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })); } catch (e) {}
    try { if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return /^stocks-v\d+$/.test(k); }).map(function (k) { return caches.delete(k); })); })); } catch (e) {}
    Promise.all(jobs).catch(function () {}).then(function () { setTimeout(function () { location.reload(); }, 600); });   // waiting actions stay in the queue
  }
  var lastUpdateCheck = 0;
  function checkForUpdate(manual) {
    if (EMBED || window.PREVIEW_ONLY || !/^https?:/.test(location.protocol)) { if (manual) toast('This copy updates with the Apps Script deployment.', 'good'); return; }
    if (!manual && Date.now() - lastUpdateCheck < 10 * 60000) return;
    lastUpdateCheck = Date.now();
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !v.version) { if (manual) toast('Could not check for updates. Try again with internet.', 'bad'); return; }
      if (v.version !== APP_VERSION) {
        var key = 'inv.updatedTo', tried = load(key, '');
        if (tried === v.version && !manual) return;            // tried once already this session: do not loop
        save(key, v.version);
        forceUpdate('New version ' + v.version.split(' ')[0] + '. Updating…');
      } else if (manual) toast('You have the newest version (' + APP_VERSION.split(' ')[0] + ').', 'good');
    }).catch(function () { if (manual) toast('Could not check for updates. Try again with internet.', 'bad'); });
  }
  $('checkUpdate').onclick = function () { checkForUpdate(true); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkForUpdate(false); });
  setTimeout(function () { checkForUpdate(false); }, 1500);

  setStatus();

  /* Android Back button: closes what is open (big photo, camera, part window), then goes to the previous tab.
   * Only on the first screen with nothing open does Back leave the app.  A spare history entry catches each press. */
  function handleBack() {
    var big = document.querySelector('.photoBig'); if (big) { big.remove(); return true; }
    if (!$('camModal').classList.contains('hidden')) { closeCam(); return true; }
    if (!$('modal').classList.contains('hidden')) { closeModal(); sel = null; renderAll(); return true; }
    if (!$('signin').classList.contains('hidden')) return false;
    while (tabTrail.length) { var t = tabTrail.pop(); if (t !== current && tabAllowed(t)) { showTab(t, true); return true; } }
    if (current !== 'take') { showTab('take', true); return true; }
    return false;
  }
  if (!EMBED && window.history && history.pushState) {
    try {
      history.replaceState({ inv: 'base' }, '');
      history.pushState({ inv: 'guard' }, '');
      window.addEventListener('popstate', function () {
        if (handleBack()) history.pushState({ inv: 'guard' }, '');
        else history.back();   // nothing left to close: leave the app
      });
    } catch (e) {}
  }
  // Setup link: <app link>#connect=<Apps Script /exec URL> connects this device in one tap.
  // The /exec URL stays out of the public code; share the setup link only with your team.
  var hc = /^#connect=(.+)$/.exec(location.hash || '');
  if (hc && !EMBED) {
    history.replaceState(null, '', location.pathname + location.search);
    var want = decodeURIComponent(hc[1]).trim();
    if (want !== (cfg.url || '') && saveUrl(want)) { showSignIn('Connected. Sign in with your name and PIN.'); flush(); return; }
  }
  // the preview page opens straight inside, as the demo supervisor (Sign out shows the sign-in screen)
  if (window.PREVIEW_ONLY && !signedIn() && !load('inv.previewOut', false)) { cfg.user = 'Supervisor'; cfg.pin = '9999'; cfg.role = 'supervisor'; save('inv.cfg', cfg); }
  if (signedIn()) refresh().then(flush); else { showSignIn(); flush(); }
})();
