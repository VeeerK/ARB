import * as THREE from "../vendor/three/three.module.js";
import { coverMapping, toPixels } from "./viewport.js";

/**
 * The 3D layer. Its only hard requirement is that a hand landmark and the pixel
 * it sits on in the video agree: a pinch at normalized (0.3, 0.6) must produce a
 * world point that renders exactly over the fingertips on screen. Everything
 * else in here is presentation.
 *
 * Two coordinate hops make that happen:
 *   1. `object-fit: cover` crop      — shared with the 2D overlay via viewport.js
 *   2. mirroring                     — the video is flipped in CSS, so x is 1-x
 * The three.js canvas is deliberately NOT CSS-mirrored (a negative scale flips
 * winding order and breaks lighting/culling), so the flip happens in the math.
 */

// Camera sits on +Z looking at the origin. Everything the hands build lives on
// the z = 0 plane, which is what BUILD_PLANE_Z names — a single depth means the
// noisy per-landmark z never has to be trusted for position.
const CAM_Z = 10;
const FOV = 45;
const BUILD_PLANE_Z = 0;

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAM_Z);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0x8fc7ff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x4aa8ff, 1.1);
    rim.position.set(-4, -2, 3);
    this.scene.add(rim);

    this.videoW = 0;
    this.videoH = 0;
    this._resize();
  }

  /** Frame dimensions change once the camera settles; keep the mapping current. */
  setVideoSize(w, h) {
    this.videoW = w;
    this.videoH = h;
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(Math.round(rect.width), 1);
    const h = Math.max(Math.round(rect.height), 1);
    if (this._w !== w || this._h !== h) {
      this._w = w;
      this._h = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    // Half-extents of the z = 0 plane in world units, for the unprojection below.
    this.planeH = 2 * Math.tan((FOV * Math.PI) / 360) * (CAM_Z - BUILD_PLANE_Z);
    this.planeW = this.planeH * (this._w / this._h);
    return { cssW: this._w, cssH: this._h };
  }

  /**
   * Normalized MediaPipe landmark coords -> a world point on the build plane,
   * landing under the same screen pixel the 2D overlay would draw it at.
   */
  toWorld(nx, ny) {
    const { cssW, cssH } = this._resize();
    const map = coverMapping(this.videoW, this.videoH, cssW, cssH);
    // The video is CSS-mirrored; this canvas is not, so mirror x here instead.
    const px = toPixels(map, this.videoW, this.videoH, 1 - nx, ny);
    return new THREE.Vector3(
      (px.x / cssW - 0.5) * this.planeW,
      -(px.y / cssH - 0.5) * this.planeH,
      BUILD_PLANE_Z,
    );
  }

  /**
   * How close a build-plane point is to the edge of the visible frame, as a
   * fraction of it: 0.5 is dead centre, 0 is exactly on an edge, negative is
   * past it. Lives here because the plane's extents do — they follow the FOV
   * and the window, so no caller can hard-code them.
   */
  edgeDistance(p) {
    this._resize();
    const fx = p.x / this.planeW + 0.5, fy = p.y / this.planeH + 0.5;
    return Math.min(fx, 1 - fx, fy, 1 - fy);
  }

  /**
   * The snap grid, drawn on the build plane. Lines fall on exact multiples of
   * `planeH / cells` from the origin — the same numbers Builder snaps to — so
   * the divider at x = 0 is a grid line too. Built once per cell count; the
   * plane's height never changes, only its width, and the grid is drawn far
   * wider than any window.
   */
  setGrid(visible, cells = 16) {
    if (!visible && !this.grid) return;
    if (!this.grid || this.gridCells !== cells) {
      if (this.grid) {
        this.scene.remove(this.grid);
        this.grid.geometry.dispose();
        this.grid.material.dispose();
      }
      const step = this.planeH / cells;
      const divisions = cells * 4;
      this.grid = new THREE.GridHelper(step * divisions, divisions, 0xffffff, 0xffffff);
      this.grid.rotation.x = Math.PI / 2;
      this.grid.position.z = BUILD_PLANE_Z;
      this.grid.material.transparent = true;
      this.grid.material.opacity = 0.2;
      this.grid.material.depthWrite = false;
      this.grid.renderOrder = -1;
      this.gridCells = cells;
      this.scene.add(this.grid);
    }
    this.grid.visible = visible;
  }

  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }

  render() {
    this._resize();
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Block colors, per theme. One theme per player, so in two-player mode you can
 * tell at a glance whose block is whose — which matters most right at the
 * divider, where the question "is that mine?" decides whether you may touch it.
 *
 * `doomed` is deliberately the SAME red in every theme: it means "this is about
 * to be deleted", and that warning must never be mistaken for someone's colour.
 */
const THEMES = {
  p1: {
    idle:   { body: 0x7cf0c4, edge: 0xd6fff0, glow: 0.45 },
    held:   { body: 0xffc464, edge: 0xfff0d0, glow: 0.75 },
    doomed: { body: 0xff5a6e, edge: 0xffd0d6, glow: 0.95 },
    ghost:  { body: 0x66d9ff, edge: 0xaeeaff },
  },
  p2: {
    idle:   { body: 0xc98cff, edge: 0xefdcff, glow: 0.5 },
    held:   { body: 0xffb0e6, edge: 0xffe2f6, glow: 0.8 },
    doomed: { body: 0xff5a6e, edge: 0xffd0d6, glow: 0.95 },
    ghost:  { body: 0xb08cff, edge: 0xdcc8ff },
  },
};

export const BLOCK_THEMES = Object.keys(THEMES);

/**
 * Every block currently on screen. Settings can change a theme at any moment —
 * including mid-game, with blocks standing — and a palette nobody can repaint
 * is a palette that only applies to blocks you have not drawn yet.
 */
const LIVE = new Set();

/** The edge is the body, most of the way to white: one colour in, two out. */
const lighten = (hex, amount = 0.62) => {
  const mix = (shift) => {
    const c = (hex >> shift) & 0xff;
    return Math.round(c + (255 - c) * amount) << shift;
  };
  return mix(16) | mix(8) | mix(0);
};

/**
 * Repaint one player's blocks.
 *
 * @param {"p1"|"p2"} name
 * @param {{idle?:number, held?:number, doomed?:number, ghost?:number}} colors
 *   Body colours only, as 0xRRGGBB. Edges and glow are derived, so a settings
 *   screen can offer three swatches instead of eight.
 */
export function setThemeColors(name, colors) {
  const theme = THEMES[name];
  if (!theme) return;
  for (const [state, body] of Object.entries(colors)) {
    if (!theme[state] || !Number.isFinite(body)) continue;
    theme[state] = { ...theme[state], body, edge: lighten(body) };
  }
  for (const block of LIVE) block.repaint();
}

/** The colours a theme is currently using, for the settings UI to read back. */
export const themeColors = (name) => {
  const t = THEMES[name] ?? THEMES.p1;
  return { idle: t.idle.body, held: t.held.body, doomed: t.doomed.body, ghost: t.ghost.body };
};

/**
 * One translucent glowing block: a solid body plus a bright wireframe on top,
 * because a purely translucent box loses its silhouette against a busy webcam
 * image. `setCorners` is the whole interface — hand two opposite corners of the
 * front face and it reshapes itself around them.
 */
/**
 * Every shape is built to fill the SAME unit box, centred on the origin and
 * one unit on every side. That is what lets one set of rules — draw, resize,
 * carry, turn, zoom, delete — drive all of them: `scale` means width, height
 * and depth whatever the shape is, and nothing downstream has to know which
 * one it is holding.
 *
 * Both prisms are built facing the camera and then baked, so `rotation.z`
 * stays free for the view-axis spin the hands drive.
 */
const GEOMETRY = {
  box: () => new THREE.BoxGeometry(1, 1, 1),

  // A disc: radius 0.5 in x and y, one unit deep. Cylinders are built standing
  // up the y axis, so it is laid down to face the camera.
  circle: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 48).rotateX(Math.PI / 2),

  // An extruded triangle. Built from an explicit outline rather than a
  // three-sided cylinder, because a 3-gon inscribed in a circle leaves the
  // unit box a third empty and the shape would not fill the corners your
  // fingers put it between.
  triangle: () => {
    const tri = new THREE.Shape();
    tri.moveTo(0, 0.5);
    tri.lineTo(-0.5, -0.5);
    tri.lineTo(0.5, -0.5);
    tri.closePath();
    return new THREE.ExtrudeGeometry(tri, { depth: 1, bevelEnabled: false })
      .translate(0, 0, -0.5);
  },
};

