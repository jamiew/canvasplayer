/*
 * gml-player.js -- Graffiti Markup Language playback on a 2D canvas.
 *
 * paint() draws one frame of a prepared tag on any 2D context: a <canvas>,
 * an OffscreenCanvas, or a canvas in Node. GmlPlayer wraps it around a
 * <canvas> element with a clock, resize handling and a small event API.
 * No dependencies.
 *
 * Replaces the 2009 Processing.js sketch, which advanced one point per frame,
 * measured speed on the x axis alone, rotated by 80 radians, and cropped
 * anything taller than its fixed 800x580 canvas. All four are in the sketch
 * it replaced, at bd51860^:index.html.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

import { DEFAULTS as PREPARE, prepare, progress, noise, clamp, lerp } from './gml.js';

// Diagnostic overlays, each independently switchable.
export const LAYERS = ['ink', 'drips', 'vectors', 'points', 'bounds', 'graph'];

// How the ink itself is drawn. One at a time.
export const MODES = ['marker', 'chisel', 'spray', 'outline', 'sketch', 'dyna', 'hairline', 'skeleton'];

// Combinable treatments applied on top of whichever mode is active.
export const EFFECTS = ['ghost', 'bleed', 'jitter', 'fade', 'depth', 'extrude', 'stereo', 'dust'];

/*
 * How the depth is looked at, rather than what is drawn. All three only mean
 * anything with `depth` on.
 *
 *   cue     what is far off goes dim, so depth reads in a still frame and
 *           not just while the camera is moving
 *   strata  one flat plane per stroke, at the moment that stroke began,
 *           instead of every sample carrying its own depth. A tag built up
 *           in passes comes apart into those passes
 *   ortho   parallel projection: no vanishing point, nothing nearer drawn
 *           larger. A technical drawing rather than a photograph
 */
export const VIEWS = ['cue', 'strata', 'ortho'];

export const DEFAULTS = {
  ...PREPARE,

  // How far a run narrows from where it leaves the pool to the head, and how
  // much more it thins as it stretches. A run that tapers to nothing leaves
  // its head looking like a pin, so the neck keeps some width.
  dripTaper: 0.55,
  dripStretch: 0.3,
  // The head is a little fatter than the neck it hangs from, not a bead
  // dropped at the tip.
  dripHead: 1.45,
  // How far a run may wander sideways, as a fraction of how far it has
  // fallen. Gravity is down, so this can lean a run but never steer it.
  dripDrift: 0.12,

  hairline: 1.5,

  jitter: 0.9,
  fadeWindow: 1.6,
  ghostAlpha: 0.14,

  // A flat nib held at a fixed angle. Width comes from direction, not speed.
  nib: 0.05,
  nibAngle: -Math.PI / 4,
  // Points inserted per captured segment in marker mode.
  smoothSteps: 4,

  /*
   * Aerosol. What leaves a can is close enough to a Gaussian, so the ink
   * lands as a scatter that is dense on the line and thins off the edge,
   * with a soft band of overspray under it. Density follows the width the
   * hand already earned, so a slow pass lays down more paint.
   */
  sprayDots: 17,
  spraySpread: 0.8,
  sprayDot: 0.95,
  sprayHalo: 0.1,

  /*
   * Sketchy rendering: the line drawn more than once, each pass bowed off
   * the true path, the way a hand never repeats itself exactly. After Wood
   * et al.'s sketchy rendering for information visualization, by way of
   * Handy and Rough.js.
   */
  sketchPasses: 2,
  // Enough to see the hand wander, not enough to lose the letter. Past about
  // 0.03 the two passes stop reading as one line and the tag comes apart.
  sketchBow: 0.022,
  // Samples per wave of the bow. Small numbers scribble, large ones drift.
  sketchWave: 22,

  /*
   * A brush with mass, dragged along the captured path on a spring: what
   * gets drawn is where the brush went, not where the hand did. It lags
   * into a corner and coasts out of one, which is where the calligraphy
   * comes from. Paul Haeberli's DynaDraw, 1989.
   */
  dynaMass: 1,
  dynaSpring: 0.42,
  dynaDrag: 0.55,
  // How hard the brush's own speed thins the line. DynaDraw called it ductus.
  dynaDuctus: 1.7,

  /*
   * The tag as an object rather than a mark: the drawing swept backwards
   * into a solid body. With depth on it sweeps along the time axis, so the
   * body is the tag's own history. Flat, it leans a fixed way, which is how
   * a writer blocks out a 3D letter.
   */
  // Enough steps that the sweep closes into a face rather than banding into
  // stripes, at an alpha low enough that the overlap does not go white.
  extrudeSteps: 20,
  extrudeDepth: 0.34,
  extrudeLean: [-0.3, 0.25],
  extrudeBack: 0.07,

  /*
   * Two eyes a little apart, one behind each filter of a pair of red and
   * cyan glasses. Only means anything with depth on, because without it
   * both eyes see the same flat drawing. Added rather than painted over, so
   * where the two agree the ink comes back to white.
   */
  stereoEye: 0.12,
  stereoLeft: '#ff3131',
  stereoRight: '#31ffff',

  /*
   * Dust on a vector field. A grid of particles sits over the drawing; the
   * moving head shoves the field around and the particles ride it, each one
   * trailing a line back to where it started. Nothing is thrown away, so the
   * fan of trails is a record of everywhere the hand has been.
   *
   * These are Evan Roth's numbers, from the 3D fork, kept as they were: the
   * look is the point, and it is his.
   */
  dustCols: 144,
  dustRows: 108,
  dustMargin: 0.45,
  dustReactivity: 11,
  dustFriction: 3.2,
  dustDecay: 0.9,
  dustInjectScale: 2.75,
  dustInjectRadius: 4,
  dustInjectStrength: 0.32,
  dustGravity: 0.9,
  // Sub-pixel, so the dust reads as grain rather than a grid of squares.
  dustDot: 0.0016,
  dustAlpha: 1,
  dustTrail: 0.8,
  // Steps in the trail's fade. The trail runs bright at the particle to
  // nothing at its origin, and canvas has no per-vertex color, so it is
  // drawn as a few batched passes instead of one gradient each.
  dustTrailSteps: 3,
  // The dust field is about twice the size of the tag, so with it on the
  // drawing has to sit back to leave the field somewhere to be. Without
  // this the tag fills the frame and all its dust blows off the edges.
  dustFit: 0.55,

  // Breathing room around the drawing, as a fraction of the frame.
  pad: 0.08,

  // Time as depth. How far the tag reaches front to back, as a multiple of
  // its own on-screen size, and how far off the camera sits.
  depthSpan: 0.85,
  depthDist: 3.2,
  // The drawing shrinks to leave room to turn in. Side on, a tag is as wide
  // as it is deep, and the near end is magnified on top of that; without the
  // shrink it runs off the frame every time the camera comes round.
  depthZoom: 0.84,
  // Radians per second of playback, so the turn keeps time with the speed
  // control rather than running at its own pace. A full turn takes about a
  // minute: fast enough to read as depth, slow enough to read the tag.
  autoRotate: 0.12,
  // Off dead ahead to start with, or the first seconds of a tag look flat
  // and the whole effect arrives late.
  depthPitch: -0.2,
  orbitSpeed: 0.01,
  zoomSpeed: 0.0015,
  // How dim the far end of the tag goes under `cue`. Not to nothing: the
  // back of a tag should recede, not disappear.
  cueFar: 0.34,

  color: '#ffffff',
  background: '#000000',

  loop: true,
  loopDelay: 1400,
  speed: 1
};

