/*
 * gml-three.js -- Graffiti Markup Language playback in WebGL.
 *
 * The same tags as gml-player.js, drawn with three.js instead of a 2D
 * canvas. Time is the third axis: a sample's z is the moment it was written,
 * so a tag has real thickness and the camera can look along the writing.
 * Dust sits on a vector field the drawing head shoves around, and every
 * particle trails a line back to where it started.
 *
 * After Evan Roth's ga4-3d-player fork of canvasplayer, which is where the
 * look, the field and most of these numbers come from.
 *
 * What is different from that fork: the tag comes through gml.js rather than
 * a parser of its own, so it arrives with its timing repaired, its sideways
 * captures turned upright, and a width per sample measured from the hand's
 * speed. The fork rebuilt all three, less well -- it draws #147 on its side,
 * because it never asks which way up the capture was.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

import { prepare, clamp } from './gml.js';

export const DEFAULTS = {
  // How far the tag reaches front to back, as a multiple of its own size.
  depthSpan: 1.6,

  fov: 50,
  dist: 2.7,
  minDist: 0.8,
  maxDist: 8,
  // Radians per second. A full turn takes about a minute.
  autoRotate: 0.12,
  orbitSpeed: 0.01,
  zoomSpeed: 0.0015,

  // Strokes are drawn slightly transparent, as the fork had them.
  strokeAlpha: 0.9,
  // gml.js measures width as a fraction of the artwork's size, tuned for a
  // 2D canvas. In world units, where the tag is about one across, that comes
  // out thin: the fork's ribbons are roughly twice as fat.
  strokeWidth: 2,
  // Samples over which a stroke opens and closes, so it does not start and
  // stop at full width.
  taper: 6,

  /*
   * The dust field. A grid of particles over the tag; the drawing head
   * injects its own motion into a coarse velocity field, the particles ride
   * whichever cell they stand in, and the field decays. Once a particle has
   * moved it stays awake, and remembers when it woke: that is its depth.
   */
  cols: 144,
  rows: 108,
  reactivity: 11,
  friction: 3.2,
  fieldDecay: 0.9,
  injectScale: 2.75,
  injectRadius: 4,
  injectStrength: 0.32,
  // Room around the tag for the dust to live in, as a fraction of its size.
  margin: 0.45,
  dotSize: 0.012,
  particleAlpha: 0.85,
  trailAlpha: 0.5,

  // End of a loop: hold, then let gravity have it while it fades out.
  holdSec: 1,
  fadeSec: 2.6,
  gravity: 0.9,

  background: 0x000000,
  color: 0xffffff,
  // Playback rate, so the shared transport's speed button works here too.
  speed: 1
};

/*
 * A <canvas> that plays a prepared tag in WebGL.
 *
 * Give it the shape parse() returns, or nothing and load() one later. The
 * canvas sizes itself to its parent, so give that element the dimensions you
 * want. Events: 'load' with the prepared tag, 'frame' with { time, duration }.
 */
