/**
 * Inventory/Stocks core logic.  Shared by:
 *   - the Google Apps Script backend (pasted as Core.gs, store = Google Sheet tabs)
 *   - the app's demo mode (store = browser localStorage)
 * Every stock change goes through move() or resolveCount(), and every one is written to
 * the Movements log.  Nothing changes a quantity without a log line.
 */
var TABLES = {
  Parts:     ['sku', 'name', 'model', 'system', 'abc', 'ns_sku', 'tier_code', 'fits', 'unit', 'notes', 'price_eur', 'weight_g', 'photo_id', 'hs_code'],
  Locations: ['loc', 'type', 'sku', 'qty', 'min', 'sealed_date', 'last_count', 'notes'],
  Movements: ['id', 'ts', 'type', 'sku', 'from_loc', 'to_loc', 'qty', 'mechanic', 'vehicle', 'note', 'device'],
  Counts:    ['id', 'ts', 'loc', 'sku', 'expected', 'counted', 'variance', 'counter', 'status', 'resolved_by', 'resolved_ts'],
  Staff:     ['name', 'pin_hash', 'role', 'active']
};

/** Sign-in.  Each person has their own PIN.  The Staff tab stores SHA-256(name + ':' + PIN), never the PIN.
 *  'Admin' + the admin PIN from setup() always works, so the first supervisor can be created. */
var ADMIN_NAME = 'Admin';
var ROLES = { mechanic: 'Mechanic', supervisor: 'Supervisor' };
/** Only supervisors may run these.  Mechanics can take, return, damaged, receive, restock, seal, count and add new parts
 *  (changing an existing part is checked in savePart). */
var SUPERVISOR_OPS = { resolveCount: 1, saveLocation: 1, saveLocations: 1, addStaff: 1, setStaff: 1 };
/** These never need a sign-in (the sign-in screen needs the list of names). */
var PUBLIC_OPS = { staffNames: 1 };

function pinOk_(pin) { return /^\d{4,8}$/.test(String(pin == null ? '' : pin)); }
function isActive_(r) { return !/^(no|false|0|n)$/i.test(String(r.active == null ? '' : r.active).trim()); }
function staffKey_(name, pin) { return String(name).trim() + ':' + String(pin); }

/** Finds the active Staff row whose name and PIN hash match.  rows = Staff tab rows. */
function matchStaff_(rows, user, hash) {
  user = String(user || '').trim();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.name).trim() === user && r.pin_hash && String(r.pin_hash).toLowerCase() === String(hash).toLowerCase() && isActive_(r))
      return { name: String(r.name).trim(), role: r.role === 'supervisor' ? 'supervisor' : 'mechanic' };
  }
  return null;
}

/** Movement types and how they change stock. */
var MOVE_TYPES = {
  OUT:     'Taken for repair (out of bin)',
  RETURN:  'Returned unused (back to bin)',
  SCRAP:   'Damaged / scrapped from stock',
  RECEIVE: 'New delivery received',
  RESTOCK: 'Break seal: tote to bin',
  SEAL:    'Tote counted and sealed',
  TRANSFER:'Moved between bins',
  ADJUST:  'Count correction'
};

function Core(store) {
  this.s = store;
}

Core.prototype.nowIso = function () { return new Date().toISOString(); };

Core.prototype.snapshot = function () {
  return {
    parts: this.s.rows('Parts'),
    locations: this.s.rows('Locations'),
    staff: this.s.rows('Staff').filter(function (r) { return r.name; }).map(function (r) {
      return { name: String(r.name).trim(), role: r.role === 'supervisor' ? 'supervisor' : 'mechanic', active: isActive_(r), has_pin: !!r.pin_hash };
    }),
    counts: this.s.rows('Counts').filter(function (c) { return c.status === 'REVIEW'; }),
    version: this.s.version()
  };
};

Core.prototype.findLoc_ = function (loc) {
  loc = normLoc_(loc);
  var rows = this.s.rows('Locations');
  for (var i = 0; i < rows.length; i++) if (normLoc_(rows[i].loc) === loc) return rows[i];
  return null;
};

Core.prototype.findPart_ = function (sku) {
  var rows = this.s.rows('Parts');
  for (var i = 0; i < rows.length; i++) if (rows[i].sku === sku) return rows[i];
  return null;
};

