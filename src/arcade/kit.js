import * as THREE from "../../vendor/three/three.module.js";

/**
 * A small drawing kit for the arcade, on the same three.js layer and the same
 * build plane the blocks live on — so a falling piece or a brick is the same
 * glowing, edge-lit solid a hand-drawn block is, and a game looks like part of
 * the app rather than a canvas bolted on top of it.
 *
 * It is not the Block class. A game spawns and throws away hundreds of meshes a
 * minute (bullets, sparks, cleared rows), so geometry and materials here are
 * SHARED and cached by colour: making a mesh costs an object, not a GPU upload.
 * Everything is placed in world units on z = 0 with its front face on the
 * plane, exactly as scene.js places a block.
 */

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  circle: new THREE.CylinderGeometry(0.5, 0.5, 1, 32).rotateX(Math.PI / 2),
  triangle: (() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.5); s.lineTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  })(),
  diamond: (() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.5); s.lineTo(-0.5, 0); s.lineTo(0, -0.5); s.lineTo(0.5, 0); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  })(),
};
const EDGES = Object.fromEntries(Object.entries(GEO).map(([k, g]) => [k, new THREE.EdgesGeometry(g, 20)]));
const RING = new THREE.RingGeometry(0.78, 1, 40);
const DISC = new THREE.CircleGeometry(1, 32);
const PLANE = new THREE.PlaneGeometry(1, 1);

export const KINDS = ["box", "circle", "triangle"];

const bodyCache = new Map();
const edgeCache = new Map();
const flatCache = new Map();

/** Same recipe as the edge colour in scene.js: most of the way to white. */
const lighten = (hex, amount = 0.6) => {
  const mix = (shift) => {
    const c = (hex >> shift) & 0xff;
    return Math.round(c + (255 - c) * amount) << shift;
  };
  return mix(16) | mix(8) | mix(0);
};

function bodyMat(color, style) {
  const k = `${color}:${style}`;
  let m = bodyCache.get(k);
  if (!m) {
    const ghost = style === "ghost";
    const bright = style === "bright";
    m = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: ghost ? 0.2 : bright ? 1.1 : 0.55,
      transparent: true,
      opacity: ghost ? 0.12 : bright ? 0.85 : 0.5,
      roughness: 0.35,
      metalness: 0,
      depthWrite: !ghost,
    });
    bodyCache.set(k, m);
  }
  return m;
}

function edgeMat(color, style) {
  const k = `${color}:${style}`;
  let m = edgeCache.get(k);
  if (!m) {
    m = new THREE.LineBasicMaterial({
      color: style === "bright" ? 0xffffff : lighten(color),
      transparent: true,
      opacity: style === "ghost" ? 0.45 : 0.95,
    });
    edgeCache.set(k, m);
  }
  return m;
}

function flatMat(color, opacity = 1) {
  const k = `${color}:${opacity}`;
  let m = flatCache.get(k);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    flatCache.set(k, m);
  }
  return m;
}