const TAU = Math.PI * 2;

// Ink soaking outwards, as widening passes under the stroke, so the edge
// falls off instead of stopping dead. [width multiplier, alpha].
const BLEED = [[3.2, 0.13], [2.2, 0.18], [1.5, 0.26]];

const DRIP_STEPS = 7;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/*
 * How far jitter moves a sample, and where it moves it to. A run hangs off
 * the sample it started from, so both have to read the same offset or the
 * run comes away from its stroke.
 */
function jitterAmount(s) {
  return s.effects.jitter ? s.opts.jitter * s.view.unit * 0.012 : 0;
}

// One shared pair, so jitter switched off costs nothing per sample.
const STILL = [0, 0];

// Likewise for the extrude sweep: one object, so the common case reads zeros
// rather than branching on every sample.
const NO_OFFSET = { dx: 0, dy: 0, dt: 0 };

function jitterAt(amount, si, i) {
  if (!amount) return STILL;
  return [(noise(si * 91 + i, 7) - 0.5) * amount, (noise(si * 91 + i, 13) - 0.5) * amount];
}

/*
 * Where the drawing lands in a w by h frame. Fits the tag's own bounds, not
 * the full 0..1 capture space, so a tag that used one corner still fills the
 * frame.
 *
 * One scale for both axes. The capture apps normalized x and y against the
 * same edge, so a unit across already matches a unit down. Reapplying the
 * screen's 3:2 ratio on top squashed every landscape capture.
 */
export function fit(bounds, w, h, pad = DEFAULTS.pad) {
  const bw = bounds.x1 - bounds.x0;
  const bh = bounds.y1 - bounds.y0;
  const scale = Math.min(w * (1 - pad * 2) / bw, h * (1 - pad * 2) / bh);
  const ox = (w - bw * scale) / 2 - bounds.x0 * scale;
  const oy = (h - bh * scale) / 2 - bounds.y0 * scale;
  return {
    w,
    h,
    scale,
    // Widths follow the artwork's on-screen size, not the frame's.
    unit: Math.sqrt(bw * scale * bh * scale),
    x: v => ox + v * scale,
    y: v => oy + v * scale,
    // Flat, so time is not a direction and every sample is the same size.
    // The third value is depth, the fourth what perspective does to width.
    bounds,
    at: (x, y) => [ox + x * scale, oy + y * scale, 0, 1],
    behind: false,
    // Flat has no far end, so nothing is ever dimmed for distance.
    nearness: () => 1
  };
}

/*
 * The same drawing with time as depth: a sample's z is when it was written,
 * so a tag has real thickness and the camera can look along the writing
 * instead of at it. A tag drawn in one pass reads as a single sheet; one
 * built up in layers pulls apart into them.
 *
 * The idea is from Evan Roth's Graffiti Analysis, by way of his 3D fork of
 * this player. That fork reached for WebGL. It does not need to: a tag is a
 * few thousand points, and projecting them by hand costs nothing and keeps
 * every ink mode, effect and drip working exactly as it does flat.
 *
 * Straight ahead this is the flat fit shrunk by `depthZoom`, so switching
 * depth on does not move the drawing, only pulls it back. Samples nearer the
 * camera are drawn wider, which is what makes the perspective read.
 */
export function orbit(view, duration, camera, opts, views) {
  const ortho = !!(views && views.ortho);
  const ca = Math.cos(camera.yaw);
  const sa = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);

  // Depth is measured against the artwork's own on-screen size, not the
  // capture space it sits in. Against the capture space, a tag written in
  // one corner got the same depth as one that filled the screen, and swung
  // clean out of the frame the moment the camera came off axis.
  const span = view.unit;
  const eye = camera.dist * span;
  const zoom = opts.depthZoom;
  const midX = view.w / 2;
  const midY = view.h / 2;

  // The eight corners of the tag's box, swept through its whole time, are
  // the nearest and furthest anything can be. Eight projections, once a
  // frame, and depth cueing then has a real range to work against.
  let near = Infinity;
  let far = -Infinity;
  const b = view.bounds;
  for (const x of [b.x0, b.x1]) {
    for (const y of [b.y0, b.y1]) {
      for (const t of [0, duration]) {
        const px = view.x(x) - midX;
        const py = view.y(y) - midY;
        const pz = (t / duration - 0.5) * opts.depthSpan * span;
        const rz = pz * ca - px * sa;
        const ez = py * sp + rz * cp + eye;
        if (ez < near) near = ez;
        if (ez > far) far = ez;
      }
    }
  }

  return {
    ...view,

    // Whether later strokes now sit further away. If they do the painter has
    // to lay them down first, or the tag draws itself inside out.
    behind: ca * cp > 0,

    // 1 at the nearest corner of the tag, 0 at the furthest. The range is
    // measured, not assumed: how deep a tag looks depends on where the
    // camera is as much as on how long it took to write, and a guess at it
    // dimmed the near face along with the far one.
    nearness(ez) {
      return far > near ? clamp((far - ez) / (far - near), 0, 1) : 1;
    },

    at(x, y, t) {
      // Offsets from the middle of the fitted drawing, which is where the
      // camera looks. Canvas y runs down and so does capture y, so the two
      // agree and nothing needs flipping.
      const px = view.x(x) - midX;
      const py = view.y(y) - midY;
      const pz = (t / duration - 0.5) * opts.depthSpan * span;

      // Yaw about the vertical axis, then pitch about the horizontal one.
      const rx = px * ca + pz * sa;
      const rz = pz * ca - px * sa;
      const ry = py * cp - rz * sp;
      const ez = py * sp + rz * cp + eye;

      // Parallel projection has no lens to be behind and no vanishing point,
      // so distance changes nothing but which way round things are drawn.
      if (ortho) return [midX + rx * zoom, midY + ry * zoom, ez, zoom];

      // Behind the lens, where the projection turns inside out. Park it on
      // the vanishing point at no width rather than draw it mirrored.
      if (ez <= 1e-3) return [midX, midY, ez, 0];

      const k = (eye / ez) * zoom;
      return [midX + rx * k, midY + ry * k, ez, k];
    }
  };
}

/* --- ink --------------------------------------------------------------- */

/*
 * Screen-space [x, y, width] triples for a slice of a stroke; `to` is
 * exclusive. The leading edge is interpolated between samples, so the line
 * grows smoothly instead of a sample at a time. `spread` widens the whole
 * slice, for the bleed passes.
 */
function path(s, stroke, si, from, to, partial, spread) {
  const { view } = s;
  const pts = stroke.points;
  const out = [];
  const jitter = jitterAmount(s);

  // Where this pass sits relative to the drawing itself. Only extrude moves
  // it, and then only to sweep the same ink backwards into a body.
  const off = s.offset || NO_OFFSET;
  // Under strata a stroke is a flat plane at the moment it began, so every
  // sample in it reads the same time.
  const plane = s.views.strata ? pts[0][2] : null;
  const when = i => (plane === null ? pts[i][2] : plane) + off.dt;

  for (let i = from; i < to; i++) {
    const [jx, jy] = jitterAt(jitter, si, i);
    // Depth widens what is near and narrows what is far, on top of the width
    // speed already gave the sample.
    const [x, y, , k] = view.at(pts[i][0], pts[i][1], when(i));
    out.push([x + jx + off.dx, y + jy + off.dy, stroke.width[i] * view.unit * spread * k]);
  }
  if (partial > 0 && to < pts.length && to > from) {
    const a = pts[to - 1];
    const b = pts[to];
    const t = plane === null ? lerp(a[2], b[2], partial) + off.dt : plane + off.dt;
    const [x, y, , k] = view.at(lerp(a[0], b[0], partial), lerp(a[1], b[1], partial), t);
    out.push([x + off.dx, y + off.dy, lerp(stroke.width[to - 1], stroke.width[to], partial) * view.unit * spread * k]);
  }
  return out;
}

