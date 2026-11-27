/* Inventory/Stocks - "Walk there in 3D".
 * Builds the workshop in 3D from the workshop map (racks, walls, benches ... and the entrance), then a figure walks
 * from outside the entrance along the same route as the map (walkPath), stops in front of the rack, turns to it and
 * points at the box, which glows yellow.  The camera follows just behind him, like a game.
 *
 * Needs three.js (loaded by app.js only when this is opened).  Plain ES5 so it runs on older phones.
 *
 * Walk3D.open({
 *   map, path,                 the workshop map (metres, y down) and the route [[x,y] ...] from walkPath()
 *   rack, layers,              the target rack and its shelves bottom first [{t: 'BIN'|'TOTE', n}]
 *   shelf, slot, code,         the target box: shelf from the bottom, box from the left, its label
 *   rackLabel, rackColor,      what the rack's sign says and its model colour
 *   partName, things,          the part's name, and THINGS from app.js (names, sizes, colours of map objects)
 *   rackStyle(r)               -> {label, color} for every rack's sign
 * })
 */
(function () {
  'use strict';
  var T = null;   // THREE
  var CEIL = 3.4, LAMP = 0xffd99a, WARM = 0xffc56e;
  var HEIGHT = { wall: 2.9, bench: 0.9, machine: 1.6, pillar: CEIL, table: 0.75, chair: 0.9, tools: 1.8, trolley: 1.0, dmgbin: 0.8, trash: 0.7,
    boxes: 1.0, hydrant: 1.1, extinguisher: 0.6, scootC1: 1.1, scoot400: 1.1, ebike: 1.1 };
  var state = null;

  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hex(c) { return typeof c === 'number' ? c : parseInt(String(c || '#888888').replace('#', ''), 16); }

  /* map (x right, y down, angle a clockwise in degrees) -> three.js (x, z), rotation.y = -a */
  function world(it, lx, ly) { var a = (it.a || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [it.x + lx * c - ly * s, it.y + lx * s + ly * c]; }
  function frontNormal(it) { var a = (it.a || 0) * Math.PI / 180; return [-Math.sin(a), Math.cos(a)]; }   // the rack's front side

  function label(text, bg, fg, w, h, size) {
    var c = document.createElement('canvas'); c.width = w || 256; c.height = h || 128; var g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.fillStyle = fg;
    g.font = '900 ' + (size || 80) + 'px "Hanken Grotesk", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    var s = size || 80; while (g.measureText(text).width > c.width - 24 && s > 20) { s -= 4; g.font = '900 ' + s + 'px "Hanken Grotesk", Arial, sans-serif'; }
    g.fillText(text, c.width / 2, c.height / 2 + 4);
    var t = new T.CanvasTexture(c); t.anisotropy = 4; return t;
  }

  function build(o) {
    var m = o.map, scene = new T.Scene(), BG = 0xeef3f9;
    scene.background = new T.Color(BG); scene.fog = new T.Fog(BG, 12, Math.max(30, Math.hypot(m.W, m.H) * 2));
    scene.add(new T.AmbientLight(0xfff4e6, 0.5)); scene.add(new T.HemisphereLight(0xffffff, 0xcfe0f5, 0.3));
    var sun = new T.DirectionalLight(0xffffff, 0.3); sun.position.set(m.W / 2 + 4, 10, m.H / 2 + 6); scene.add(sun);
    var L = function (c) { return new T.MeshLambertMaterial({ color: hex(c) }); }, B = function (c) { return new T.MeshBasicMaterial({ color: hex(c) }); };
    var add = function (geo, mat, x, y, z, ry) { var mm = new T.Mesh(geo, mat); mm.position.set(x, y, z); if (ry) mm.rotation.y = ry; scene.add(mm); return mm; };

    // floor inside and outside, ceiling
    var fl = add(new T.PlaneGeometry(m.W + 40, m.H + 40), L(0xf3f6fa), m.W / 2, 0, m.H / 2); fl.rotation.x = -Math.PI / 2;
    var grid = new T.GridHelper(Math.ceil(Math.max(m.W, m.H)) + 2, (Math.ceil(Math.max(m.W, m.H)) + 2) * 2, 0xdbe4ee, 0xdbe4ee); grid.position.set(m.W / 2, 0.004, m.H / 2); scene.add(grid);
    var ce = add(new T.PlaneGeometry(m.W, m.H), B(0xf6f1e8), m.W / 2, CEIL, m.H / 2); ce.rotation.x = Math.PI / 2;

    // outer walls with a gap for the entrance; blue stripe inside
    var d = m.door || { x: 0.1, y: m.H / 2, w: 1, a: 270 }, dw = Math.max(0.9, d.w || 1);
    var wallM = L(0xf7f9fc), frontM = B(0xd3deec), blue = L(0x1e6fd9);
    var sides = [
      { x1: 0, y1: 0, x2: m.W, y2: 0 }, { x1: m.W, y1: 0, x2: m.W, y2: m.H },
      { x1: m.W, y1: m.H, x2: 0, y2: m.H }, { x1: 0, y1: m.H, x2: 0, y2: 0 }
    ];
    var doorSide = -1, best = 1e9;
    sides.forEach(function (s, i) {   // the wall closest to the entrance gets the opening
      var dist = s.x1 === s.x2 ? Math.abs(d.x - s.x1) : Math.abs(d.y - s.y1); if (dist < best) { best = dist; doorSide = i; }
    });
    sides.forEach(function (s, i) {
      var len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1), ux = (s.x2 - s.x1) / len, uy = (s.y2 - s.y1) / len;
      var cuts = [[0, len]];
      if (i === doorSide) { var t = (d.x - s.x1) * ux + (d.y - s.y1) * uy; cuts = [[0, Math.max(0, t - dw / 2)], [Math.min(len, t + dw / 2), len]]; }
      cuts.forEach(function (c) {
        var l = c[1] - c[0]; if (l < 0.05) return; var mx = s.x1 + ux * (c[0] + l / 2), my = s.y1 + uy * (c[0] + l / 2), ry = -Math.atan2(uy, ux);
        add(new T.BoxGeometry(l, CEIL, 0.18), i === doorSide ? frontM : wallM, mx, CEIL / 2, my, ry);
        add(new T.BoxGeometry(l, 0.2, 0.22), blue, mx, 1.05, my, ry);
      });
      if (i === doorSide) {   // lintel, blue frame, ENTRANCE sign outside, warm lamp
        var tt = (d.x - s.x1) * ux + (d.y - s.y1) * uy, cx = s.x1 + ux * tt, cy = s.y1 + uy * tt, ry2 = -Math.atan2(uy, ux), DH = 2.4;
        add(new T.BoxGeometry(dw, CEIL - DH, 0.18), frontM, cx, DH + (CEIL - DH) / 2, cy, ry2);
        [-1, 1].forEach(function (k) { add(new T.BoxGeometry(0.1, DH, 0.26), blue, cx + ux * k * dw / 2, DH / 2, cy + uy * k * dw / 2, ry2); });
        add(new T.BoxGeometry(dw + 0.2, 0.1, 0.26), blue, cx, DH, cy, ry2);
        var outN = [-(world(d, 0, 1)[0] - d.x), -(world(d, 0, 1)[1] - d.y)];   // outside = away from the inside of the door
        var sign = add(new T.PlaneGeometry(1.6, 0.4), new T.MeshBasicMaterial({ map: label('ENTRANCE', '#1e6fd9', '#ffffff', 512, 128, 70) }), cx + outN[0] * 0.11, DH + 0.42, cy + outN[1] * 0.11);
        sign.rotation.y = Math.atan2(outN[0], outN[1]);
        add(new T.CylinderGeometry(0.18, 0.22, 0.07, 16), B(LAMP), cx + outN[0] * 0.4, DH + 0.85, cy + outN[1] * 0.4);
        var ol = new T.PointLight(WARM, 0.9, 7, 1.6); ol.position.set(cx + outN[0] * 1.1, DH + 0.6, cy + outN[1] * 1.1); scene.add(ol);
      }
    });

    // warm ceiling lamps, a few real lights for pools of light
    var nL = 0;
    for (var lx = 2; lx < m.W; lx += 4) for (var lz = 2; lz < m.H; lz += 4) {
      add(new T.CylinderGeometry(0.26, 0.3, 0.07, 18), B(LAMP), lx, CEIL - 0.05, lz);
      if (nL < 8 && ((lx + lz) / 2) % 2 === 0) { var pl = new T.PointLight(WARM, 0.75, 9, 1.5); pl.position.set(lx, CEIL - 0.4, lz); scene.add(pl); nL++; }
    }

    // map objects: walls, benches, machines ... as simple solids in their own colour; floor areas as flat patches
    (m.items || []).forEach(function (it) {
      var th = (o.things || {})[it.kind] || {}; if (it.kind === 'label') return;
      var ry = -(it.a || 0) * Math.PI / 180, w = Math.max(0.1, it.w || th.w || 1), dd = Math.max(0.1, it.d || th.d || 1);
      if (th.walk) { var pa = add(new T.PlaneGeometry(w, dd), L(th.fill || '#e3f2fd'), it.x, 0.008, it.y); pa.rotation.x = -Math.PI / 2; pa.rotation.z = (it.a || 0) * Math.PI / 180; return; }
      var h = HEIGHT[it.kind] || 1.2, col = it.kind === 'wall' ? 0xf7f9fc : th.fill;
      add(new T.BoxGeometry(w, h, dd), L(col), it.x, h / 2, it.y, ry);
    });

    // racks: uprights, shelves, blue bins / white boxes per shelf, a sign in the model colour
    var up = L(0x1858b8), board = L(0xe8eef6), binM = L(0x2f80ea), toteM = L(0xffffff);
    var target = null;
    (m.racks || []).forEach(function (r) {
      var g = new T.Group(); g.position.set(r.x, 0, r.y); g.rotation.y = -(r.a || 0) * Math.PI / 180; scene.add(g);
      var lay = r === o.rack ? o.layers : (r.layers && r.layers.length ? r.layers : (function () { var a = []; for (var i = 0; i < Math.max(1, r.shelves || 1); i++) a.push({ t: 'BIN', n: Math.max(1, r.slots || 1) }); return a; })());
      var w = Math.max(0.4, r.w), dd = Math.max(0.3, r.d), sh = 0.46, H = 0.25 + lay.length * sh + 0.15;
      var gadd = function (geo, mat, x, y, z) { var mm = new T.Mesh(geo, mat); mm.position.set(x, y, z); g.add(mm); return mm; };
      var lines = [];   // black outlines of every box and shelf on this rack
      var outline = function (geo, x, y, z) { var e = new T.EdgesGeometry(geo).attributes.position.array; for (var q = 0; q < e.length; q += 3) lines.push(e[q] + x, e[q + 1] + y, e[q + 2] + z); };
      [-1, 1].forEach(function (sx) { [-1, 1].forEach(function (sz) { gadd(new T.BoxGeometry(0.06, H, 0.06), up, sx * w / 2, H / 2, sz * dd / 2); }); });
      lay.forEach(function (ly, si) {
        var y = 0.22 + si * sh, bgeo = new T.BoxGeometry(w, 0.04, dd); gadd(bgeo, board, 0, y, 0); outline(bgeo, 0, y, 0);
        var n = Math.max(1, ly.n), bw = w / n;
        for (var i = 1; i <= n; i++) {
          var bx = -w / 2 + bw * (i - 0.5), hit = r === o.rack && si + 1 === o.shelf && i === o.slot;
          var bgeo2 = new T.BoxGeometry(bw * 0.84, ly.t === 'TOTE' ? 0.34 : 0.3, dd * 0.82);
          var b = gadd(bgeo2, hit ? new T.MeshBasicMaterial({ color: 0xffe600 }) : ly.t === 'TOTE' ? toteM : binM, bx, y + 0.18, 0.02);
          if (hit) b.add(new T.LineSegments(new T.EdgesGeometry(bgeo2), new T.LineBasicMaterial({ color: 0x111111 })));   // shows with the glow
          else outline(bgeo2, bx, y + 0.18, 0.02);
          if (hit) { target = { mesh: b, local: [bx, y + 0.18] }; b.visible = false; }
        }
      });
      var lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(lines, 3));
      g.add(new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0x1a1d22 })));
      var st = o.rackStyle ? o.rackStyle(r) : { label: r.id, color: '#1e6fd9' };
      var tex = label(String(st.label || r.id), st.color || '#1e6fd9', '#ffffff');
      [1, -1].forEach(function (side) { var s = gadd(new T.PlaneGeometry(Math.min(1.3, w * 0.8), Math.min(0.65, w * 0.4)), new T.MeshBasicMaterial({ map: tex }), 0, H + 0.4, side * (dd / 2 + 0.01)); if (side < 0) s.rotation.y = Math.PI; });
    });

    return { scene: scene, target: target };
  }

  /* the walker: a dark figure with hips, knees, shoulders and elbows */
  function makeMan(scene) {
    var sil = new T.MeshLambertMaterial({ color: 0x1b2230, emissive: 0x0a0d14 });
    var ball = function (r) { return new T.Mesh(new T.SphereGeometry(r, 14, 10), sil); };
    var bone = function (len, r0, r1) {
      var g = new T.Group(), rod = new T.Mesh(new T.CylinderGeometry(r0, r1, len, 12), sil); rod.position.y = -len / 2; g.add(rod, ball(r0));
      var end = new T.Group(); end.position.y = -len; end.add(ball(r1)); g.add(end); return { g: g, end: end };
    };
    var man = new T.Group(), torso = new T.Group(), HIP = 0.92; man.add(torso);
    var add = function (mesh, y, x) { mesh.position.set(x || 0, y, 0); torso.add(mesh); return mesh; };
    add(new T.Mesh(new T.CylinderGeometry(0.135, 0.09, 0.5, 14), sil), HIP + 0.28);
    add(new T.Mesh(new T.CylinderGeometry(0.1, 0.11, 0.12, 14), sil), HIP + 0.02);
    var shb = add(new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 0.34, 12), sil), HIP + 0.5); shb.rotation.z = Math.PI / 2;
    add(ball(0.065), HIP + 0.5, -0.17); add(ball(0.065), HIP + 0.5, 0.17);
    add(new T.Mesh(new T.CylinderGeometry(0.04, 0.045, 0.1, 10), sil), HIP + 0.58);
    var head = add(ball(0.125), HIP + 0.75); head.scale.set(0.92, 1.08, 1);
    var leg = function (x) {
      var hip = new T.Group(); hip.position.set(x, HIP, 0); var th = bone(0.45, 0.062, 0.05); hip.add(th.g);
      var knee = new T.Group(); th.end.add(knee); var shin = bone(0.42, 0.05, 0.04); knee.add(shin.g);
      var foot = new T.Mesh(new T.BoxGeometry(0.09, 0.05, 0.22), sil); foot.position.set(0, -0.025, 0.06); shin.end.add(foot);
      man.add(hip); return { hip: hip, knee: knee };
    };
    var arm = function (x) {
      var sh = new T.Group(); sh.position.set(x, HIP + 0.5, 0); sh.rotation.z = x < 0 ? 0.08 : -0.08;
      var u = bone(0.3, 0.045, 0.038); sh.add(u.g); var elbow = new T.Group(); u.end.add(elbow);
      var f = bone(0.27, 0.038, 0.032); elbow.add(f.g); var hand = ball(0.045); hand.position.y = -0.02; f.end.add(hand);
      torso.add(sh); return { sh: sh, elbow: elbow };
    };
    var o = { man: man, torso: torso, HIP: HIP, LL: leg(-0.085), LR: leg(0.085), AL: arm(-0.19), AR: arm(0.19) };
    var shadow = new T.Mesh(new T.CircleGeometry(0.36, 24), new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 }));
    shadow.rotation.x = -Math.PI / 2; scene.add(man, shadow); o.shadow = shadow;
    return o;
  }

  function open(o) {
    if (!window.THREE) throw new Error('3D library not loaded');
    T = window.THREE; close();
    var box = el('<div class="w3d" role="dialog" aria-label="Walk there in 3D"><div class="w3d-top"><b>' + esc(o.rackLabel ? 'Rack ' + o.rackLabel + ' · shelf ' + o.shelf + ' · box ' + o.slot : 'Walk there') + '</b>' +
      '<span class="mono">' + esc(o.code || '') + '</span><button type="button" class="w3d-x" aria-label="Close">✕</button></div>' +
      '<div class="w3d-hud"><div class="w3d-step"></div><button type="button" class="w3d-again">↻ Walk again</button></div></div>');
    document.body.appendChild(box);
    var renderer;
    try { renderer = new T.WebGLRenderer({ antialias: true }); } catch (e) { box.remove(); throw new Error('This phone cannot show 3D'); }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); box.insertBefore(renderer.domElement, box.firstChild);
    var built = build(o), scene = built.scene, camera = new T.PerspectiveCamera(60, 1, 0.1, 120), F = makeMan(scene);
    var glowMesh = built.target ? built.target.mesh : null;
    var spot = new T.SpotLight(0xffd28a, 0, 7, 0.42, 0.5, 1.2); scene.add(spot); scene.add(spot.target);
    var step = box.querySelector('.w3d-step'), say = function (h) { step.innerHTML = h; };

    // route: start a few steps outside the entrance, then the map's own route
    var d = o.map.door, outside = world(d, 0, -1.8), pts = [outside].concat(o.path || []);
    var P = pts.map(function (p) { return new T.Vector3(p[0], 0, p[1]); }), seg = [], len = 0;
    for (var i = 1; i < P.length; i++) { var dl = P[i].distanceTo(P[i - 1]); seg.push(dl); len += dl; }
    var at = function (dd) {
      for (var k = 0; k < seg.length; k++) { if (dd <= seg[k] || k === seg.length - 1) { var f = seg[k] ? Math.min(1, dd / seg[k]) : 1; return { pos: P[k].clone().lerp(P[k + 1], f), dir: P[k + 1].clone().sub(P[k]).normalize() }; } dd -= seg[k]; }
      return { pos: P[P.length - 1].clone(), dir: new T.Vector3(0, 0, 1) };
    };
    var nrm = frontNormal(o.rack), faceYaw = Math.atan2(-nrm[0], -nrm[1]);
    // the camera at the end: behind the walker and to his side, as far back as the aisle allows (never inside a rack or wall)
    var solids = (o.map.racks || []).concat((o.map.items || []).filter(function (it) { return !((o.things || {})[it.kind] || {}).walk && it.kind !== 'label'; }));
    var inside = function (x, z) {
      if (x < 0.25 || z < 0.25 || x > o.map.W - 0.25 || z > o.map.H - 0.25) return true;
      return solids.some(function (it) { var a = (it.a || 0) * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a), dx = x - it.x, dz = z - it.y;
        return Math.abs(dx * c + dz * s2) <= (it.w || 1) / 2 + 0.25 && Math.abs(-dx * s2 + dz * c) <= (it.d || 1) / 2 + 0.25; });
    };
    var endCam = null;
    /* ---- camera that never ends up inside a wall or rack, and keeps a clear view ----
     * walls2: the room's outer walls as line pieces (the entrance is a gap).  A camera spot is good when it is
     * not inside anything and the straight line to what it looks at does not cross a wall or a rack. */
    var walls2 = (function () {
      var m = o.map, dd = m.door || { x: 0, y: 0, w: 1 }, dw = Math.max(0.9, dd.w || 1);
      var S = [[0, 0, m.W, 0], [m.W, 0, m.W, m.H], [m.W, m.H, 0, m.H], [0, m.H, 0, 0]], best = 1e9, ds = -1, out = [];
      S.forEach(function (q, i) { var di = q[0] === q[2] ? Math.abs(dd.x - q[0]) : Math.abs(dd.y - q[1]); if (di < best) { best = di; ds = i; } });
      S.forEach(function (q, i) {
        if (i !== ds) { out.push(q); return; }
        var ln = Math.hypot(q[2] - q[0], q[3] - q[1]), ux = (q[2] - q[0]) / ln, uy = (q[3] - q[1]) / ln, t = (dd.x - q[0]) * ux + (dd.y - q[1]) * uy;
        out.push([q[0], q[1], q[0] + ux * (t - dw / 2), q[1] + uy * (t - dw / 2)]); out.push([q[0] + ux * (t + dw / 2), q[1] + uy * (t + dw / 2), q[2], q[3]]);
      });
      return out;
    })();
    var crosses = function (ax, az, bx, bz, w) {
      var r = (bx - ax) * (w[3] - w[1]) - (bz - az) * (w[2] - w[0]); if (Math.abs(r) < 1e-9) return false;
      var t = ((w[0] - ax) * (w[3] - w[1]) - (w[1] - az) * (w[2] - w[0])) / r, u = ((w[0] - ax) * (bz - az) - (w[1] - az) * (bx - ax)) / r;
      return t > 0 && t < 1 && u > 0 && u < 1;
    };
    var inSolid = function (x, z, pad, skip) {
      return solids.some(function (it) { if (it === skip) return false; var a = (it.a || 0) * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a), dx = x - it.x, dz = z - it.y;
        return Math.abs(dx * c + dz * s2) <= (it.w || 1) / 2 + pad && Math.abs(-dx * s2 + dz * c) <= (it.d || 1) / 2 + pad; });
    };
    var nearWall = function (x, z) { return walls2.some(function (w) { var vx = w[2] - w[0], vz = w[3] - w[1], L2 = vx * vx + vz * vz || 1, t = Math.max(0, Math.min(1, ((x - w[0]) * vx + (z - w[1]) * vz) / L2)); return Math.hypot(x - w[0] - vx * t, z - w[1] - vz * t) < 0.3; }); };
    var clearLine = function (ax, az, bx, bz, skip) {
      for (var i = 0; i < walls2.length; i++) if (crosses(ax, az, bx, bz, walls2[i])) return false;
      var n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.12));
      for (var k = 1; k <= n; k++) if (inSolid(ax + (bx - ax) * k / n, az + (bz - az) * k / n, 0.1, skip)) return false;
      return true;
    };
    var camOk = function (x, z, tx, tz, skip) { return !inSolid(x, z, 0.25) && !nearWall(x, z) && clearLine(tx, tz, x, z, skip); };
    var HIGH = CEIL - 0.3;   // the high view: just under the ceiling, above every rack
    /** While walking: as far back as the view stays clear; in tight spots, the high view looking down ahead of him. */
    function chaseCam(pos, fwd) {
      var dists = [3.2, 2.7, 2.2, 1.8, 1.4];
      for (var k = 0; k < dists.length; k++) {
        var d2 = dists[k], cx = pos.x - fwd.x * d2, cz = pos.z - fwd.z * d2;
        if (camOk(cx, cz, pos.x, pos.z)) return { p: new T.Vector3(cx, 1.75 + (3.2 - d2) * 0.3, cz), look: pos.clone().addScaledVector(fwd, 5).setY(1.35), fov: (3.2 - d2) * 5 };
      }
      return { p: new T.Vector3(pos.x - fwd.x * 0.45, HIGH, pos.z - fwd.z * 0.45), look: pos.clone().addScaledVector(fwd, 2.4).setY(0.2), fov: 16, high: true };
    }
    /** At the box: behind him on the other side of his half step, with a clear line to the box; else the high view. */
    function endCamera(mp) {
      var side = [Math.cos(faceYaw), -Math.sin(faceYaw)], tries = [[2.6, 1.0], [2.2, 0.9], [1.9, 0.7], [1.6, 0.6], [1.3, 0.5]];
      var fx = binPos.x + nrm[0] * 0.35, fz = binPos.z + nrm[1] * 0.35;   // just in front of the box
      for (var k = 0; k < tries.length; k++) {   // the camera goes to the opposite side of his half step
        var cx = mp.x + nrm[0] * tries[k][0] - side[0] * tries[k][1], cz = mp.z + nrm[1] * tries[k][0] - side[1] * tries[k][1];
        if (!inside(cx, cz) && camOk(cx, cz, fx, fz, o.rack)) { var tight = Math.max(0, 2.6 - tries[k][0]); state.endFov = 58 + tight * 12; return new T.Vector3(cx, 1.85 + tight * 0.45, cz); }
      }
      // tight: from high above the aisle, looking down at the box
      var back = 1.1; while (back > 0.4 && (inSolid(mp.x + nrm[0] * back, mp.z + nrm[1] * back, 0.05) || nearWall(mp.x + nrm[0] * back, mp.z + nrm[1] * back))) back -= 0.15;
      state.endFov = 78; return new T.Vector3(mp.x + nrm[0] * back, HIGH, mp.z + nrm[1] * back);
    }
    var binW = o.rack && built.target ? world(o.rack, built.target.local[0], 0) : [P[P.length - 1].x, P[P.length - 1].z];
    var binPos = new T.Vector3(binW[0], built.target ? built.target.local[1] : 1, binW[1]);
    var tag = new T.Sprite(new T.SpriteMaterial({ map: label(o.code || '', '#ffe600', '#111111', 512, 128, 64), depthTest: false })); tag.scale.set(0.8, 0.2, 1); tag.visible = false; scene.add(tag);

    var phase, t0, dist, yaw, swing = 0, last = 0, camPos = new T.Vector3(), camLook = new T.Vector3(), alive = true;
    function start() {
      phase = 'door'; t0 = performance.now(); dist = 0; swing = 0; endCam = null; state.endFov = 0; fit();
      var a0 = at(0); yaw = Math.atan2(a0.dir.x, a0.dir.z); F.man.position.copy(a0.pos);
      var c0 = chaseCam(a0.pos, new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw))); camPos.copy(c0.p); camLook.copy(c0.look); state.walkFov = c0.fov;
      if (glowMesh) glowMesh.visible = false; tag.visible = false; spot.intensity = 0;
      say('Start at the <b>entrance door</b>.');
    }
    function tick(now) {
      if (!alive) return;
      var dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      if (phase === 'door' && now - t0 > 900) { phase = 'walk'; say('Walk in and follow the walkway to <b>Rack ' + esc(o.rackLabel) + '</b>.'); }
      if (phase === 'walk') {
        var speed = Math.max(1.6, len / 9); dist = Math.min(len, dist + speed * dt);
        var a = at(dist); F.man.position.copy(a.pos);
        var want = Math.atan2(a.dir.x, a.dir.z), dy = Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)); yaw += dy * Math.min(1, dt * 7);
        swing += dt * speed * 3.4;
        var fwd = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
        var cc = chaseCam(F.man.position, fwd);
        camPos.lerp(cc.p, Math.min(1, dt * (cc.high ? 2.2 : 3))); camLook.lerp(cc.look, Math.min(1, dt * 3.5));
        state.walkFov = cc.fov;
        if (dist >= len) { phase = 'turn'; t0 = now; say('This is <b>Rack ' + esc(o.rackLabel) + '</b>. Face it.'); }
      } else if (phase === 'turn' || phase === 'there') {
        var dy2 = Math.atan2(Math.sin(faceYaw - yaw), Math.cos(faceYaw - yaw)); yaw += dy2 * Math.min(1, dt * 5); swing *= 0.85;
        var mp = F.man.position, side = [Math.cos(faceYaw), -Math.sin(faceYaw)];
        if (!endCam) {   // arrived: half a step to the side so the box is not behind him, then the camera
          var sd = [Math.cos(faceYaw), -Math.sin(faceYaw)], stepTo = mp.clone().add(new T.Vector3(sd[0] * 0.5, 0, sd[1] * 0.5));
          if (!inside(stepTo.x, stepTo.z)) state.stepTo = stepTo; else state.stepTo = null;
          endCam = endCamera(mp);
        }
        if (state.stepTo) { F.man.position.lerp(state.stepTo, Math.min(1, dt * 3)); swing += dt * 2; }
        camPos.lerp(endCam, Math.min(1, dt * 2.4));
        var wantFov = Math.max(box.clientWidth < 520 ? 68 : 58, state.endFov || 0);   // (walking fov is handled below)
        if (Math.abs(camera.fov - wantFov) > 0.3) { camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 2.4); camera.updateProjectionMatrix(); }
        camLook.lerp(binPos.clone().setY(Math.max(0.9, binPos.y)), Math.min(1, dt * 3));
        if (phase === 'turn' && now - t0 > 1500) {
          phase = 'there'; if (glowMesh) glowMesh.visible = true;
          spot.position.set(binPos.x + nrm[0] * 1.4, CEIL - 0.2, binPos.z + nrm[1] * 1.4); spot.target.position.copy(binPos); spot.intensity = 2.2;
          tag.position.set(binPos.x + nrm[0] * 0.45, binPos.y + 0.33, binPos.z + nrm[1] * 0.45); tag.visible = true;
          say('Shelf <b>' + o.shelf + '</b> from the bottom, box <b>' + o.slot + '</b> from the left: <b class="mono">' + esc(o.code) + '</b>' + (o.partName ? ' · ' + esc(o.partName) : '') + '.');
        }
      }
      // walk cycle / pointing
      var wk = phase === 'walk' ? 1 : 0, ph = swing;
      var legF = function (Lg, p) { Lg.hip.rotation.x = -Math.sin(p) * 0.48 * wk; Lg.knee.rotation.x = (0.08 + Math.max(0, Math.cos(p + 0.35)) * 0.85) * wk + (1 - wk) * 0.04; };
      var armF = function (A, p) { A.sh.rotation.x = Math.sin(p) * 0.42 * wk; A.elbow.rotation.x = -(0.25 + Math.max(0, Math.sin(p)) * 0.35) * wk - (1 - wk) * 0.12; };
      legF(F.LL, ph); legF(F.LR, ph + Math.PI); armF(F.AL, ph);
      F.torso.rotation.y = Math.sin(ph) * 0.06 * wk; F.torso.rotation.x = 0.05 * wk;
      if (phase === 'there') {
        var lift = Math.max(0, Math.min(1, (now - t0 - 1500) / 500)), upA = Math.atan2(binPos.y - (F.HIP + 0.5), 1.45);
        F.AR.sh.rotation.x = -(Math.PI / 2 + upA) * lift; F.AR.elbow.rotation.x = -0.05 * lift;
        if (glowMesh) glowMesh.scale.setScalar(1 + Math.sin(now / 220) * 0.05);
      } else armF(F.AR, ph + Math.PI);
      F.man.position.y = wk ? Math.abs(Math.cos(swing)) * 0.03 - 0.015 : 0;
      F.man.rotation.y = yaw; F.shadow.position.set(F.man.position.x, 0.006, F.man.position.z);
      if (phase === 'walk' || phase === 'door') {
        var baseF = box.clientWidth < 520 ? 68 : 58, wf = baseF + (state.walkFov || 0);
        if (Math.abs(camera.fov - wf) > 0.3) { camera.fov += (wf - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
      }
      camera.position.copy(camPos); camera.lookAt(camLook);
      renderer.render(scene, camera);
      state.raf = requestAnimationFrame(tick);
    }
    var fit = function () { var w = box.clientWidth, h = box.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < 520 ? 68 : 58; camera.updateProjectionMatrix(); };
    state = { box: box, renderer: renderer, scene: scene, stop: function () { alive = false; } };
    var ro = window.ResizeObserver ? new ResizeObserver(fit) : null; if (ro) ro.observe(box); else window.addEventListener('resize', fit);
    state.ro = ro;
    box.querySelector('.w3d-x').onclick = close;
    state.key = function (e) { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', state.key);
    box.querySelector('.w3d-again').onclick = start;
    fit(); start(); state.raf = requestAnimationFrame(tick);
  }

  function close() {
    if (!state) return;
    state.stop(); cancelAnimationFrame(state.raf); if (state.ro) state.ro.disconnect(); if (state.key) document.removeEventListener('keydown', state.key);
    try { state.scene.traverse(function (x) { if (x.geometry) x.geometry.dispose(); if (x.material) { if (x.material.map) x.material.map.dispose(); x.material.dispose(); } }); state.renderer.dispose(); } catch (e) {}
    state.box.remove(); state = null;
  }

  window.Walk3D = { open: open, close: close };
})();
