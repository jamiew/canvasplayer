/*
 * gml-three.js: Graffiti Markup Language playback in WebGL.
 *
 * Draw tags with three.js. Sample time sets depth.
 * The drawing head moves dust through a vector field.
 * Each particle trails a line to its starting point.
 *
 * Based on Evan Roth's ga4-3d-player fork of canvasplayer.
 * Its look, field and settings inform this renderer.
 * Shared gml.js preparation repairs timing and orientation.
 * Checking capture orientation avoids the fork's sideways rendering of #147.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

import { prepare, clamp } from './gml.js';

export const DEFAULTS = {
  // Front-to-back depth as a multiple of the tag's size.
  depthSpan: 1.6,

  fov: 50,
  dist: 2.7,
  minDist: 0.8,
  maxDist: 8,
  // Radians per second. A full turn takes about a minute.
  autoRotate: 0.12,
  orbitSpeed: 0.01,
  zoomSpeed: 0.0015,

  // Slight transparency matches the fork.
  strokeAlpha: 0.9,
  // Ribbon width multiplier. Two gives the fork's 0.04 slow half-width.
  strokeWidth: 2,
  // Samples used to taper each stroke's start and end.
  taper: 6,

  /*
   * The drawing head pushes a decaying velocity field.
   * Particles follow their current cell and stay awake once moved.
   * Wake time sets their depth.
   */
  cols: 144,
  rows: 108,
  reactivity: 11,
  friction: 3.2,
  fieldDecay: 0.9,
  injectScale: 2.75,
  injectRadius: 4,
  injectStrength: 0.32,
  // Dust margin as a fraction of the tag's size.
  margin: 0.45,
  dotSize: 0.012,
  particleAlpha: 0.85,
  trailAlpha: 0.5,

  // Hold at the loop's end, then fall and fade.
  holdSec: 1,
  fadeSec: 2.6,
  gravity: 0.9,

  background: 0x000000,
  color: 0xffffff,
  // Playback rate for the shared transport.
  speed: 1
};

// Four Catmull-Rom samples per segment, as in the fork. Clamp the end
// controls to keep both endpoints; linear time cannot overshoot repaired time.
function smooth(points) {
  if (points.length < 4) return points;
  const out = [];
  const cr = (a, b, c, d, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2
      + (-a + 3 * b - 3 * c + d) * t3);
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i];
    const c = points[i + 1], d = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < 4; j++) {
      const t = j / 4;
      out.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t),
        b[2] + (c[2] - b[2]) * t]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/*
 * Play a parsed tag on a WebGL canvas. Pass a tag now or call load() later.
 * Size the canvas's parent to set its dimensions.
 * Events: 'load' with the prepared tag, 'frame' with { time, duration }.
 */