export const SHAPE_KINDS = Object.keys(GEOMETRY);

let UID = 0;

/** World axes, for `Block.turnWorld`. */
export const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Scratch for the hit tests, which run per block per frame.
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Block {
  constructor({ ghost = false, kind = "box", theme = "p1" } = {}) {
    // A stable identity that survives the mesh being thrown away and rebuilt.
    // Undo restores a deleted block as a NEW Block, and the history has to be
    // able to say "that one" about it afterwards.
    this.id = ++UID;
    this.ghost = ghost;
    this.kind = GEOMETRY[kind] ? kind : "box";
    this.theme = THEMES[theme] ? theme : "p1";
    const palette = THEMES[this.theme];
    const hue = ghost ? palette.ghost.body : palette.idle.body;
    this.geometry = GEOMETRY[this.kind]();
    this.material = new THREE.MeshPhysicalMaterial({
      color: hue,
      transparent: true,
      opacity: ghost ? 0.18 : 0.34,
      roughness: 0.25,
      metalness: 0.0,
      transmission: 0.35,
      emissive: hue,
      emissiveIntensity: ghost ? 0.25 : 0.45,
      depthWrite: !ghost,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);

    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.geometry),
      new THREE.LineBasicMaterial({
        color: ghost ? palette.ghost.edge : palette.idle.edge,
        transparent: true,
        opacity: ghost ? 0.6 : 0.95,
      }),
    );
    this.mesh.add(this.edges);

    this.group = this.mesh;
    this.state = "idle";
    LIVE.add(this);
  }

  /**
   * Re-apply the current palette for whatever state this block is already in.
   * `setState` is a no-op when the state has not changed, which is right for
   * gestures and wrong for a colour change, so the repaint is its own door.
   */
  repaint() {
    const palette = THEMES[this.theme];
    const c = this.ghost ? palette.ghost : (palette[this.state] ?? palette.idle);
    this.material.color.setHex(c.body);
    this.material.emissive.setHex(c.body);
    if (!this.ghost) this.material.emissiveIntensity = c.glow;
    this.edges.material.color.setHex(c.edge);
  }

  /**
   * Recolor to show what the hands are doing to this block. Feedback matters
   * most for "doomed": a wipe is armed by a motion and fired by opening your
   * hand, so without the color there is no way to tell the two meanings of
   * opening your hand apart before it is too late.
   */
  setState(state) {
    const palette = THEMES[this.theme];
    const c = palette[state] ?? palette.idle;
    if (this.ghost || this.state === state) return;
    this.state = state;
    this.material.color.setHex(c.body);
    this.material.emissive.setHex(c.body);
    this.material.emissiveIntensity = c.glow;
    this.edges.material.color.setHex(c.edge);
  }

  /**
   * @param {{x:number,y:number}} a one corner of the front face (a pinch)
   * @param {{x:number,y:number}} b the opposite corner (the other pinch)
   * Depth is derived from the face, not from hand z: fingertip z is far too
   * noisy to drive a dimension you can see. A block therefore always reads as a
   * solid box whose front face is pinned exactly to the two fingertips.
   */
  setCorners(a, b, { minSize = 0.05, depthRatio = 0.75 } = {}) {
    const w = Math.max(Math.abs(b.x - a.x), minSize);
    const h = Math.max(Math.abs(b.y - a.y), minSize);
    const d = Math.max((w + h) / 2 * depthRatio, minSize);

    this.mesh.scale.set(w, h, d);
    this.mesh.position.set(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      // Push the body back so its FRONT face — not its center — sits on the
      // build plane, keeping the corners visually welded to the fingertips.
      BUILD_PLANE_Z - d / 2,
    );
    this.size = { w, h, d };
  }

  /** Front-face extent on the build plane. World-axis, so for a spun block
   *  read `w`/`h` (its own size, which rotation does not change) rather than
   *  the min/max, which describe the box around it. Point tests belong in
   *  `contains`, which handles the spin. */
  get rect() {
    const p = this.mesh.position, s = this.mesh.scale;
    return {
      minX: p.x - s.x / 2, maxX: p.x + s.x / 2,
      minY: p.y - s.y / 2, maxY: p.y + s.y / 2,
      w: s.x, h: s.y,
    };
  }

  /** Reshape from a build-plane rect rather than two corners. */
  setRect(minX, minY, w, h, opts) {
    this.setCorners({ x: minX, y: minY }, { x: minX + w, y: minY + h }, opts);
  }

  /** Spin about the view axis, in radians. Free-running: winds past a full
   *  turn in either direction rather than wrapping. Only the whole story for a
   *  block facing the camera; freestyle can tilt one out of the plane. */
  get angle() { return this.mesh.rotation.z; }
  rotateTo(angle) { this.mesh.rotation.z = angle; }

  /** Orientation `from`, turned `angle` radians about a WORLD axis (see AXIS).
   *  World rather than the block's own, so "up tilts it away" stays true
   *  however the block is already turned. */
  turnWorld(axis, angle, from) {
    this.mesh.quaternion.setFromAxisAngle(axis, angle).multiply(from);
  }

  /**
   * A build-plane point in this block's OWN frame: origin at its centre, axes
   * along its own edges. Identical to `p - centre` while the block is
   * unrotated, which is what keeps every rect test below unchanged for the
   * blocks that have never been spun.
   */
  toLocal(p) {
    const v = _v.set(p.x - this.mesh.position.x, p.y - this.mesh.position.y, 0)
      .applyQuaternion(_q.copy(this.mesh.quaternion).conjugate());
    return { x: v.x, y: v.y };
  }

  /**
   * Is a build-plane point on this block, as the camera sees it? `margin`
   * widens the catch.
   *
   * Asked as "does the line of sight through that point pass through the
   * block": a slab test against the block's own box. For a block facing the
   * camera that is a rect test in its own frame, exactly as before; a block
   * tilted out of the plane is caught by the outline it actually shows.
   */
  contains(p, margin = 0) {
    const qi = _q.copy(this.mesh.quaternion).conjugate();
    const pos = this.mesh.position, s = this.mesh.scale;
    const o = _v.set(p.x - pos.x, p.y - pos.y, BUILD_PLANE_Z - pos.z).applyQuaternion(qi);
    const d = _d.set(0, 0, 1).applyQuaternion(qi);
    let near = -Infinity, far = Infinity;
    for (const k of ["x", "y", "z"]) {
      const h = s[k] / 2 + margin;
      if (Math.abs(d[k]) < 1e-9) {
        if (Math.abs(o[k]) > h) return false;
        continue;
      }
      const a = (-h - o[k]) / d[k], b = (h - o[k]) / d[k];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return false;
    }
    return true;
  }

  /**
   * Reshape from a rect stated in this block's own frame (see `toLocal`), so a
   * spun block stretches along its own edges instead of the world axes. With
   * no rotation this is exactly `setRect` in world coords.
   */
  setLocalRect(minX, minY, w, h, { minSize = 0.05, depthRatio = 0.75 } = {}) {
    const nw = Math.max(w, minSize), nh = Math.max(h, minSize);
    const d = Math.max((nw + nh) / 2 * depthRatio, minSize);
    // Where the new rect's centre lands, carried back out to the world along
    // the block's own axes.
    const off = _v.set(minX + nw / 2, minY + nh / 2, 0).applyQuaternion(this.mesh.quaternion);
    this.mesh.scale.set(nw, nh, d);
    this.mesh.position.set(
      this.mesh.position.x + off.x,
      this.mesh.position.y + off.y,
      BUILD_PLANE_Z - d / 2,
    );
    this.size = { w: nw, h: nh, d };
  }

  /**
   * Move, scale and turn about a pivot — the two-fist grab, all three of its
   * axes at once.
   *
   * `rot` turns the block about the PIVOT, not about itself: the scene has to
   * rotate as one rigid piece, so a block off to the side swings around on its
   * radius rather than spinning where it stands. Its own orientation rides
   * along on top, which is what keeps a block you turned by hand looking the
   * same relative to its neighbours — composed rather than added to z, since
   * in freestyle that orientation can include a tilt.
   */
  transformAbout(origin, pivot, anchor, s, rot = 0) {
    const dx = (origin.position.x - pivot.x) * s;
    const dy = (origin.position.y - pivot.y) * s;
    const c = Math.cos(rot), sn = Math.sin(rot);
    this.mesh.position.set(
      anchor.x + dx * c - dy * sn,
      anchor.y + dx * sn + dy * c,
      origin.position.z * s,
    );
    if (origin.quaternion) this.mesh.quaternion.setFromAxisAngle(AXIS.z, rot).multiply(origin.quaternion);
    else this.mesh.rotation.z = (origin.angle ?? 0) + rot;
    this.mesh.scale.set(origin.scale.x * s, origin.scale.y * s, origin.scale.z * s);
    this.size = { w: this.mesh.scale.x, h: this.mesh.scale.y, d: this.mesh.scale.z };
  }

  dispose() {
    LIVE.delete(this);
    this.geometry.dispose();
    this.material.dispose();
    this.edges.geometry.dispose();
    this.edges.material.dispose();
  }
}