function catmull(a, b, c, d, t) {
  const t2 = t * t;
  return 0.5 * ((2 * b) + (c - a) * t +
    (2 * a - 5 * b + 4 * c - d) * t2 +
    (3 * b - a - 3 * c + d) * t2 * t);
}

/*
 * Catmull-Rom through the samples. Capture hardware samples on a pixel grid,
 * so a slow hand records as a staircase; this puts the curve back.
 */
function smooth(path, steps) {
  if (path.length < 3) return path;
  const out = [path[0]];
  for (let i = 0; i < path.length - 1; i++) {
    const p0 = path[i > 0 ? i - 1 : 0];
    const p1 = path[i];
    const p2 = path[i + 1];
    const p3 = path[i + 2 < path.length ? i + 2 : path.length - 1];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push([
        catmull(p0[0], p1[0], p2[0], p3[0], t),
        catmull(p0[1], p1[1], p2[1], p3[1], t),
        lerp(p1[2], p2[2], t)
      ]);
    }
  }
  return out;
}

// The normal at sample i, scaled to half the width there.
function normal(path, i) {
  const prev = path[Math.max(i - 1, 0)];
  const next = path[Math.min(i + 1, path.length - 1)];
  const tx = next[0] - prev[0];
  const ty = next[1] - prev[1];
  const len = Math.hypot(tx, ty) || 1;
  const r = path[i][2] / 2;
  return [(-ty / len) * r, (tx / len) * r];
}

/*
 * Fill a stroke as a ribbon: walk the centerline offset by half the width
 * along the normal, then back down the other side. That taper is not
 * possible with a per-segment lineWidth.
 */
function ribbon(ctx, path, outline) {
  if (!path.length) return;

  if (path.length === 1) {
    ctx.beginPath();
    ctx.arc(path[0][0], path[0][1], path[0][2] / 2, 0, TAU);
    if (outline) ctx.stroke(); else ctx.fill();
    return;
  }

  const left = [];
  const right = [];
  for (let i = 0; i < path.length; i++) {
    const [nx, ny] = normal(path, i);
    left.push([path[i][0] + nx, path[i][1] + ny]);
    right.push([path[i][0] - nx, path[i][1] - ny]);
  }

  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();

  // Outline mode draws only the silhouette, which is the shape a writer
  // lays down first and fills afterwards. It wants no cap discs: they would
  // ring every stroke end with a circle instead of closing it.
  if (outline) {
    ctx.stroke();
    return;
  }
  ctx.fill();

  // Caps as discs, not arcs spliced into the outline. An arc picks its
  // sweep from the sign of the angle difference, and at a stroke's end that
  // is as likely to go the long way round, notching every stroke.
  [path[0], path[path.length - 1]].forEach(end => {
    ctx.beginPath();
    ctx.arc(end[0], end[1], end[2] / 2, 0, TAU);
    ctx.fill();
  });
}

function polyline(ctx, path, width) {
  if (path.length < 2) return;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  ctx.stroke();
}

/*
 * A flat nib held at one angle. The ribbon is the area the nib sweeps, so
 * the line is fat across the nib and hairline along it. That is where a
 * marker handstyle gets its shape from, and it ignores speed entirely.
 */
function chisel(s, path, spread) {
  const { ctx, opts, view } = s;
  const half = opts.nib * view.unit * spread / 2;
  const nx = Math.cos(opts.nibAngle) * half;
  const ny = Math.sin(opts.nibAngle) * half;

  /*
   * Every segment's quad in one path, all wound the same way, filled once.
   *
   * Filling each quad on its own left a hairline seam down every shared
   * edge, where two antialiased edges do not add up to full coverage. One
   * fill takes the union instead -- but only if the windings agree. Tracing
   * the sweep as a single out-and-back outline wound the two directions
   * opposite ways, so under the nonzero rule a stroke that crossed itself
   * cancelled and punched holes through its own ink.
   */
  ctx.beginPath();
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    ctx.moveTo(ax + nx, ay + ny);
    // The segment crossed with the nib: its sign is the quad's winding.
    if ((bx - ax) * ny - (by - ay) * nx < 0) {
      ctx.lineTo(ax - nx, ay - ny);
      ctx.lineTo(bx - nx, by - ny);
      ctx.lineTo(bx + nx, by + ny);
    } else {
      ctx.lineTo(bx + nx, by + ny);
      ctx.lineTo(bx - nx, by - ny);
      ctx.lineTo(ax - nx, ay - ny);
    }
    ctx.closePath();
  }
  ctx.fill();
}

/*
 * Aerosol.
 *
 * A can throws paint in a cone, so what reaches the wall is a Gaussian: a
 * dense core falling off to nothing. This scatters dots on that curve, using
 * the same stable noise as everything else so a tag sprays the same way on
 * every repaint, then unions them in one fill. Union, not stacking: a dot
 * landing on wet paint does not double its darkness, and density reads as
 * coverage, which is what an aerosol actually does.
 */
function spray(s, p, spread) {
  const { ctx, opts } = s;
  const base = ctx.globalAlpha;

  // Overspray first, as a soft band for the grit to sit on.
  ctx.globalAlpha = base * opts.sprayHalo;
  ctx.beginPath();
  for (let i = 0; i < p.length; i++) {
    const r = p[i][2] * 0.75;
    ctx.moveTo(p[i][0] + r, p[i][1]);
    ctx.arc(p[i][0], p[i][1], r, 0, TAU);
  }
  ctx.fill();

  ctx.globalAlpha = base;
  const dot = opts.sprayDot * Math.max(spread, 1);
  ctx.beginPath();
  for (let i = 0; i < p.length; i++) {
    const half = p[i][2] / 2;
    for (let k = 0; k < opts.sprayDots; k++) {
      // Box-Muller, so the scatter is Gaussian rather than a flat disc.
      const u = Math.max(noise(i * 131 + k, 21), 1e-6);
      const a = noise(i * 131 + k, 37) * TAU;
      const r = Math.sqrt(-2 * Math.log(u)) * opts.spraySpread * half * spread;
      const x = p[i][0] + Math.cos(a) * r;
      const y = p[i][1] + Math.sin(a) * r;
      ctx.moveTo(x + dot, y);
      ctx.arc(x, y, dot, 0, TAU);
    }
  }
  ctx.fill();
}

/*
 * The line drawn more than once, each pass wandering off the true path.
 *
 * The wander is a slow wave with a little grain on top, not white noise: a
 * hand drifts away from a line and comes back, it does not vibrate. Each
 * pass carries its own seed, so the two strokes part company and meet again
 * the way a pen's do.
 */