export class ThreePlayer {
  /*
   * `THREE` is an argument rather than an import so this module depends on
   * nothing. Bring your own copy, at whatever version you already have:
   *
   *   import * as THREE from 'three';
   *   const player = new ThreePlayer(THREE, canvas, tag);
   *
   * Tested against r160, which is what the demo vendors. Only 13 symbols of
   * it are used, all core.
   */
  constructor(THREE, canvas, tag, options) {
    this.THREE = THREE;
    this.canvas = canvas;
    this.opts = { ...DEFAULTS, ...options };
    this.listeners = {};
    this.elapsed = 0;
    this.last = 0;
    this.playing = false;

    // One look, no modes and no data layers, so the controls show only the
    // transport. gml-ui.js reads this rather than importing the 2D player's.
    this.capabilities = { modes: [], effects: [], layers: [], about: {} };

    this.camera3 = { yaw: 0, pitch: 0, dist: this.opts.dist };
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
    } else if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('resize', this.onResize);
    }

    this.load(tag);
    this.resize();
  }

  on(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  }

  emit(name, payload) {
    (this.listeners[name] || []).forEach(fn => fn(payload));
  }

  get duration() { return this.tag.duration; }

  load(tag) {
    this.clear();
    this.tag = prepare(tag, this.opts);

    // Centre the tag's own box and scale it to about one unit across, so
    // every other number here can be read as a multiple of the artwork.
    const b = this.tag.bounds;
    this.cx = (b.x0 + b.x1) / 2;
    this.cy = (b.y0 + b.y1) / 2;
    this.size = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1e-3);
    this.scale = 1 / this.size;

    const half = this.size * (0.5 + this.opts.margin);
    this.stage = { x0: this.cx - half, y0: this.cy - half, side: half * 2 };

    this.buildStrokes();
    this.buildDust();
    this.elapsed = 0;
    this.emit('load', this.tag);
    return this;
  }

  // Capture space to world. Canvas y runs down and three.js y runs up, so
  // this is the one place the sign flips.
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
   * One ribbon per stroke: two vertices per sample, offset along the normal
   * by half the width gml.js already worked out from the hand's speed. The
   * fork measured its own widths off a percentile of point spacing; this
   * uses the real thing, so a slow pass is fat and a fast one is thin for
   * the same reason it is on the 2D canvas.
   *
   * Playback reveals the ribbon by moving the geometry's draw range, so
   * nothing is rebuilt per frame.
   */
  buildStrokes() {
    const { opts } = this;
    this.tag.strokes.forEach(stroke => {
      const pts = stroke.points;
      const n = pts.length;
      if (n < 2) return;

      const world = pts.map(p => this.world(p[0], p[1], p[2]));
      const positions = new Float32Array(n * 2 * 3);

      for (let i = 0; i < n; i++) {
        const a = world[i > 0 ? i - 1 : i];
        const c = world[i < n - 1 ? i + 1 : i];
        const dx = c[0] - a[0];
        const dy = c[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        // Perpendicular in the drawing's own plane. The ribbon stays flat in
        // xy and gets its depth from where the samples sit in z.
        const px = -dy / len;
        const py = dx / len;

        let taper = 1;
        if (i < opts.taper) taper = Math.pow(i / (opts.taper - 1), 1.1);
        if (i > n - 1 - opts.taper) taper = Math.pow((n - 1 - i) / (opts.taper - 1), 1.1);
        const hw = Math.max(stroke.width[i] * opts.strokeWidth * taper, 0.004) / 2;

        const [x, y, z] = world[i];
        positions[i * 6] = x + px * hw;
        positions[i * 6 + 1] = y + py * hw;
        positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x - px * hw;
        positions[i * 6 + 4] = y - py * hw;
        positions[i * 6 + 5] = z;
      }

      const index = [];
      for (let i = 0; i < n - 1; i++) {
        const l0 = i * 2;
        const r0 = l0 + 1;
        const l1 = l0 + 2;
        const r1 = l0 + 3;
        index.push(l0, r0, l1, r0, r1, l1);
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
      this.meshes.push({ mesh, pts });
    });
  }

  buildDust() {
    const { opts } = this;
    // Dropped before the field is rebuilt: resetDust() uploads, and until
    // the new geometries exist there is nothing safe to upload into.
    this.dotGeo = this.trailGeo = null;
    // A phone has neither the pixels nor the patience for the full grid.
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

    // Two vertices per trail, bright where the particle is and black where
    // it began, so each line fades out along its own length.
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
    this.injectLast = null;
    // Push the empty field to the GPU. Without this, load() and seek() reset
    // the particles and then draw whatever the buffers last held, over a
    // draw range nothing has narrowed: a fresh geometry defaults to drawing
    // everything, so an unstepped field renders 15,552 points at the origin.
    if (this.dotGeo) this.uploadDust();
  }

  // The head's own motion, spread into the field over a few cells.
  inject(x, y) {
    if (!this.injectLast) { this.injectLast = [x, y]; return; }
    const dx = x - this.injectLast[0];
    const dy = y - this.injectLast[1];
    this.injectLast = [x, y];
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;

    const { opts, field } = this;
    const cx = (x - this.stage.x0) / this.cw;
    const cy = (y - this.stage.y0) / this.ch;
    const vx = (dx / this.cw) * opts.injectScale;
    const vy = (dy / this.ch) * opts.injectScale;
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

  stepDust(dt, head, falling) {
    const { P, field, opts } = this;
    const drag = Math.min(1, opts.friction * dt);
    const push = opts.reactivity * dt;
    const g = falling ? opts.gravity * dt : 0;

    for (let k = 0; k < P.n; k++) {
      if (!P.woke[k] && (P.posX[k] !== P.oriX[k] || P.posY[k] !== P.oriY[k])) {
        P.woke[k] = 1;
        P.wokeAt[k] = head;
      }
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
    }

    for (let k = 0; k < field.x.length; k++) {
      field.x[k] *= opts.fieldDecay;
      field.y[k] *= opts.fieldDecay;
    }
  }

  // Only the particles that have woken go to the GPU, so an untouched grid
  // costs nothing to draw.
  uploadDust() {
    const { P } = this;
    let n = 0;
    for (let k = 0; k < P.n; k++) {
      if (!P.woke[k]) continue;
      const [x, y, z] = this.world(P.posX[k], P.posY[k], P.wokeAt[k]);
      const [ox, oy] = this.world(P.oriX[k], P.oriY[k], P.wokeAt[k]);
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
    this.dotGeo.attributes.position.needsUpdate = true;
    this.trailGeo.setDrawRange(0, n * 2);
    this.trailGeo.attributes.position.needsUpdate = true;
  }

  resize() {
    const host = this.canvas.parentNode || this.canvas;
    const w = Math.max(host.clientWidth || this.canvas.clientWidth, 1);
    const h = Math.max(host.clientHeight || this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
    return this;
  }

  render() {
    const { opts } = this;
    const dur = this.tag.duration;
    const holdEnd = dur + opts.holdSec;
    const head = Math.min(this.elapsed, dur);

    // Reveal each stroke up to the head.
    this.meshes.forEach(m => {
      let v = 0;
      while (v < m.pts.length && m.pts[v][2] <= head) v++;
      m.mesh.geometry.setDrawRange(0, Math.max(0, v - 1) * 6);
    });

    const fade = this.elapsed > holdEnd
      ? clamp(1 - (this.elapsed - holdEnd) / opts.fadeSec, 0, 1)
      : 1;
    this.meshes.forEach(m => { m.mesh.material.opacity = opts.strokeAlpha * fade; });
    if (this.dots) this.dots.material.opacity = opts.particleAlpha * fade;
    if (this.trails) this.trails.material.opacity = opts.trailAlpha * fade;

    const c = this.camera3;
    const ce = Math.cos(c.pitch);
    this.camera.position.set(
      c.dist * ce * Math.sin(c.yaw),
      c.dist * Math.sin(c.pitch),
      c.dist * ce * Math.cos(c.yaw)
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    this.emit('frame', { time: Math.min(this.elapsed, dur), duration: dur });
    return this;
  }

  step(dt) {
    const { opts } = this;
    const dur = this.tag.duration;
    const holdEnd = dur + opts.holdSec;
    const loopEnd = holdEnd + opts.fadeSec;

    // Loop before this frame is worked out, not after: resetting afterwards
    // showed one frame of the finished tag at full opacity, which read as a
    // blink at the top of every loop.
    if (this.elapsed > loopEnd) {
      this.elapsed = 0;
      this.resetDust();
    }

    this.elapsed += dt;
    if (!this.dragging) this.camera3.yaw += opts.autoRotate * dt;

    const head = Math.min(this.elapsed, dur);
    if (this.elapsed <= dur) {
      // Whichever stroke is being written now. Later ones first, so an
      // overlap resolves to the one on top.
      const strokes = this.tag.strokes;
      for (let si = strokes.length - 1; si >= 0; si--) {
        const pts = strokes[si].points;
        if (pts[0][2] <= head && head <= pts[pts.length - 1][2]) {
          let i = 0;
          while (i < pts.length - 1 && pts[i + 1][2] < head) i++;
          this.inject(pts[i][0], pts[i][1]);
          break;
        }
      }
    }

    this.stepDust(dt, head, this.elapsed > holdEnd);
    this.uploadDust();
    return this;
  }

  play() {
    if (this.playing) return this;
    this.playing = true;
    this.last = 0;
    const frame = ts => {
      if (!this.playing) return;
      const dt = this.last ? Math.min((ts - this.last) / 1000, 0.05) : 1 / 60;
      this.last = ts;
      this.step(dt * this.opts.speed).render();
      this.raf = requestAnimationFrame(frame);
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

  setSpeed(rate) {
    this.opts.speed = rate;
    return this;
  }

  // A field cannot be run backwards, so scrubbing rebuilds the dust from
  // where it lands rather than showing a history that did not happen.
  seek(t) {
    this.elapsed = clamp(t, 0, this.tag.duration);
    this.resetDust();
    return this.render();
  }

  // Drag to turn, wheel to move in and out.
  input() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    let last = null;

    const down = e => {
      this.dragging = true;
      last = [e.clientX, e.clientY];
      if (c.setPointerCapture) {
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* not captureable */ }
      }
    };
    const move = e => {
      if (!this.dragging || !last) return;
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      this.camera3.yaw += dx * this.opts.orbitSpeed;
      // Short of straight overhead, where the tag goes edge-on and the
      // camera tips over the top.
      this.camera3.pitch = clamp(this.camera3.pitch + dy * this.opts.orbitSpeed, -1.3, 1.3);
      if (!this.playing) this.render();
    };
    const up = () => { this.dragging = false; last = null; };

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const o = this.opts;
      this.camera3.dist = clamp(this.camera3.dist * (1 + e.deltaY * o.zoomSpeed), o.minDist, o.maxDist);
      if (!this.playing) this.render();
    }, { passive: false });
  }

  destroy() {
    this.pause();
    this.clear();
    this.renderer.dispose();
    if (this.observer) this.observer.disconnect();
    else if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', this.onResize);
  }
}