Core.prototype.log_ = function (m) {
  var row = {};
  TABLES.Movements.forEach(function (k) { row[k] = m[k] == null ? '' : m[k]; });
  row.ts = row.ts || this.nowIso();
  this.s.append('Movements', row);
};

function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function fail_(msg, extra) { var e = new Error(msg); e.extra = extra; throw e; }

/**
 * One stock movement.
 * p = {id, type, loc, to_loc, qty, mechanic, vehicle, note, device, force}
 *   OUT/SCRAP: loc loses qty.  RETURN/RECEIVE: loc gains qty.
 *   RESTOCK/TRANSFER: loc (tote / source bin) -> to_loc (pick bin).
 *   SEAL: loc (a tote) is set to exactly qty and stamped with today's seal date.
 */
Core.prototype.move = function (p) {
  if (!p.id) fail_('Missing movement id');
  if (this.s.hasMovement(p.id)) return { ok: true, duplicate: true };   // phone retried a sent action
  var type = String(p.type || '').toUpperCase();
  if (!MOVE_TYPES[type] || type === 'ADJUST') fail_('Unknown action ' + p.type);
  var qty = Math.round(num_(p.qty));
  if (qty <= 0) fail_('Quantity must be 1 or more');
  var src = this.findLoc_(p.loc);
  if (!src) fail_('Location ' + p.loc + ' is not set up');
  if (!src.sku) fail_('Location ' + src.loc + ' has no part assigned');
  var now = this.nowIso(), out = { ok: true };

  if (type === 'OUT' || type === 'SCRAP') {
    var have = num_(src.qty);
    if (have < qty && !p.force)
      fail_('System shows only ' + have + ' in ' + src.loc, { code: 'SHORT', have: have });
    if (have < qty) this.flagCount_(src, 'Over-pick: system had ' + have + ', took ' + qty);
    this.s.update('Locations', src, { qty: have - qty });
    this.log_({ id: p.id, ts: now, type: type, sku: src.sku, from_loc: src.loc, qty: qty, mechanic: p.mechanic, vehicle: p.vehicle, note: p.note, device: p.device });
  } else if (type === 'RETURN' || type === 'RECEIVE') {
    this.s.update('Locations', src, { qty: num_(src.qty) + qty });
    this.log_({ id: p.id, ts: now, type: type, sku: src.sku, to_loc: src.loc, qty: qty, mechanic: p.mechanic, vehicle: p.vehicle, note: p.note, device: p.device });
  } else if (type === 'SEAL') {
    if (src.type !== 'TOTE') fail_(src.loc + ' is not a bulk tote');
    var was = num_(src.qty);
    this.s.update('Locations', src, { qty: qty, sealed_date: now.slice(0, 10), last_count: now.slice(0, 10) });
    this.log_({ id: p.id, ts: now, type: 'SEAL', sku: src.sku, to_loc: src.loc, qty: qty - was, mechanic: p.mechanic, note: 'Sealed with ' + qty + (p.note ? ' - ' + p.note : ''), device: p.device });
  } else { // RESTOCK / TRANSFER
    var dst = this.findLoc_(p.to_loc);
    if (!dst) fail_('Location ' + p.to_loc + ' is not set up');
    if (dst.sku !== src.sku) fail_(dst.loc + ' holds ' + dst.sku + ', not ' + src.sku);
    if (num_(src.qty) < qty && !p.force)
      fail_('System shows only ' + num_(src.qty) + ' in ' + src.loc, { code: 'SHORT', have: num_(src.qty) });
    var left = num_(src.qty) - qty;
    var srcPatch = { qty: left };
    if (src.type === 'TOTE' && type === 'RESTOCK') srcPatch.sealed_date = left > 0 ? 'OPENED ' + now.slice(0, 10) : '';
    this.s.update('Locations', src, srcPatch);
    this.s.update('Locations', dst, { qty: num_(dst.qty) + qty });
    this.log_({ id: p.id, ts: now, type: type, sku: src.sku, from_loc: src.loc, to_loc: dst.loc, qty: qty, mechanic: p.mechanic, note: p.note, device: p.device });
    out.to = { loc: dst.loc, qty: num_(dst.qty) };
  }
  this.s.bump();
  out.loc = { loc: src.loc, qty: num_(src.qty), min: num_(src.min) };
  out.version = this.s.version();
  return out;
};