function sketch(s, p, spread) {
  const { ctx, opts, view } = s;
  const amp = opts.sketchBow * view.unit * spread;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let pass = 0; pass < opts.sketchPasses; pass++) {
    ctx.lineWidth = Math.max(opts.hairline * spread, 0.5);
    ctx.beginPath();
    for (let i = 0; i < p.length; i++) {
      const t = i / opts.sketchWave;
      const lo = Math.floor(t);
      const f = t - lo;
      const seed = 51 + pass * 13;
      // Smoothstep between noise samples, so the bow is a wave, not a jump.
      const bow = lerp(noise(lo, seed), noise(lo + 1, seed), f * f * (3 - 2 * f)) - 0.5;
      const grain = noise(i, seed + 5) - 0.5;
      const [nx, ny] = normal(p, i);
      const len = Math.hypot(nx, ny) || 1;
      const off = (bow * 2 + grain * 0.3) * amp;
      const x = p[i][0] + (nx / len) * off;
      const y = p[i][1] + (ny / len) * off;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
}

/*
 * Haeberli's filtered pen: a brush with mass on a spring, towed along the
 * captured path. What gets drawn is the brush's path, not the hand's.
 *
 * Hooke's law toward each sample, integrated with drag, exactly as DynaDraw
 * did it in 1989. The brush cuts the inside of a corner and coasts past the
 * end of a fast stroke, and the width comes off the brush's own speed rather
 * than the hand's, so the line swells and thins on its own account.
 *
 * The filter only ever looks backwards, so the part of a stroke already on
 * screen never changes as the rest of it arrives.
 */
function dyna(s, p) {
  const { opts } = s;
  if (p.length < 2) return p;

  const out = [];
  let x = p[0][0];
  let y = p[0][1];
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < p.length; i++) {
    vx = (vx + (p[i][0] - x) * opts.dynaSpring / opts.dynaMass) * opts.dynaDrag;
    vy = (vy + (p[i][1] - y) * opts.dynaSpring / opts.dynaMass) * opts.dynaDrag;
    x += vx;
    y += vy;
    const speed = Math.hypot(vx, vy);
    out.push([x, y, Math.max(p[i][2] - speed * opts.dynaDuctus, p[i][2] * 0.15)]);
  }
  return out;
}

/* Centerline plus width ticks: the ribbon drawn as a technical diagram. */
function skeleton(ctx, path, spread) {
  polyline(ctx, path, spread);
  for (let i = 0; i < path.length; i += 2) {
    const [nx, ny] = normal(path, i);
    ctx.beginPath();
    ctx.moveTo(path[i][0] + nx, path[i][1] + ny);
    ctx.lineTo(path[i][0] - nx, path[i][1] - ny);
    ctx.stroke();
  }
}

function drawStroke(s, stroke, si, from, to, partial, spread) {
  const p = path(s, stroke, si, from, to, partial, spread);
  if (!p.length) return;

  switch (s.mode) {
    case 'chisel': return chisel(s, p, spread);
    case 'spray': return spray(s, p, spread);
    case 'outline':
      s.ctx.lineWidth = Math.max(s.opts.hairline * spread, 0.5);
      s.ctx.lineJoin = 'round';
      return ribbon(s.ctx, smooth(p, s.opts.smoothSteps), true);
    case 'sketch': return sketch(s, p, spread);
    case 'dyna': return ribbon(s.ctx, dyna(s, smooth(p, 2)));
    case 'hairline': return polyline(s.ctx, p, s.opts.hairline * spread);
    case 'skeleton': return skeleton(s.ctx, p, spread);
    // marker: a spline through the samples, so a slow hand does not staircase.
    default: return ribbon(s.ctx, smooth(p, s.opts.smoothSteps));
  }
}

/*
 * Ink for one frame.
 *
 * Fade and depth cueing both want a stroke drawn at more than one opacity
 * along its length, so either one puts it into slices: fade reads the slice's
 * age, cueing reads how far off it is. Canvas cannot shade a filled shape
 * along itself, and slicing is the way round that. With neither on, a stroke
 * is a single fill, as it always was.
 */
function drawInk(s, t, prog, fade) {
  const { ctx, opts } = s;
  const base = ctx.globalAlpha;
  const strokes = s.tag.strokes;
  const n = strokes.length;
  const cueing = !!s.views.cue;

  // How lit a sample is for its distance: full at the near face of the
  // scene, down to cueFar at the back. Under strata a stroke is one flat
  // plane, so every slice of it reads the same distance and is lit the same,
  // which is what a plane should look like.
  const cueAt = (pt, plane) => {
    const ez = s.view.at(pt[0], pt[1], plane === null ? pt[2] : plane)[2];
    return lerp(opts.cueFar, 1, s.view.nearness(ez));
  };

  for (let k = 0; k < n; k++) {
    // Painter's algorithm, and z is time, so the strokes are already sorted:
    // reversing them is the whole of it when the camera is round the back.
    const si = s.view.behind ? n - 1 - k : k;
    const stroke = strokes[si];
    const p = prog[si];
    if (!p.count) continue;
    const draw = (from, to, partial, spread) => drawStroke(s, stroke, si, from, to, partial, spread);
    const pts = stroke.points;
    const plane = s.views.strata ? pts[0][2] : null;

    ctx.fillStyle = opts.color;
    ctx.strokeStyle = opts.color;

    // Ink soaking outwards, under the stroke itself. One pass for the whole
    // stroke: the bleed is a haze, and it does not need shading.
    if (s.effects.bleed) {
      const soak = cueing ? cueAt(pts[Math.min(p.count, pts.length) - 1], plane) : 1;
      BLEED.forEach(([spread, alpha]) => {
        ctx.globalAlpha = base * soak * alpha;
        draw(0, p.count, p.partial, spread);
      });
      ctx.globalAlpha = base;
    }

    if (!fade && !cueing) {
      draw(0, p.count, p.partial, 1);
      continue;
    }

    // Slices overlap by one sample so the joins do not show as gaps.
    const slices = Math.max(1, Math.min(28, Math.ceil(p.count / 6)));
    const step = Math.ceil(p.count / slices);
    for (let from = 0; from < p.count; from += step) {
      const to = Math.min(from + step + 1, p.count);
      const last = Math.min(to, pts.length) - 1;
      const age = fade ? clamp(1 - (t - pts[last][2]) / opts.fadeWindow, 0.04, 1) : 1;
      ctx.globalAlpha = base * age * (cueing ? cueAt(pts[last], plane) : 1);
      draw(from, to, to === p.count ? p.partial : 0, 1);
    }
    ctx.globalAlpha = base;
  }
}

/*
 * Runs of ink, each drawn as one shape.
 *
 * A run leaves the pool at the stroke's own width and narrows on the way
 * down, but never to nothing: the same ink is spread over more length as it
 * stretches, so the neck thins with the fall rather than pinching shut. The
 * head is a rounded end a little fatter than the neck it hangs from. Tapering
 * to a point and dropping a disc there is what made these read as pins.
 *
 * Runs are ink, so every effect that acts on ink reaches them too: fade ages
 * them, jitter moves them with the stroke they hang off, bleed soaks them
 * outwards.
 */