export class ThreePlayer {
  /*
   * Pass your three.js copy as `THREE`. Only preparation is shared with 2D.
   *
   *   import * as THREE from 'three';
   *   const player = new ThreePlayer(THREE, canvas, tag);
   *
   * Uses core APIs. Tested against r160, which the demo vendors.
   */
  constructor(THREE, canvas, tag, options) {
    this.THREE = THREE;
    this.canvas = canvas;
    this.opts = { ...DEFAULTS, ...options };
    this.listeners = {};
    this.elapsed = 0;
    this.last = null;
    this.playing = false;
    this.destroyed = false;
    this.canvasStyle = { width: canvas.style.width, height: canvas.style.height };

    this.effects = { dust: true, 'auto-rotate': true };
    this.capabilities = {
      modes: [], effects: Object.keys(this.effects), layers: [],
      about: {
        dust: 'Dust follows the pen. Turn it off to clear it, then on to follow new marks.',
        'auto-rotate': 'Orbit automatically. Turn it off to hold the angle; dragging still works.'
      }
    };

    this.camera3 = { yaw: 0, pitch: 0, dist: this.opts.dist };
    this.cameraDistanceScale = 1;
    this.dragging = false;

    this.renderer = new this.THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(this.opts.background, 1);
    this.scene = new this.THREE.Scene();
    this.camera = new this.THREE.PerspectiveCamera(this.opts.fov, 1, 0.01, 100);

    this.input();
    this.onResize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentNode || canvas);
    }
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('resize', this.onResize);
    }
    this.onDensityChange = () => {
      this.watchDensity();
      this.resize();
    };
    this.watchDensity();

    this.load(tag);
    this.resize();
  }

  on(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  }

  off(name, fn) {
    if (this.listeners[name]) this.listeners[name] = this.listeners[name].filter(listener => listener !== fn);
    return this;
  }

  emit(name, payload) {
    (this.listeners[name] || []).forEach(fn => fn(payload));
  }

  get duration() { return this.tag.duration; }
  get time() { return this.elapsed; }

  load(tag) {
    if (this.destroyed) return this;
    this.clear();
    this.tag = prepare(tag, this.opts);
    this.paths = this.tag.strokes.map(stroke => smooth(stroke.points));

    // Fit the smoothed path, including any curve beyond the captured bounds.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const points of this.paths) for (const [x, y] of points) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (!this.paths.length) ({ x0, y0, x1, y1 } = this.tag.bounds);
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.size = Math.max(x1 - x0, y1 - y0, 1e-3);
    this.scale = 1 / this.size;

    const half = this.size * (0.5 + this.opts.margin);
    this.stage = { x0: this.cx - half, y0: this.cy - half, side: half * 2 };

    this.elapsed = 0;
    this.last = null;
    this.buildStrokes();
    this.buildDust();
    this.emit('load', this.tag);
    this.render();
    return this;
  }

  // Flip y here: canvas coordinates run down, three.js coordinates run up.
  world(x, y, t) {
    return [
      (x - this.cx) * this.scale,
      -(y - this.cy) * this.scale,
      (t / this.tag.duration - 0.5) * this.opts.depthSpan
    ];
  }

  clear() {
    (this.meshes || []).forEach(m => {
      this.scene.remove(m.mesh);
      m.mesh.geometry.dispose();
      m.mesh.material.dispose();
    });
    this.meshes = [];
    [this.dots, this.trails].forEach(o => {
      if (!o) return;
      this.scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    });
    this.dots = this.trails = null;
  }

  /*
   * Cache the fork's smooth, distance-shaped ribbon in world space.
   * An extra vertex on each triangle diagonal lets the leading edge clip
   * the original triangles, rather than bend already drawn ink.
   */
  buildStrokes() {
    const { opts } = this;
    this.paths.forEach(pts => {
      const n = pts.length;
      if (!n) return;

      const world = pts.map(p => this.world(p[0], p[1], p[2]));
      const positions = new Float32Array(n === 1 ? 12 : n * 6 + (n - 1) * 3);
      const distances = world.map((p, i) => i
        ? Math.hypot(p[0] - world[i - 1][0], p[1] - world[i - 1][1]) : 0);
      // A single fast jump must not flatten every other sample to full width.
      const sorted = distances.filter(d => d > 0).sort((a, b) => a - b);
      const reference = sorted.length ? Math.max(sorted[Math.floor(sorted.length * 0.85)], 1e-6) : 1e-6;
      const widthScale = opts.strokeWidth / DEFAULTS.strokeWidth;

      for (let i = 0; i < n; i++) {
        const a = world[i > 0 ? i - 1 : i];
        const c = world[i < n - 1 ? i + 1 : i];
        const dx = c[0] - a[0];
        const dy = c[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        // The normal stays in xy. Sample time supplies z.
        const px = dx || dy ? -dy / len : 1;
        const py = dx / len;

        let taper = 1;
        if (opts.taper > 1) {
          taper = Math.pow(Math.min(1, i / (opts.taper - 1), (n - 1 - i) / (opts.taper - 1)), 1.1);
        }
        const speed = clamp(distances[i] / reference, 0, 1);
        const hw = Math.max(0.04 * (1 - speed * 0.92) * taper, 0.002) * widthScale;

        const [x, y, z] = world[i];
        positions[i * 6] = x + px * hw;
        positions[i * 6 + 1] = y + py * hw;
        positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x - px * hw;
        positions[i * 6 + 4] = y - py * hw;
        positions[i * 6 + 5] = z;
      }

      const index = [];
      if (n === 1) {
        // A legal one-sample stroke is a dab, not an empty ribbon.
        const [x, y, z] = world[0];
        const hw = 0.04 * widthScale;
        positions.set([x - hw, y - hw, z, x + hw, y - hw, z,
          x - hw, y + hw, z, x + hw, y + hw, z]);
        index.push(0, 1, 2, 1, 3, 2);
      }
      for (let i = 0; i < n - 1; i++) {
        const l0 = i * 2;
        const r0 = l0 + 1;
        const l1 = l0 + 2;
        const r1 = l0 + 3;
        const diagonal = n * 2 + i;
        positions.set(positions.subarray((i + 1) * 6, (i + 1) * 6 + 3), diagonal * 3);
        // At a complete segment the middle triangle collapses to zero area.
        index.push(l0, r0, diagonal, l0, diagonal, l1, r0, r1, diagonal);
      }

      const geo = new this.THREE.BufferGeometry();
      geo.setAttribute('position', new this.THREE.BufferAttribute(positions, 3));
      geo.setIndex(index);
      const mat = new this.THREE.MeshBasicMaterial({
        color: opts.color, side: this.THREE.DoubleSide, transparent: true, depthWrite: false
      });
      const mesh = new this.THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.meshes.push({ mesh, pts, original: positions.slice(), edge: -1 });
    });
  }

  buildDust() {
    const { opts } = this;
    // Clear old geometry before resetDust() tries to upload into it.
    this.dotGeo = this.trailGeo = null;
    // Smaller screens need fewer particles.
    const small = Math.min(globalThis.innerWidth || Infinity, globalThis.innerHeight || Infinity) < 600;
    this.cols = small ? 96 : opts.cols;
    this.rows = small ? 72 : opts.rows;

    const n = this.cols * this.rows;
    const st = this.stage;
    this.cw = st.side / this.cols;
    this.ch = st.side / this.rows;

    this.P = {
      n,
      posX: new Float32Array(n), posY: new Float32Array(n),
      oriX: new Float32Array(n), oriY: new Float32Array(n),
      velX: new Float32Array(n), velY: new Float32Array(n),
      woke: new Uint8Array(n), wokeAt: new Float32Array(n)
    };
    this.field = { x: new Float32Array(n), y: new Float32Array(n) };
    this.resetDust();

    this.dotPos = new Float32Array(n * 3);
    const dotGeo = new this.THREE.BufferGeometry();
    dotGeo.setAttribute('position', new this.THREE.BufferAttribute(this.dotPos, 3));
    dotGeo.setDrawRange(0, 0);
    this.dotGeo = dotGeo;
    this.dots = new this.THREE.Points(dotGeo, new this.THREE.PointsMaterial({
      color: opts.color, size: opts.dotSize, sizeAttenuation: true,
      transparent: true, depthWrite: false, blending: this.THREE.AdditiveBlending
    }));
    this.dots.frustumCulled = false;
    this.scene.add(this.dots);

    // Trails fade from the bright particle to its black starting vertex.
    this.trailPos = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 3);
    for (let k = 0; k < n; k++) {
      colors[k * 6] = colors[k * 6 + 1] = colors[k * 6 + 2] = 0.7;
    }
    const trailGeo = new this.THREE.BufferGeometry();
    trailGeo.setAttribute('position', new this.THREE.BufferAttribute(this.trailPos, 3));
    trailGeo.setAttribute('color', new this.THREE.BufferAttribute(colors, 3));
    trailGeo.setDrawRange(0, 0);
    this.trailGeo = trailGeo;
    this.trails = new this.THREE.LineSegments(trailGeo, new this.THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: this.THREE.AdditiveBlending
    }));
    this.trails.frustumCulled = false;
    this.scene.add(this.trails);
  }

  resetDust() {
    const P = this.P;
    const st = this.stage;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        P.posX[k] = P.oriX[k] = st.x0 + (i + 0.5) * this.cw;
        P.posY[k] = P.oriY[k] = st.y0 + (j + 0.5) * this.ch;
      }
    }
    P.velX.fill(0);
    P.velY.fill(0);
    P.woke.fill(0);
    P.wokeAt.fill(0);
    this.field.x.fill(0);
    this.field.y.fill(0);
    this.injectLastStroke = -1;
    this.headStroke = 0;
    this.headPoint = 1;
    this.simulationTime = this.elapsed;
    this.simulationRemainder = 0;
    // Upload the reset field so load() and seek() cannot draw stale buffers.
    // Fresh geometry draws everything by default, placing 15,552 untouched
    // particles at the origin unless we also narrow the draw range.
    if (this.dotGeo) this.uploadDust();
  }

  // The fork calibrates head motion in grid cells, then applies the field
  // directly to capture-space velocity. Removing cell size kills its flight.
  inject(x, y, stroke) {
    if (stroke !== this.injectLastStroke) {
      this.injectLastStroke = stroke;
      this.injectLastX = x;
      this.injectLastY = y;
      return;
    }
    const dx = x - this.injectLastX;
    const dy = y - this.injectLastY;
    this.injectLastX = x;
    this.injectLastY = y;
    if (dx === 0 && dy === 0) return;

    const { opts, field } = this;
    const cx = (x - this.stage.x0) / this.cw;
    const cy = (y - this.stage.y0) / this.ch;
    const vx = dx / this.cw * opts.injectScale;
    const vy = dy / this.ch * opts.injectScale;
    const R = opts.injectRadius;

    for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(this.rows - 1, Math.ceil(cy + R)); j++) {
      for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(this.cols - 1, Math.ceil(cx + R)); i++) {
        const d = Math.hypot(i - cx, j - cy);
        if (d >= R) continue;
        const w = opts.injectStrength * (1 - d / R);
        const k = j * this.cols + i;
        field.x[k] += vx * w;
        field.y[k] += vy * w;
      }
    }
  }

  // Visit every crossed segment, not just the stroke under the display
  // frame. A short stroke or its final sample must not disappear at 30 Hz.
  injectBetween(from, to) {
    const strokes = this.paths;
    while (this.headStroke < strokes.length) {
      const pts = strokes[this.headStroke];
      if (pts[0][2] > to) break;
      while (this.headPoint < pts.length) {
        const a = pts[this.headPoint - 1];
        const b = pts[this.headPoint];
        if (a[2] > to) break;
        if (b[2] >= from) {
          const span = b[2] - a[2];
          const start = span > 0 ? clamp((from - a[2]) / span, 0, 1) : 0;
          const end = span > 0 ? clamp((to - a[2]) / span, 0, 1) : 1;
          this.inject(a[0] + (b[0] - a[0]) * start, a[1] + (b[1] - a[1]) * start, this.headStroke);
          this.inject(a[0] + (b[0] - a[0]) * end, a[1] + (b[1] - a[1]) * end, this.headStroke);
        }
        if (b[2] > to) break;
        this.headPoint++;
      }
      if (this.headPoint < pts.length) break;
      this.headStroke++;
      this.headPoint = 1;
    }
  }

  stepDust(dt, head, falling) {
    const { P, field, opts } = this;
    const drag = Math.min(1, opts.friction * dt);
    const push = opts.reactivity * dt;
    const g = falling ? opts.gravity * dt : 0;
    const decay = Math.pow(opts.fieldDecay, dt * 60);

    for (let k = 0; k < P.n; k++) {
      let ci = ((P.posX[k] - this.stage.x0) / this.cw) | 0;
      let cj = ((P.posY[k] - this.stage.y0) / this.ch) | 0;
      ci = ci < 0 ? 0 : ci >= this.cols ? this.cols - 1 : ci;
      cj = cj < 0 ? 0 : cj >= this.rows ? this.rows - 1 : cj;
      const c = cj * this.cols + ci;

      P.velX[k] += field.x[c] * push;
      P.velY[k] += field.y[c] * push;
      if (g && P.woke[k]) P.velY[k] += g;
      P.velX[k] -= P.velX[k] * drag;
      P.velY[k] -= P.velY[k] * drag;
      P.posX[k] += P.velX[k] * dt;
      P.posY[k] += P.velY[k] * dt;
      if (!P.woke[k] && (P.posX[k] !== P.oriX[k] || P.posY[k] !== P.oriY[k])) {
        P.woke[k] = 1;
        P.wokeAt[k] = head;
      }
    }

    for (let k = 0; k < field.x.length; k++) {
      field.x[k] *= decay;
      field.y[k] *= decay;
    }
  }

  // Upload and draw only awake particles. End update ranges at the last
  // packed particle so an untouched grid costs nothing.
  uploadDust() {
    const { P } = this;
    let n = 0;
    for (let k = 0; k < P.n; k++) {
      if (!P.woke[k]) continue;
      const x = (P.posX[k] - this.cx) * this.scale;
      const y = -(P.posY[k] - this.cy) * this.scale;
      const z = (P.wokeAt[k] / this.tag.duration - 0.5) * this.opts.depthSpan;
      const ox = (P.oriX[k] - this.cx) * this.scale;
      const oy = -(P.oriY[k] - this.cy) * this.scale;
      this.dotPos[n * 3] = x;
      this.dotPos[n * 3 + 1] = y;
      this.dotPos[n * 3 + 2] = z;
      this.trailPos[n * 6] = x;
      this.trailPos[n * 6 + 1] = y;
      this.trailPos[n * 6 + 2] = z;
      this.trailPos[n * 6 + 3] = ox;
      this.trailPos[n * 6 + 4] = oy;
      this.trailPos[n * 6 + 5] = z;
      n++;
    }
    this.dotGeo.setDrawRange(0, n);
    this.dotGeo.attributes.position.addUpdateRange(0, n * 3);
    this.dotGeo.attributes.position.needsUpdate = true;
    this.trailGeo.setDrawRange(0, n * 2);
    this.trailGeo.attributes.position.addUpdateRange(0, n * 6);
    this.trailGeo.attributes.position.needsUpdate = true;
  }

  watchDensity() {
    if (this.densityQuery) this.densityQuery.removeEventListener('change', this.onDensityChange);
    if (typeof globalThis.matchMedia === 'function') {
      this.densityQuery = globalThis.matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
      this.densityQuery.addEventListener('change', this.onDensityChange);
    }
  }

  resize() {
    if (this.destroyed) return this;
    const host = this.canvas.parentNode || this.canvas;
    const w = Math.max(host.clientWidth || this.canvas.clientWidth, 1);
    const h = Math.max(host.clientHeight || this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    // Pin CSS pixels too: an unstyled canvas otherwise takes its layout
    // size from the DPR-scaled drawing buffer and grows on every resize.
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // Keep the enclosing sphere visible when width limits the field of view.
    // Adjust distance separately to preserve orbit and zoom across resizes.
    const halfFov = this.camera.fov * Math.PI / 360;
    const limitingFov = Math.atan(Math.tan(halfFov) * Math.min(1, this.camera.aspect));
    this.cameraDistanceScale = Math.sin(halfFov) / Math.sin(limitingFov);
    this.camera.updateProjectionMatrix();
    this.render();
    return this;
  }

  render() {
    if (this.destroyed) return this;
    const { opts } = this;
    const dur = this.tag.duration;
    const holdEnd = dur + opts.holdSec;
    const head = Math.min(this.elapsed, dur);

    // Reveal each stroke up to the head.
    this.meshes.forEach(m => {
      const { pts, original, mesh } = m;
      const position = mesh.geometry.attributes.position;
      // Upper bound consumes equal-time samples together, without dividing
      // by a zero-duration segment or leaving its endpoint unrevealed.
      let lo = 0, hi = pts.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pts[mid][2] <= head) lo = mid + 1;
        else hi = mid;
      }
      if (pts.length === 1) {
        mesh.geometry.setDrawRange(0, lo ? 6 : 0);
        return;
      }
      // Clip the leading pair and the original diagonal at the same time.
      // Restore the previous segment unless this frame will overwrite it.
      const edge = lo > 0 && lo < pts.length ? lo : -1;
      if (m.edge >= 0 && m.edge !== edge) {
        const offset = m.edge * 6;
        for (let k = 0; k < 6; k++) position.array[offset + k] = original[offset + k];
        position.addUpdateRange(offset, 6);
        position.needsUpdate = true;
        const diagonal = pts.length * 6 + (m.edge - 1) * 3;
        for (let k = 0; k < 3; k++) position.array[diagonal + k] = original[diagonal + k];
        position.addUpdateRange(diagonal, 3);
      }
      if (edge >= 0) {
        const fraction = (head - pts[edge - 1][2]) / (pts[edge][2] - pts[edge - 1][2]);
        const offset = edge * 6;
        for (let k = 0; k < 6; k++) {
          const start = original[offset - 6 + k];
          position.array[offset + k] = start + (original[offset + k] - start) * fraction;
        }
        position.addUpdateRange(offset, 6);
        position.needsUpdate = true;
        const diagonal = pts.length * 6 + (edge - 1) * 3;
        for (let k = 0; k < 3; k++) {
          const start = original[offset - 3 + k];
          position.array[diagonal + k] = start + (original[offset + k] - start) * fraction;
        }
        position.addUpdateRange(diagonal, 3);
      }
      m.edge = edge;
      mesh.geometry.setDrawRange(0, lo ? Math.min(lo, pts.length - 1) * 9 : 0);
    });

    const fade = this.elapsed > holdEnd
      ? clamp(1 - (this.elapsed - holdEnd) / opts.fadeSec, 0, 1)
      : 1;
    this.meshes.forEach(m => { m.mesh.material.opacity = opts.strokeAlpha * fade; });
    if (this.dots) this.dots.material.opacity = opts.particleAlpha * fade;
    if (this.trails) this.trails.material.opacity = opts.trailAlpha * fade;
    if (this.dots) this.dots.visible = this.effects.dust;
    if (this.trails) this.trails.visible = this.effects.dust;

    const c = this.camera3;
    const ce = Math.cos(c.pitch);
    const distance = c.dist * this.cameraDistanceScale;
    this.camera.position.set(
      distance * ce * Math.sin(c.yaw),
      distance * Math.sin(c.pitch),
      distance * ce * Math.cos(c.yaw)
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    this.emit('frame', { time: Math.min(this.elapsed, dur), duration: dur });
    return this;
  }

  step(dt) {
    if (this.destroyed || !(dt > 0) || !Number.isFinite(dt)) return this;
    const { opts } = this;
    const dur = this.tag.duration;
    const holdEnd = dur + opts.holdSec;
    const loopEnd = holdEnd + opts.fadeSec;

    this.elapsed += dt;
    if (!this.dragging && this.effects['auto-rotate']) this.camera3.yaw += opts.autoRotate * dt;
    // Hidden dust does not need a simulation. Re-enabling starts at the current head.
    if (!this.effects.dust) {
      if (this.elapsed >= loopEnd) this.elapsed %= loopEnd;
      return this;
    }
    // Reset before drawing. Resetting after flashed the finished tag at full opacity.
    if (this.elapsed >= loopEnd) {
      this.elapsed %= loopEnd;
      this.resetDust();
      this.simulationTime = 0;
      this.simulationRemainder = this.elapsed;
    } else {
      this.simulationRemainder += dt;
    }

    // Fixed tag-time steps make 30/60/120 Hz run the same field.
    const fixed = 1 / 120;
    const steps = Math.floor((this.simulationRemainder + 1e-10) / fixed);
    for (let i = 0; i < steps; i++) {
      const next = this.simulationTime + fixed;
      this.injectBetween(this.simulationTime, next);
      this.stepDust(fixed, Math.min(next, dur), next > holdEnd);
      this.simulationTime = next;
    }
    this.simulationRemainder = Math.max(0, this.simulationRemainder - steps * fixed);
    if (steps) this.uploadDust();
    return this;
  }

  play() {
    if (this.destroyed || this.playing) return this;
    this.playing = true;
    this.last = null;
    const frame = ts => {
      if (!this.playing) return;
      // Cap background-tab gaps. Applying a whole gap injected every crossed
      // stroke at once and blew dust off the tag when the tab returned.
      const dt = this.last === null ? 0 : clamp((ts - this.last) / 1000, 0, 0.1);
      this.last = ts;
      this.step(dt * this.opts.speed).render();
      if (this.playing) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    this.emit('state', { playing: true });
    return this;
  }

  pause() {
    if (!this.playing) return this;
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.emit('state', { playing: false });
    return this;
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  setEffect(name, on) {
    if (this.destroyed || !Object.hasOwn(this.effects, name) || this.effects[name] === !!on) return this;
    this.effects[name] = !!on;
    if (name === 'dust') this.resetDust();
    this.emit('config');
    return this.render();
  }

  setSpeed(rate) {
    if (this.opts.speed !== rate) {
      this.opts.speed = rate;
      this.emit('config');
    }
    return this;
  }

  // The field cannot run backward. Reset dust at the seek position.
  seek(t) {
    if (this.destroyed) return this;
    this.elapsed = clamp(t, 0, this.tag.duration);
    this.last = null;
    this.resetDust();
    return this.render();
  }

  // Drag to turn, wheel to move in and out.
  input() {
    const c = this.canvas;
    const touchAction = c.style.touchAction;
    c.style.touchAction = 'none';
    let pointer = null;
    let lastX = 0, lastY = 0;

    const down = e => {
      if (pointer !== null) return;
      pointer = e.pointerId;
      this.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      if (c.setPointerCapture) {
        try { c.setPointerCapture(pointer); } catch (err) { /* not captureable */ }
      }
    };
    const move = e => {
      if (!this.dragging || e.pointerId !== pointer) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.camera3.yaw += dx * this.opts.orbitSpeed;
      // Stop before the tag goes edge-on and the camera tips overhead.
      this.camera3.pitch = clamp(this.camera3.pitch + dy * this.opts.orbitSpeed, -1.3, 1.3);
      if (!this.playing) this.render();
    };
    const up = e => {
      if (e && e.pointerId !== pointer) return;
      const released = pointer;
      pointer = null;
      this.dragging = false;
      if (released !== null && c.releasePointerCapture) {
        try { c.releasePointerCapture(released); } catch (err) { /* already released */ }
      }
    };
    const wheel = e => {
      e.preventDefault();
      const o = this.opts;
      this.camera3.dist = clamp(this.camera3.dist * (1 + e.deltaY * o.zoomSpeed), o.minDist, o.maxDist);
      if (!this.playing) this.render();
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    c.addEventListener('wheel', wheel, { passive: false });
    this.disposeInput = () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.removeEventListener('lostpointercapture', up);
      c.removeEventListener('wheel', wheel);
      up();
      c.style.touchAction = touchAction;
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pause();
    this.listeners = {};
    this.disposeInput();
    if (this.observer) this.observer.disconnect();
    if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', this.onResize);
    if (this.densityQuery) this.densityQuery.removeEventListener('change', this.onDensityChange);
    this.clear();
    this.renderer.dispose();
    this.canvas.style.width = this.canvasStyle.width;
    this.canvas.style.height = this.canvasStyle.height;
  }
}