Core.prototype.flagCount_ = function (loc, note) {
  this.s.append('Counts', { id: 'F' + Date.now(), ts: this.nowIso(), loc: loc.loc, sku: loc.sku, expected: num_(loc.qty), counted: '', variance: '', counter: note, status: 'REVIEW', resolved_by: '', resolved_ts: '' });
};

/**
 * Blind count.  p = {id, loc, counted, counter, attempt}
 * The counter never sees the system quantity.  First mismatch: nothing saved, asked to recount.
 * Second mismatch: saved as REVIEW for a supervisor.  A match stamps last_count.
 */
Core.prototype.count = function (p) {
  var loc = this.findLoc_(p.loc);
  if (!loc) fail_('Location ' + p.loc + ' is not set up');
  var counted = Math.round(num_(p.counted)), expected = num_(loc.qty), now = this.nowIso();
  if (counted < 0 || String(p.counted).trim() === '') fail_('Enter the number you counted');
  var match = counted === expected;
  if (!match && num_(p.attempt) < 2) return { ok: true, match: false, recount: true };
  this.s.append('Counts', {
    id: p.id || 'C' + Date.now(), ts: now, loc: loc.loc, sku: loc.sku, expected: expected, counted: counted,
    variance: counted - expected, counter: p.counter || '', status: match ? 'OK' : 'REVIEW', resolved_by: '', resolved_ts: ''
  });
  this.s.update('Locations', loc, { last_count: now.slice(0, 10) });
  this.s.bump();
  return { ok: true, match: match, saved: true, version: this.s.version() };
};

/** Supervisor decision on a REVIEW count.  p = {id, accept, by, counted (optional new figure)} */
Core.prototype.resolveCount = function (p) {
  var c = null, rows = this.s.rows('Counts');
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(p.id)) c = rows[i];
  if (!c) fail_('Count ' + p.id + ' not found');
  if (c.status !== 'REVIEW') return { ok: true, already: c.status };
  var now = this.nowIso();
  if (p.accept) {
    var loc = this.findLoc_(c.loc);
    var target = p.counted !== undefined && p.counted !== '' ? Math.round(num_(p.counted)) : num_(c.counted);
    var delta = target - num_(loc.qty);
    this.s.update('Locations', loc, { qty: target, last_count: now.slice(0, 10) });
    this.log_({ id: 'ADJ-' + c.id, ts: now, type: 'ADJUST', sku: loc.sku, to_loc: loc.loc, qty: delta, mechanic: p.by, note: 'Count correction (was ' + (target - delta) + ', counted ' + target + ')', device: p.device });
  }
  this.s.update('Counts', c, { status: p.accept ? 'APPROVED' : 'REJECTED', resolved_by: p.by || '', resolved_ts: now });
  this.s.bump();
  return { ok: true, version: this.s.version() };
};

/**
 * Add or edit a bin/tote.  p = {loc, type, sku, min, qty, notes, by}
 * qty is only used when the location is new (opening stock) and is logged as ADJUST.
 */
Core.prototype.saveLocation = function (p) {
  var id = normLoc_(p.loc);
  if (!/^(R\d+-S\d+-B\d+(-[A-Z])?|T-?\d+)$/.test(id)) fail_('Location must look like R1-S3-B04, R1-S3-B04-A or T-0001');
  if (p.sku && !this.findPart_(p.sku)) fail_('Unknown SKU ' + p.sku);
  var type = isTote_(id) ? 'TOTE' : 'BIN';
  var ex = this.findLoc_(id), now = this.nowIso();
  if (ex) {
    if (ex.sku && p.sku && ex.sku !== p.sku && num_(ex.qty) !== 0) fail_(id + ' still holds ' + ex.qty + ' x ' + ex.sku + '. Empty it first.');
    this.s.update('Locations', ex, { sku: p.sku || ex.sku, min: p.min === undefined ? ex.min : num_(p.min), notes: p.notes === undefined ? ex.notes : p.notes });
  } else {
    var qty = Math.max(0, Math.round(num_(p.qty)));
    this.s.append('Locations', { loc: id, type: type, sku: p.sku || '', qty: qty, min: num_(p.min), sealed_date: type === 'TOTE' && qty > 0 ? now.slice(0, 10) : '', last_count: qty > 0 ? now.slice(0, 10) : '', notes: p.notes || '' });
    if (qty > 0) this.log_({ id: 'OPEN-' + id + '-' + Date.now(), ts: now, type: 'ADJUST', sku: p.sku, to_loc: id, qty: qty, mechanic: p.by, note: 'Opening stock', device: p.device });
  }
  this.s.bump();
  return { ok: true, version: this.s.version() };
};