function drawDrips(s, t) {
  const { ctx, opts, view, effects } = s;
  const base = ctx.globalAlpha;
  const jitter = jitterAmount(s);

  ctx.fillStyle = opts.color;

  s.tag.drips.forEach(d => {
    const age = t - d.born;
    if (age <= 0) return;
    // Ease out: a run accelerates away from the pool, then slows as it thins.
    const p = 1 - Math.pow(1 - clamp(age / d.fall, 0, 1), 2.2);
    const len = d.length * p;
    if (len <= 0) return;

    const alpha = effects.fade ? clamp(1 - age / opts.fadeWindow, 0.04, 1) : 1;

    const [jx, jy] = jitterAt(jitter, d.si, d.i);
    // A run hangs in the plane of the moment it started, so both ends carry
    // the same time, and it falls straight down in the drawing, whichever
    // way that points once the camera has turned. Both ends take the
    // sample's own jitter too, or the run comes away from its stroke.
    const [px, py, , k0] = view.at(d.x, d.y, d.born);
    const [qx, qy] = view.at(d.x, d.y + len, d.born);
    const x0 = px + jx;
    const y0 = py + jy;
    const fx = qx - px;
    const fy = qy - py;
    const fall = Math.hypot(fx, fy);
    if (fall < 1e-3) return;
    // Across the fall. The run's width lies along this, and it wanders the
    // other way, which is the side the flat player always leaned to.
    const ax = -fy / fall;
    const ay = fx / fall;

    // A fraction of the fall, not a fixed offset. Sized against the frame it
    // out-ran a short run and sent it sideways, which is not how gravity works.
    const drift = -d.drift * opts.dripDrift * fall;
    // Stretching the same ink further leaves less of it across the neck.
    const half = (d.width * view.unit / 2) * (1 - opts.dripStretch * p) * k0;

    const run = (spread, soak) => {
      ctx.globalAlpha = base * alpha * soak;
      const wide = half * spread;
      const point = k => {
        const f = k / DRIP_STEPS;
        const off = drift * f * f;
        return {
          x: x0 + fx * f + ax * off,
          y: y0 + fy * f + ay * off,
          half: wide * (1 - opts.dripTaper * f)
        };
      };
      const head = point(DRIP_STEPS);
      const across = Math.atan2(ay, ax);

      ctx.beginPath();
      ctx.moveTo(x0 + ax * wide, y0 + ay * wide);
      for (let k = 1; k <= DRIP_STEPS; k++) { const l = point(k); ctx.lineTo(l.x + ax * l.half, l.y + ay * l.half); }
      // The head closes the shape, so it cannot detach from the neck. Half a
      // turn about the fall, so it caps the end rather than cutting it.
      ctx.arc(head.x, head.y, head.half * opts.dripHead, across, across - Math.PI, true);
      for (let k = DRIP_STEPS; k >= 1; k--) { const r = point(k); ctx.lineTo(r.x - ax * r.half, r.y - ay * r.half); }
      ctx.lineTo(x0 - ax * wide, y0 - ay * wide);
      ctx.closePath();
      ctx.fill();
    };

    if (effects.bleed) BLEED.forEach(([spread, soak]) => run(spread, soak));
    run(1, 1);
  });

  ctx.globalAlpha = base;
}

/* --- dust -------------------------------------------------------------- */

/*
 * A field of dust the drawing pushes around, after Evan Roth's 3D fork.
 *
 * Particles start on a regular grid over the tag and stay put until the
 * drawing head passes. The head's own motion is injected into a coarse
 * velocity field, the particles read whichever cell they are standing in,
 * and the field decays. Once a particle has moved it is awake for good, and
 * remembers the moment it woke: that is the depth it hangs at, so the dust
 * has the same thickness in time the tag does.
 *
 * This is a simulation, so it cannot live inside paint(), which has to stay
 * a pure function of the clock. The player owns one of these, steps it, and
 * hands it to paint() to draw. Seeking or looping resets it, because there
 * is no way to run a field like this backwards.
 */
export class Dust {
  constructor(tag, options) {
    const opts = { ...DEFAULTS, ...options };
    const b = tag.bounds;
    const side = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1e-3) * (1 + opts.dustMargin * 2);

    this.opts = opts;
    this.tag = tag;
    // Not a square grid over a square field: the cells are wider than they
    // are tall, so the dust answers a sideways push harder than an upward
    // one. That lean is the fork's, and taking it out stands the fan up.
    this.cols = opts.dustCols;
    this.rows = opts.dustRows;
    this.cw = side / this.cols;
    this.ch = side / this.rows;
    this.x0 = (b.x0 + b.x1) / 2 - side / 2;
    this.y0 = (b.y0 + b.y1) / 2 - side / 2;

    const count = this.cols * this.rows;
    this.count = count;
    this.posX = new Float32Array(count);
    this.posY = new Float32Array(count);
    this.oriX = new Float32Array(count);
    this.oriY = new Float32Array(count);
    this.velX = new Float32Array(count);
    this.velY = new Float32Array(count);
    this.woke = new Uint8Array(count);
    this.wokeAt = new Float32Array(count);
    this.fieldX = new Float32Array(count);
    this.fieldY = new Float32Array(count);
    this.live = 0;
    this.reset();
  }

  reset() {
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        this.posX[k] = this.oriX[k] = this.x0 + (i + 0.5) * this.cw;
        this.posY[k] = this.oriY[k] = this.y0 + (j + 0.5) * this.ch;
      }
    }
    this.velX.fill(0);
    this.velY.fill(0);
    this.woke.fill(0);
    this.wokeAt.fill(0);
    this.fieldX.fill(0);
    this.fieldY.fill(0);
    this.last = null;
    this.live = 0;
    return this;
  }

  // The head's own motion goes into the field as velocity, falling off with
  // distance, over a few cells around wherever it is.
  inject(x, y) {
    if (!this.last) { this.last = [x, y]; return; }
    const dx = x - this.last[0];
    const dy = y - this.last[1];
    this.last = [x, y];
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;

    const opts = this.opts;
    const cx = (x - this.x0) / this.cw;
    const cy = (y - this.y0) / this.ch;
    const vx = (dx / this.cw) * opts.dustInjectScale;
    const vy = (dy / this.ch) * opts.dustInjectScale;
    const R = opts.dustInjectRadius;

    const iMin = Math.max(0, Math.floor(cx - R));
    const iMax = Math.min(this.cols - 1, Math.ceil(cx + R));
    const jMin = Math.max(0, Math.floor(cy - R));
    const jMax = Math.min(this.rows - 1, Math.ceil(cy + R));
    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const d = Math.hypot(i - cx, j - cy);
        if (d >= R) continue;
        const w = opts.dustInjectStrength * (1 - d / R);
        const k = j * this.cols + i;
        this.fieldX[k] += vx * w;
        this.fieldY[k] += vy * w;
      }
    }
  }

  step(dt, t) {
    const opts = this.opts;
    const head = Math.min(t, this.tag.duration);

    // Whichever stroke is being written now, and where along it. Later
    // strokes first, so an overlap resolves to the one on top.
    if (t <= this.tag.duration) {
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

    // Past the end the field lets go and what is airborne falls.
    const g = t > this.tag.duration ? opts.dustGravity * dt : 0;
    const drag = Math.min(1, opts.dustFriction * dt);
    const push = opts.dustReactivity * dt;
    let live = 0;

    for (let k = 0; k < this.count; k++) {
      if (!this.woke[k] && (this.posX[k] !== this.oriX[k] || this.posY[k] !== this.oriY[k])) {
        this.woke[k] = 1;
        this.wokeAt[k] = head;
      }
      let ci = ((this.posX[k] - this.x0) / this.cw) | 0;
      let cj = ((this.posY[k] - this.y0) / this.ch) | 0;
      ci = ci < 0 ? 0 : ci >= this.cols ? this.cols - 1 : ci;
      cj = cj < 0 ? 0 : cj >= this.rows ? this.rows - 1 : cj;
      const c = cj * this.cols + ci;

      this.velX[k] += this.fieldX[c] * push;
      this.velY[k] += this.fieldY[c] * push;
      if (g && this.woke[k]) this.velY[k] += g;
      this.velX[k] -= this.velX[k] * drag;
      this.velY[k] -= this.velY[k] * drag;
      this.posX[k] += this.velX[k] * dt;
      this.posY[k] += this.velY[k] * dt;
      if (this.woke[k]) live++;
    }

    for (let k = 0; k < this.count; k++) {
      this.fieldX[k] *= opts.dustDecay;
      this.fieldY[k] *= opts.dustDecay;
    }
    this.live = live;
    return this;
  }
}