export function makeKit(scene) {
  const root = new THREE.Group();
  scene.add(root);

  const particles = [];
  const owned = [];          // per-instance geometries to dispose on clear
  const cursorPool = [];
  let cursorUsed = 0;

  /**
   * A glowing solid. `kind` is box | circle | triangle | diamond.
   * @returns {THREE.Mesh} with `userData.kind/color/style` so it can be restyled.
   */
  function shape(kind = "box", color = 0x7cf0c4, { w = 1, h = 1, d = null, style = "solid", parent = root } = {}) {
    const k = GEO[kind] ? kind : "box";
    const mesh = new THREE.Mesh(GEO[k], bodyMat(color, style));
    const edges = new THREE.LineSegments(EDGES[k], edgeMat(color, style));
    mesh.add(edges);
    mesh.userData = { kind: k, color, style, edges };
    size(mesh, w, h, d);
    parent.add(mesh);
    return mesh;
  }

  /** Resize keeping the front face on the plane. */
  function size(mesh, w, h, d = null) {
    const depth = d ?? Math.min(w, h) * 0.75;
    mesh.scale.set(Math.max(w, 1e-3), Math.max(h, 1e-3), Math.max(depth, 1e-3));
    mesh.position.z = -depth / 2;
  }

  function style(mesh, color = mesh.userData.color, st = mesh.userData.style) {
    if (mesh.userData.color === color && mesh.userData.style === st) return;
    mesh.userData.color = color;
    mesh.userData.style = st;
    mesh.material = bodyMat(color, st);
    mesh.userData.edges.material = edgeMat(color, st);
  }

  function remove(obj) {
    if (!obj) return;
    obj.parent?.remove(obj);
  }

  /** An outline rectangle on the plane — well walls, fields, borders. */
  function rect(x, y, w, h, color = 0xffffff, opacity = 0.55) {
    const pts = [
      [x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2],
    ];
    return polyline([...pts, pts[0]], color, opacity);
  }

  function polyline(points, color = 0xffffff, opacity = 0.55) {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map(([px, py]) => new THREE.Vector3(px, py, 0.01)));
    owned.push(geo);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    owned.push(line.material);
    root.add(line);
    return line;
  }

  /** Separate dashes, e.g. Pong's centre line. */
  function dashes(x0, y0, x1, y1, n = 12, color = 0xffffff, opacity = 0.35) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n, b = (i + 0.5) / n;
      pts.push(new THREE.Vector3(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, 0.01));
      pts.push(new THREE.Vector3(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 0.01));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    owned.push(geo);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    owned.push(mat);
    const seg = new THREE.LineSegments(geo, mat);
    root.add(seg);
    return seg;
  }

  /** A flat ring on the plane — shields, cursors, targets. */
  function ring(x, y, r, color = 0xffffff, opacity = 0.8) {
    const m = new THREE.Mesh(RING, flatMat(color, opacity));
    m.position.set(x, y, 0.02);
    m.scale.set(r, r, 1);
    root.add(m);
    return m;
  }

  /** A flat, dim backing behind a play area, so pieces read over a busy room. */
  function panel(x, y, w, h, color = 0x0b1016, opacity = 0.28) {
    const m = new THREE.Mesh(PLANE, flatMat(color, opacity));
    // Pushed back behind every solid, then grown by exactly the perspective
    // shrink that depth costs, so it still lines up with the outline on z = 0.
    const z = -1.2;
    const k = (scene.camera.position.z - z) / scene.camera.position.z;
    m.position.set(x * k, y * k, z);
    m.scale.set(w * k, h * k, 1);
    root.add(m);
    return m;
  }

  function disc(x, y, r, color = 0xffffff, opacity = 0.3) {
    const m = new THREE.Mesh(DISC, flatMat(color, opacity));
    m.position.set(x, y, 0.015);
    m.scale.set(r, r, 1);
    root.add(m);
    return m;
  }

  // ---- particles ---------------------------------------------------------

  /** A burst of little glowing chips flying out from a point. */
  function burst(x, y, color = 0xffffff, n = 14, { speed = 4, size: s = 0.12, life = 0.6, kind = "box" } = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      const mesh = shape(kind, color, { w: s, h: s, style: "bright" });
      mesh.position.x = x;
      mesh.position.y = y;
      particles.push({
        mesh, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (Math.random() - 0.5) * 12,
        life, age: 0, s,
      });
    }
  }

  function update(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        remove(p.mesh);
        particles.splice(i, 1);
        continue;
      }
      p.vy -= 6 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.rotation.z += p.spin * dt;
      const k = 1 - p.age / p.life;
      p.mesh.scale.set(p.s * k, p.s * k, p.s * k);
    }
  }

  // ---- hand cursors ------------------------------------------------------
  //
  // Games redraw these every frame: begin, add one per hand that matters,
  // end. Pooled, because they would otherwise be created 60 times a second.

  function beginCursors() { cursorUsed = 0; }

  function cursor(x, y, { color = 0xffffff, r = 0.28, opacity = 0.85 } = {}) {
    let c = cursorPool[cursorUsed];
    if (!c) {
      c = new THREE.Mesh(RING, flatMat(color, opacity));
      cursorPool.push(c);
    }
    if (!c.parent) root.add(c);
    c.material = flatMat(color, opacity);
    c.position.set(x, y, 0.05);
    c.scale.set(r, r, 1);
    c.visible = true;
    cursorUsed++;
    return c;
  }

  function endCursors() {
    for (let i = cursorUsed; i < cursorPool.length; i++) cursorPool[i].visible = false;
  }

  // ---- screen mapping ----------------------------------------------------

  /** World point on the plane -> CSS pixels of the full-window stage. */
  function toCss(x, y) {
    const rect = scene.canvas.getBoundingClientRect();
    return {
      x: rect.left + (x / scene.planeW + 0.5) * rect.width,
      y: rect.top + (0.5 - y / scene.planeH) * rect.height,
    };
  }

  /** Clear everything the current game drew. Shared caches survive. */
  function clear() {
    for (const p of particles) remove(p.mesh);
    particles.length = 0;
    for (const child of [...root.children]) root.remove(child);
    for (const o of owned) o.dispose?.();
    owned.length = 0;
    cursorPool.length = 0;
    cursorUsed = 0;
    root.visible = true;
  }

  return {
    root, shape, size, style, remove, rect, polyline, dashes, ring, disc, panel, burst, update,
    beginCursors, cursor, endCursors, toCss, clear,
    get w() { return scene.planeW; },
    get h() { return scene.planeH; },
    /** The part of the plane not under the top bar or the help strip. */
    get safe() {
      const H = scene.planeH, W = scene.planeW;
      return { top: H / 2 - H * 0.14, bottom: -H / 2 + H * 0.09, left: -W / 2, right: W / 2 };
    },
  };
}

/** Player palettes for the arcade, readable on a webcam image. */
export const COLORS = {
  mint: 0x7cf0c4, sky: 0x66d9ff, amber: 0xffc464, violet: 0xc98cff, rose: 0xff8fb1,
  red: 0xff5a6e, lime: 0xc4f75e, orange: 0xffa24c, blue: 0x6a9cff, white: 0xf2f6ff, gold: 0xffe066,
};

/** The colour a shape kind always has in the arcade, so it can be read at a glance. */
export const KIND_COLOR = { box: COLORS.mint, circle: COLORS.sky, triangle: COLORS.amber };