/** Many locations at once (year-end count / first load).  p = {rows: [{loc, sku, qty, min}], by} */
Core.prototype.saveLocations = function (p) {
  var self = this, results = [];
  (p.rows || []).forEach(function (r) {
    try {
      if (self.findLoc_(r.loc)) { results.push({ loc: r.loc, skipped: 'already exists' }); return; }
      self.saveLocation({ loc: r.loc, sku: r.sku, qty: r.qty, min: r.min, by: p.by, device: p.device });
      results.push({ loc: r.loc, ok: true });
    } catch (e) { results.push({ loc: r.loc, error: e.message }); }
  });
  return { ok: true, results: results, version: this.s.version() };
};

/** Add a part, or change one.  p = {sku, name, abc, ns_sku, notes, price_eur, weight_g, photo_id}; only the fields given are changed. */
Core.prototype.savePart = function (p, who) {
  if (!/^(OK4|NB3|NB2|UNI)-(ELC|WHL|BDY|DRV|FST)-[A-Z0-9]+$/.test(p.sku || '')) fail_('SKU must look like OK4-ELC-CTRL');
  if (p.abc !== undefined && !/^[ABC]$/.test(p.abc)) fail_('ABC class must be A, B or C');
  ['price_eur', 'weight_g'].forEach(function (k) {
    if (p[k] !== undefined && p[k] !== '' && !(Number(p[k]) >= 0)) fail_(k === 'price_eur' ? 'Price must be a number' : 'Weight must be a number of grams');
  });
  var ex = this.findPart_(p.sku);
  if (ex && who && who.role !== 'supervisor') fail_(p.sku + ' already exists. Only a supervisor can change an existing part.', { code: 'ROLE' });
  if (ex) {
    var patch = {};
    ['name', 'abc', 'ns_sku', 'notes', 'price_eur', 'weight_g', 'photo_id', 'hs_code'].forEach(function (k) { if (p[k] !== undefined) patch[k] = p[k]; });
    this.s.update('Parts', ex, patch);
  } else {
    if (!p.name) fail_('Enter the part name');
    this.s.append('Parts', {
      sku: p.sku, name: p.name, model: p.sku.slice(0, 3), system: p.sku.slice(4, 7), abc: p.abc || 'B', ns_sku: p.ns_sku || '',
      unit: 'pcs', notes: p.notes || '', price_eur: p.price_eur || '', weight_g: p.weight_g || '',
      photo_id: p.photo_id !== undefined ? p.photo_id : (p.ns_sku || '')    // Drive photos are named "<NetSuite SKU> - <name>"
    });
  }
  this.s.bump();
  return { ok: true, version: this.s.version() };
};

var LOC_RE = /^(R\d+-S\d+-B\d+(-[A-Z])?|T-?\d+|(A200|C1|OK|UNI)-[BT]\d{3,})$/;
/** Box codes made by the app say which vehicle the parts are for: C1-B014 = C1 blue bin 14, A200-T003 = A200 white box 3.
 *  Older codes R1-S3-B04 (blue bin) and T-0001 (white box) still work. */
function isTote_(id) { return /^T|^(A200|C1|OK|UNI)-T/.test(String(id || '').toUpperCase()); }
function pad2_(n) { n = String(Number(n)); return n.length < 2 ? '0' + n : n; }
/** One spelling per box: R1-S2-B5 -> R01-S2-B05, t1 -> T-0001.  Racks are R01 ... R15. */
function normLoc_(v) {
  var s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  var m = /^R0*(\d+)-S0*(\d+)-B0*(\d+)(-[A-Z])?$/.exec(s);
  if (m) return 'R' + pad2_(m[1]) + '-S' + Number(m[2]) + '-B' + pad2_(m[3]) + (m[4] || '');
  var mc = /^(A200|C1|OK|UNI)-?([BT])-?0*(\d+)$/.exec(s);
  if (mc) return mc[1] + '-' + mc[2] + ('00' + Number(mc[3])).slice(-Math.max(3, String(Number(mc[3])).length));
  var t = /^T-?0*(\d+)$/.exec(s);
  if (t) return 'T-' + ('000' + Number(t[1])).slice(-4);
  return s;
}