/*
 * Dust and its trails, added rather than painted over, so crossings pile up
 * into the bright core the fork's additive blending gives.
 *
 * Canvas cannot shade one line from bright to nothing, so a trail is drawn
 * as a few batched passes: the whole length faintest, then shorter and
 * shorter pieces nearest the particle, each a little brighter. Two paths per
 * pass rather than a gradient per particle, which is what keeps 15,000 of
 * them inside a frame.
 */
function drawDust(s, dust, fade) {
  const { ctx, opts, view } = s;
  if (!dust || !dust.live) return;

  const steps = Math.max(1, Math.round(opts.dustTrailSteps));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = opts.color;
  ctx.fillStyle = opts.color;
  ctx.lineWidth = 1;

  for (let pass = 0; pass < steps; pass++) {
    // Pass 0 is the whole trail, the last is just the tip.
    const from = pass / steps;
    ctx.globalAlpha = (opts.dustTrail / steps) * fade;
    ctx.beginPath();
    for (let k = 0; k < dust.count; k++) {
      if (!dust.woke[k]) continue;
      const z = dust.wokeAt[k];
      const [px, py] = view.at(dust.posX[k], dust.posY[k], z);
      const [ox, oy] = view.at(dust.oriX[k], dust.oriY[k], z);
      ctx.moveTo(lerp(ox, px, from), lerp(oy, py, from));
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  ctx.globalAlpha = opts.dustAlpha * fade;
  ctx.beginPath();
  for (let k = 0; k < dust.count; k++) {
    if (!dust.woke[k]) continue;
    const [px, py, , scale] = view.at(dust.posX[k], dust.posY[k], dust.wokeAt[k]);
    const r = Math.max(opts.dustDot * view.unit * scale, 0.6);
    ctx.rect(px - r, py - r, r * 2, r * 2);
  }
  ctx.fill();
  ctx.restore();
}

/* --- data layers ------------------------------------------------------- */

function drawBounds(s) {
  const { ctx, view } = s;
  ctx.save();
  ctx.lineWidth = 1;

  // The capture screen has no moment of its own, so with depth on it sits at
  // the middle of the tag's time and the writing passes through it.
  const mid = s.tag.duration / 2;
  const P = (x, y) => view.at(x, y, mid);
  const line = (x0, y0, x1, y1) => {
    const a = P(x0, y0);
    const b = P(x1, y1);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  };
  // A projected rectangle is still four straight edges, but only the corners
  // land where strokeRect would put them.
  const box = (x0, y0, x1, y1) => {
    ctx.beginPath();
    line(x0, y0, x1, y0);
    line(x1, y0, x1, y1);
    line(x1, y1, x0, y1);
    line(x0, y1, x0, y0);
    ctx.stroke();
  };

  // Normalized capture space, ticked every 0.1.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const g = i / 10;
    line(g, 0, g, 1);
    line(0, g, 1, g);
  }
  ctx.stroke();

  // The capture screen itself.
  ctx.strokeStyle = 'rgba(255,255,255,0.24)';
  ctx.setLineDash([2, 3]);
  box(0, 0, 1, 1);

  // What the tag actually occupies.
  const b = s.tag.bounds;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.setLineDash([5, 4]);
  box(b.x0, b.y0, b.x1, b.y1);

  // Pinned to the frame. Anchored to the box, it landed on the tag or on
  // the speed graph, depending on the shape.
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '500 10px ' + MONO;
  ctx.fillText(
    'BBOX ' + b.x0.toFixed(3) + ',' + b.y0.toFixed(3) + ' → ' + b.x1.toFixed(3) + ',' + b.y1.toFixed(3),
    8, 14
  );

  // Origin crosshair.
  const [ox, oy] = P(0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(ox - 7, oy);
  ctx.lineTo(ox + 7, oy);
  ctx.moveTo(ox, oy - 7);
  ctx.lineTo(ox, oy + 7);
  ctx.stroke();
  ctx.restore();
}

function drawPoints(s, prog) {
  const { ctx, view } = s;
  ctx.save();
  ctx.font = '500 9px ' + MONO;

  s.tag.strokes.forEach((stroke, si) => {
    const count = prog[si].count;
    if (!count) return;
    const pts = stroke.points;

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < count; i++) {
      const [x, y] = view.at(pts[i][0], pts[i][1], pts[i][2]);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }

    // Where each stroke begins, numbered in capture order.
    const [sx, sy] = view.at(pts[0][0], pts[0][1], pts[0][2]);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, TAU);
    ctx.fill();
    ctx.fillText('S' + String(si + 1).padStart(2, '0'), sx + 6, sy - 5);
  });
  ctx.restore();
}

function drawVectors(s, prog) {
  const { ctx, view, tag } = s;
  ctx.save();
  ctx.lineWidth = Math.max(view.unit * 0.0024, 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  tag.strokes.forEach((stroke, si) => {
    const count = prog[si].count;
    if (count < 2) return;
    const pts = stroke.points;
    // Every 4th sample, or the overlay becomes a solid mat of arrows.
    for (let i = 1; i < count; i += 4) {
      const mag = clamp(stroke.speed[i] / tag.peakSpeed, 0, 1);
      // Sized against the artwork rather than in fixed pixels, and never
      // shorter than a stub: a slow tag used to draw arrows too small to see.
      const reach = view.unit * (0.024 + mag * 0.055);
      // The heading has to be taken after projecting, or a turned camera
      // leaves every arrow pointing the way the hand went on a flat screen.
      const [px, py] = view.at(pts[i - 1][0], pts[i - 1][1], pts[i - 1][2]);
      const [x, y] = view.at(pts[i][0], pts[i][1], pts[i][2]);
      const a = Math.atan2(y - py, x - px);
      const tx = x + Math.cos(a) * reach;
      const ty = y + Math.sin(a) * reach;
      const head = reach * 0.34;

      ctx.strokeStyle = 'rgba(255,255,255,' + (0.4 + mag * 0.5).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tx, ty);
      // A head on each, so an arrow says which way the hand was going.
      ctx.lineTo(tx - Math.cos(a - 0.42) * head, ty - Math.sin(a - 0.42) * head);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(a + 0.42) * head, ty - Math.sin(a + 0.42) * head);
      ctx.stroke();
    }
  });
  ctx.restore();
}

/* Speed over the whole tag, with a playhead. Drawn along the bottom edge. */
function drawSpeedGraph(s, t) {
  const { ctx, view, tag } = s;
  const h = 34;
  const y = view.h - h - 8;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, y + h);
  ctx.lineTo(view.w - 8, y + h);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  let started = false;
  tag.strokes.forEach(stroke => {
    stroke.points.forEach((p, i) => {
      const gx = 8 + (p[2] / tag.duration) * (view.w - 16);
      const gy = y + h - clamp(stroke.speed[i] / tag.peakSpeed, 0, 1) * h;
      if (!started) { ctx.moveTo(gx, gy); started = true; } else ctx.lineTo(gx, gy);
    });
  });
  ctx.stroke();

  const px = 8 + (t / tag.duration) * (view.w - 16);
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(px, y - 4);
  ctx.lineTo(px, y + h);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '500 9px ' + MONO;
  ctx.fillText('SPEED', 8, y - 6);
  // Right-aligned, not offset by a guess at how wide it is. A fast tag reads
  // in the hundreds, and the guess ran it off the edge.
  ctx.textAlign = 'right';
  ctx.fillText(tag.peakSpeed.toFixed(2) + ' u/s PEAK', view.w - 8, y - 6);
  ctx.restore();
}