/** Makes sure box `id` exists and holds `sku`: creates it, or fills an empty box.  Returns the box row. */
Core.prototype.ensureBox_ = function (id, sku, min) {
  id = normLoc_(id);
  if (!LOC_RE.test(id)) fail_('Box must look like C1-B014, A200-T003, R1-S3-B04 or T-0001');
  var ex = this.findLoc_(id);
  if (ex) {
    if (ex.sku === sku) return ex;
    if (ex.sku && num_(ex.qty) !== 0) fail_(id + ' already holds ' + num_(ex.qty) + ' x ' + ex.sku + '. Use another box.');
    this.s.update('Locations', ex, { sku: sku, min: min !== undefined && min !== '' ? num_(min) : num_(ex.min) });
    return ex;
  }
  this.s.append('Locations', { loc: id, type: isTote_(id) ? 'TOTE' : 'BIN', sku: sku, qty: 0, min: num_(min), sealed_date: '', last_count: '', notes: '' });
  return this.findLoc_(id);
};

/** Add stock of a part into a box (new box, empty box, or the box that already holds it).  Logged as RECEIVE.
 *  p = {id, sku, loc, qty, min, note} */
Core.prototype.putAway = function (p) {
  if (!p.id) fail_('Missing movement id');
  if (this.s.hasMovement(p.id)) return { ok: true, duplicate: true };
  var part = this.findPart_(String(p.sku || '').toUpperCase());
  if (!part) fail_('Unknown SKU ' + p.sku);
  if (Math.round(num_(p.qty)) <= 0) fail_('Quantity must be 1 or more');
  var box = this.ensureBox_(p.loc, part.sku, p.min);
  return this.move({ id: p.id, type: 'RECEIVE', loc: box.loc, qty: p.qty, mechanic: p.mechanic, note: p.note, device: p.device });
};

/** Move stock from one box to another (a new or empty box is set up for the part).  p = {id, from, to, qty, force} */
Core.prototype.moveStock = function (p) {
  if (!p.id) fail_('Missing movement id');
  if (this.s.hasMovement(p.id)) return { ok: true, duplicate: true };
  var src = this.findLoc_(p.from);
  if (!src || !src.sku) fail_('Box ' + p.from + ' is not set up');
  if (normLoc_(p.to) === src.loc) fail_('Choose a different box to move to');
  var dst = this.ensureBox_(p.to, src.sku);
  return this.move({ id: p.id, type: src.type === 'TOTE' ? 'RESTOCK' : 'TRANSFER', loc: src.loc, to_loc: dst.loc, qty: p.qty, force: p.force, mechanic: p.mechanic, note: p.note, device: p.device });
};

/** Pieces from a scale reading.  Returns null when the part has no weight per piece. */
function piecesFromGrams_(grams, weightG) {
  var g = Number(grams), w = Number(weightG);
  if (!(w > 0) || !(g >= 0)) return null;
  return Math.round(g / w);
}

Core.prototype.history = function (p) {
  var n = Math.min(num_(p.limit) || 50, 500);
  var rows = this.s.tail('Movements', p.sku || p.loc ? 3000 : n);
  if (p.sku) rows = rows.filter(function (r) { return r.sku === p.sku; });
  if (p.loc) rows = rows.filter(function (r) { return r.from_loc === p.loc || r.to_loc === p.loc; });
  return { ok: true, rows: rows.slice(-n).reverse() };
};

/** Names shown on the sign-in screen (active people only). */
Core.prototype.staffNames = function () {
  var names = this.s.rows('Staff').filter(function (r) { return r.name && r.pin_hash && isActive_(r); })
    .map(function (r) { return String(r.name).trim(); });
  names.sort(function (a, b) { return a.localeCompare(b); });
  return { ok: true, names: names };
};