/* --- ghost ------------------------------------------------------------- */

/*
 * A layer the size of the frame for the ghost to be drawn solid on, so
 * paint() can lay it down once at ghostAlpha. Drawn straight onto the frame
 * it was hundreds of translucent fills, and wherever two overlapped the
 * alpha stacked. A marker stroke is a body and two cap discs, so every
 * stroke ended in a dot twice as bright as its ghost, and so did every
 * crossing.
 *
 * One layer per context, kept between frames and sized to the frame's own
 * scale so it stays sharp on a dense screen. Null where nothing can make a
 * canvas, which is Node without one; paint() then draws the ghost the old
 * way.
 */
const ghosts = new WeakMap();

/*
 * Everything the ghost's picture depends on, other than the tag itself and
 * the size of the layer, which are checked separately. Redrawing it costs
 * more than the rest of the frame put together, so it is worth being exact
 * about when it has to happen.
 *
 * The camera is in here, which means depth gets no benefit while the tag is
 * turning. Nothing to be done about that: a moving camera is a new picture.
 */
function ghostKey(s) {
  const o = s.opts;
  const c = s.camera;
  return [
    // Dust is in here because it moves the drawing back to make room, which
    // makes the ghost a different picture.
    s.mode, s.effects.bleed ? 1 : 0, s.effects.jitter ? 1 : 0,
    s.effects.depth ? 1 : 0, s.effects.dust ? 1 : 0,
    s.views.cue ? 1 : 0, s.views.strata ? 1 : 0, s.views.ortho ? 1 : 0,
    o.color, o.pad, o.smoothSteps, o.hairline, o.nib, o.nibAngle, o.jitter,
    s.effects.depth ? [c.yaw, c.pitch, c.dist, o.depthSpan, o.depthZoom] : ''
  ].join('|');
}

// Returns the layer plus a context to draw on, or a null context when what
// is already on the layer is still the right picture.
function ghostLayer(ctx, w, h, key, tag) {
  let make;
  if (typeof OffscreenCanvas !== 'undefined') make = () => new OffscreenCanvas(1, 1);
  else if (typeof document !== 'undefined') make = () => document.createElement('canvas');
  else return null;

  const m = ctx.getTransform();
  const pw = Math.max(1, Math.ceil(w * m.a));
  const ph = Math.max(1, Math.ceil(h * m.d));

  let layer = ghosts.get(ctx);
  if (!layer) {
    layer = { canvas: make(), key: null, tag: null };
    ghosts.set(ctx, layer);
  }
  const canvas = layer.canvas;
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    // Resizing a canvas wipes it, so whatever was cached is gone.
    layer.key = null;
  }
  if (layer.key === key && layer.tag === tag) return { canvas, ctx: null };

  layer.key = key;
  layer.tag = tag;
  const lctx = canvas.getContext('2d');
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, pw, ph);
  lctx.setTransform(m.a, 0, 0, m.d, 0, 0);
  return { canvas, ctx: lctx };
}

/* --- frame ------------------------------------------------------------- */

/*
 * Draw one frame of a prepared tag. Set the context's transform first if
 * the canvas is scaled for device pixels; w and h are in transformed units.
 *
 *   time     seconds into the tag
 *   w, h     frame size
 *   mode     one of MODES
 *   effects  { ghost, bleed, jitter, fade, depth }, each true or false
 *   layers   { ink, drips, vectors, points, bounds, graph }, each true or false
 *   camera   { yaw, pitch, dist } when depth is on. Radians and multiples of
 *            the tag's own size. Straight ahead by default.
 *   views    { cue, strata, ortho }, each true or false. How the depth is
 *            looked at. Nothing without depth.
 *   opts     any of DEFAULTS. Pass the same options prepare() was given.
 */
export function paint(ctx, tag, frame) {
  const opts = { ...DEFAULTS, ...frame.opts };
  const t = frame.time || 0;
  const effects = frame.effects || {};
  const views = frame.views || {};
  const camera = { yaw: 0, pitch: 0, dist: opts.depthDist, ...frame.camera };
  // Dust needs room, so the drawing takes up less of the frame when it is
  // on. Solved as padding rather than a zoom, so the stroke widths, which
  // follow the drawing's own size, come down with it.
  const pad = effects.dust
    ? (1 - opts.dustFit * (1 - opts.pad * 2)) / 2
    : opts.pad;
  const flat = fit(tag.bounds, frame.w, frame.h, pad);
  const s = {
    ctx,
    tag,
    opts,
    camera,
    views,
    view: effects.depth ? orbit(flat, tag.duration, camera, opts, views) : flat,
    mode: frame.mode || 'marker',
    effects,
    layers: frame.layers || { ink: true, drips: true }
  };
  const { layers } = s;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, frame.w, frame.h);

  if (layers.bounds) drawBounds(s);

  const prog = progress(tag.strokes, t);

  // Where the tag is going, faint under where it has got to. Drawn at the
  // end of the timeline, so fade would age all but the last second of it
  // away and leave the preview in pieces. It is a preview, not ink: it does
  // not age.
  if (layers.ink && effects.ghost) {
    const whole = () => tag.strokes.map(st => ({ count: st.points.length, partial: 0 }));
    const layer = ghostLayer(ctx, frame.w, frame.h, ghostKey(s), tag);
    if (layer) {
      // The same picture on every frame of a playthrough, so it is drawn
      // once and kept. It used to be redrawn 60 times a second, which cost
      // more than the ink that was actually changing.
      if (layer.ctx) drawInk({ ...s, ctx: layer.ctx }, tag.duration, whole(), false);
      ctx.globalAlpha = opts.ghostAlpha;
      ctx.drawImage(layer.canvas, 0, 0, frame.w, frame.h);
    } else {
      ctx.globalAlpha = opts.ghostAlpha;
      drawInk(s, tag.duration, whole(), false);
    }
    ctx.globalAlpha = 1;
  }

  // The body, swept back from the drawing and laid down before it, so the
  // ink itself stays the front face. Along the time axis when depth is on,
  // where the body is literally the tag's own history; otherwise a fixed
  // lean, which is how a writer blocks a letter out.
  if (layers.ink && effects.extrude) {
    const steps = Math.max(1, Math.round(opts.extrudeSteps));
    ctx.globalAlpha = opts.extrudeBack;
    for (let i = steps; i >= 1; i--) {
      const f = i / steps;
      s.offset = effects.depth
        ? { dx: 0, dy: 0, dt: -f * opts.extrudeDepth * tag.duration }
        : { dx: f * opts.extrudeLean[0] * flat.unit, dy: f * opts.extrudeLean[1] * flat.unit, dt: 0 };
      drawInk(s, t, prog, false);
    }
    s.offset = null;
    ctx.globalAlpha = 1;
  }

  // Dust goes down under the ink, and lets go with it: once the tag is
  // finished the whole field falls and fades out before the loop restarts.
  if (effects.dust && frame.dust) {
    const over = (t - tag.duration) / Math.max(opts.loopDelay / 1000, 1e-3);
    drawDust(s, frame.dust, clamp(1 - over, 0, 1));
  }

  const artwork = state => {
    if (layers.ink) drawInk(state, t, prog, !!effects.fade);
    if (layers.drips) drawDrips(state, t);
  };

  if (effects.stereo && effects.depth) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    [[-1, opts.stereoLeft], [1, opts.stereoRight]].forEach(([eye, color]) => {
      artwork({
        ...s,
        view: orbit(flat, tag.duration, { ...camera, yaw: camera.yaw + eye * opts.stereoEye }, opts, views),
        opts: { ...opts, color }
      });
    });
    ctx.restore();
  } else {
    artwork(s);
  }

  if (layers.vectors) drawVectors(s, prog);
  if (layers.graph) drawSpeedGraph(s, t);
  if (layers.points) drawPoints(s, prog);
  ctx.restore();
}

/* --- player ------------------------------------------------------------ */

/*
 * A <canvas> that plays a tag in real time from the recorded timestamps.
 *
 * The canvas sizes itself to its parent, so give that element the
 * dimensions you want. `tag` is the shape parse() returns, and may be left
 * out and load()ed later. Events: 'load' with the prepared tag, 'frame' with
 * { time, duration }, 'state' with { playing }.
 */
export class GmlPlayer {
  constructor(canvas, tag, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { ...DEFAULTS, ...options };
    this.layers = { ink: true, drips: true, vectors: false, points: false, bounds: false, graph: false };
    // Depth is on by default on this branch, because it is the point of it.
    // Off, this player is identical to the flat one and the whole thing
    // looks broken.
    this.effects = { ghost: true, bleed: false, jitter: false, fade: false, depth: true, extrude: false, stereo: false, dust: false };
    this.views = { cue: false, strata: false, ortho: false };
    this.mode = 'marker';
    this.playing = false;
    this.time = 0;
    this.camera = { yaw: 0, pitch: this.opts.depthPitch, dist: this.opts.depthDist };
    this.listeners = {};
    this.load(tag);

    this.orbitInput();
    this.onResize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentNode || canvas);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
    }
    this.resize();
  }

  /*
   * Drag to turn the tag, wheel to move in and out. Only while depth is on:
   * flat, the canvas has to stay an ordinary part of the page, where a drag
   * selects and a touch scrolls.
   */
  orbitInput() {
    const canvas = this.canvas;
    if (!canvas.addEventListener) return;
    // setEffect does this on a toggle, but depth can also start switched on,
    // and then nothing would have claimed the touch gesture.
    if (this.effects.depth && canvas.style) canvas.style.touchAction = 'none';
    let last = null;

    const down = e => {
      if (!this.effects.depth) return;
      last = [e.clientX, e.clientY];
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not captureable */ }
      }
    };
    const move = e => {
      if (!last) return;
      const dx = e.clientX - last[0];
      const dy = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      this.camera.yaw += dx * this.opts.orbitSpeed;
      // Short of straight overhead, where the tag goes edge-on and the
      // camera would tip over the top.
      this.camera.pitch = clamp(this.camera.pitch + dy * this.opts.orbitSpeed, -1.3, 1.3);
      if (!this.playing) this.render();
    };
    const up = () => { last = null; };
    const wheel = e => {
      if (!this.effects.depth) return;
      e.preventDefault();
      this.camera.dist = clamp(this.camera.dist * (1 + e.deltaY * this.opts.zoomSpeed), 1.2, 8);
      if (!this.playing) this.render();
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    // Not passive: it has to be able to keep the page from scrolling under a
    // zoom, and the guard above means it only ever does that in depth.
    canvas.addEventListener('wheel', wheel, { passive: false });

    this.offOrbit = () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }

  on(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
    return this;
  }

  emit(name, payload) {
    (this.listeners[name] || []).forEach(fn => fn(payload));
  }

  get duration() { return this.tag.duration; }

  // Swap the tag. Mode, effects and layers stay as they were.
  load(tag) {
    this.tag = prepare(tag, this.opts);
    this.time = 0;
    // Built on demand: it is 15,000 particles, and most playbacks never
    // switch it on.
    this.dust = null;
    this.emit('load', this.tag);
    if (this.w) this.render();
    return this;
  }

  resize() {
    const host = this.canvas.parentNode || this.canvas;
    const w = Math.max(host.clientWidth || this.canvas.clientWidth, 1);
    const h = Math.max(host.clientHeight || this.canvas.clientHeight, 1);
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.render();
    return this;
  }

  render() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    paint(this.ctx, this.tag, {
      time: this.time,
      w: this.w,
      h: this.h,
      mode: this.mode,
      effects: this.effects,
      layers: this.layers,
      camera: this.camera,
      views: this.views,
      dust: this.dust,
      opts: this.opts
    });
    this.emit('frame', { time: this.time, duration: this.tag.duration });
    return this;
  }

  play() {
    if (this.playing) return this;
    this.playing = true;
    this.last = null;

    const step = now => {
      if (!this.playing) return;
      if (this.last === null) this.last = now;
      const dt = Math.min((now - this.last) / 1000, 0.1) * this.opts.speed;
      this.last = now;
      this.time += dt;
      // The turn rides on playback, so it keeps time with the speed control
      // and stops dead when you pause to look at something.
      if (this.effects.depth) this.camera.yaw += this.opts.autoRotate * dt;
      // A field cannot be run backwards, so the dust follows the clock
      // forwards and starts again whenever the clock does.
      if (this.effects.dust) this.wake().step(dt, this.time);

      // Hold on the finished tag before starting over.
      if (this.time >= this.tag.duration + this.opts.loopDelay / 1000) {
        if (this.opts.loop) { this.time = 0; if (this.dust) this.dust.reset(); }
        else { this.time = this.tag.duration; this.pause(); this.render(); return; }
      }
      this.render();
      this.raf = globalThis.requestAnimationFrame(step);
    };
    this.raf = globalThis.requestAnimationFrame(step);
    this.emit('state', { playing: true });
    return this;
  }

  pause() {
    // Only when something changes. Scrubbing pauses on every input event,
    // and each one used to cancel a stale frame and announce a state the
    // listeners were already showing.
    if (!this.playing) return this;
    this.playing = false;
    if (this.raf) globalThis.cancelAnimationFrame(this.raf);
    this.emit('state', { playing: false });
    return this;
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  // The dust field, made the first time something asks for it.
  wake() {
    if (!this.dust) this.dust = new Dust(this.tag, this.opts);
    return this.dust;
  }

  seek(t) {
    this.time = clamp(t, 0, this.tag.duration);
    // Scrubbing lands somewhere the field never travelled to, so it starts
    // over rather than showing a history that did not happen.
    if (this.dust) this.dust.reset();
    return this.render();
  }

  setLayer(name, on) {
    if (!LAYERS.includes(name)) return this;
    this.layers[name] = !!on;
    return this.render();
  }

  setEffect(name, on) {
    if (!EFFECTS.includes(name)) return this;
    this.effects[name] = !!on;
    // Depth takes the drag gesture over, so it also has to take the touch
    // gesture the browser would otherwise spend on scrolling the page.
    if (name === 'depth' && this.canvas.style) this.canvas.style.touchAction = on ? 'none' : '';
    return this.render();
  }

  setView(name, on) {
    if (!VIEWS.includes(name)) return this;
    this.views[name] = !!on;
    return this.render();
  }

  setMode(name) {
    if (!MODES.includes(name)) return this;
    this.mode = name;
    return this.render();
  }

  setSpeed(rate) {
    this.opts.speed = rate;
    return this;
  }

  destroy() {
    this.pause();
    if (this.offOrbit) this.offOrbit();
    if (this.observer) this.observer.disconnect();
    else if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
  }
}