Core.prototype.findStaff_ = function (name) {
  var want = String(name || '').trim().toLowerCase(), rows = this.s.rows('Staff');
  for (var i = 0; i < rows.length; i++) if (String(rows[i].name).trim().toLowerCase() === want) return rows[i];
  return null;
};

/** p = {name, role, pin_hash}.  The transport turns the typed PIN into pin_hash before this runs. */
Core.prototype.addStaff = function (p) {
  var name = String(p.name || '').trim();
  if (!name) fail_('Enter a name');
  if (name.length > 40 || /[:,]/.test(name)) fail_('Use a short name without : or ,');
  if (name.toLowerCase() === ADMIN_NAME.toLowerCase()) fail_('"' + ADMIN_NAME + '" is reserved. Pick another name.');
  if (this.findStaff_(name)) fail_(name + ' already exists. Use Reset PIN instead.');
  if (!ROLES[p.role]) fail_('Choose mechanic or supervisor');
  if (!p.pin_hash) fail_('Enter a PIN of 4 to 8 digits');
  this.s.append('Staff', { name: name, pin_hash: p.pin_hash, role: p.role, active: 'yes' });
  this.s.bump();
  return { ok: true, version: this.s.version() };
};

/** p = {name, role?, active?, pin_hash?}.  Reset a PIN, change a role, disable or enable a person. */
Core.prototype.setStaff = function (p, who) {
  var row = this.findStaff_(p.name);
  if (!row) fail_('No staff member called ' + p.name);
  var patch = {};
  if (p.role !== undefined) { if (!ROLES[p.role]) fail_('Choose mechanic or supervisor'); patch.role = p.role; }
  if (p.active !== undefined) patch.active = p.active ? 'yes' : 'no';
  if (p.pin_hash) patch.pin_hash = p.pin_hash;
  var self = who && String(who.name).toLowerCase() === String(row.name).trim().toLowerCase();
  if (self && (patch.active === 'no' || patch.role === 'mechanic')) fail_('You cannot disable yourself or remove your own supervisor role. Ask another supervisor.');
  if (!Object.keys(patch).length) fail_('Nothing to change');
  this.s.update('Staff', row, patch);
  this.s.bump();
  return { ok: true, version: this.s.version() };
};

/**
 * Single entry point used by every transport (Apps Script and demo).
 * who = {name, role} of the signed-in person, already checked by the transport.
 * The names in the log always come from who, never from the request, so nobody can log under someone else's name.
 */
Core.prototype.handle = function (op, p, who) {
  p = p || {};
  if (op === 'staffNames') return this.staffNames();
  if (!who || !who.name) fail_('Please sign in', { code: 'AUTH' });
  if (SUPERVISOR_OPS[op] && who.role !== 'supervisor') fail_('Only a supervisor can do this', { code: 'ROLE' });
  p.mechanic = who.name; p.counter = who.name; p.by = who.name;
  switch (op) {
    case 'whoami': return { ok: true, name: who.name, role: who.role };
    case 'snapshot': return this.snapshot();
    case 'version': return { version: this.s.version() };
    case 'move': return this.move(p);
    case 'putAway': return this.putAway(p);
    case 'moveStock': return this.moveStock(p);
    case 'count': return this.count(p);
    case 'resolveCount': return this.resolveCount(p);
    case 'saveLocation': return this.saveLocation(p);
    case 'saveLocations': return this.saveLocations(p);
    case 'savePart': return this.savePart(p, who);
    case 'history': return this.history(p);
    case 'addStaff': return this.addStaff(p);
    case 'setStaff': return this.setStaff(p, who);
  }
  fail_('Unknown request ' + op);
};

if (typeof module !== 'undefined') module.exports = { piecesFromGrams_: piecesFromGrams_, Core: Core, TABLES: TABLES, MOVE_TYPES: MOVE_TYPES, ADMIN_NAME: ADMIN_NAME, ROLES: ROLES, SUPERVISOR_OPS: SUPERVISOR_OPS, PUBLIC_OPS: PUBLIC_OPS, pinOk_: pinOk_, staffKey_: staffKey_, matchStaff_: matchStaff_, isActive_: isActive_ };
