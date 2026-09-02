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
export const MODES = ['marker', 'chisel', 'hairline', 'skeleton'];

// Combinable treatments applied on top of whichever mode is active.
export const EFFECTS = ['ghost', 'bleed', 'jitter', 'fade'];

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

  // Breathing room around the drawing, as a fraction of the frame.
  pad: 0.08,

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
    y: v => oy + v * scale
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

  for (let i = from; i < to; i++) {
    const [jx, jy] = jitterAt(jitter, si, i);
    out.push([view.x(pts[i][0]) + jx, view.y(pts[i][1]) + jy, stroke.width[i] * view.unit * spread]);
  }
  if (partial > 0 && to < pts.length && to > from) {
    const a = pts[to - 1];
    const b = pts[to];
    out.push([
      view.x(lerp(a[0], b[0], partial)),
      view.y(lerp(a[1], b[1], partial)),
      lerp(stroke.width[to - 1], stroke.width[to], partial) * view.unit * spread
    ]);
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
function ribbon(ctx, path) {
  if (!path.length) return;

  if (path.length === 1) {
    ctx.beginPath();
    ctx.arc(path[0][0], path[0][1], path[0][2] / 2, 0, TAU);
    ctx.fill();
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
    case 'hairline': return polyline(s.ctx, p, s.opts.hairline * spread);
    case 'skeleton': return skeleton(s.ctx, p, spread);
    // marker: a spline through the samples, so a slow hand does not staircase.
    default: return ribbon(s.ctx, smooth(p, s.opts.smoothSteps));
  }
}

/*
 * Ink for one frame. With fade on, each stroke is drawn in slices whose
 * opacity falls off with age, leaving a comet tail.
 */
function drawInk(s, t, prog, fade) {
  const { ctx, opts } = s;
  const base = ctx.globalAlpha;

  s.tag.strokes.forEach((stroke, si) => {
    const p = prog[si];
    if (!p.count) return;
    const draw = (from, to, partial, spread) => drawStroke(s, stroke, si, from, to, partial, spread);

    ctx.fillStyle = opts.color;
    ctx.strokeStyle = opts.color;

    // Ink soaking outwards, under the stroke itself.
    if (s.effects.bleed) {
      BLEED.forEach(([spread, alpha]) => {
        ctx.globalAlpha = base * alpha;
        draw(0, p.count, p.partial, spread);
      });
      ctx.globalAlpha = base;
    }

    if (!fade) {
      draw(0, p.count, p.partial, 1);
      return;
    }

    // Slices overlap by one sample so the joins do not show as gaps.
    const pts = stroke.points;
    const slices = Math.max(1, Math.min(28, Math.ceil(p.count / 6)));
    const step = Math.ceil(p.count / slices);
    for (let from = 0; from < p.count; from += step) {
      const to = Math.min(from + step + 1, p.count);
      const last = Math.min(to, pts.length) - 1;
      ctx.globalAlpha = base * clamp(1 - (t - pts[last][2]) / opts.fadeWindow, 0.04, 1);
      draw(from, to, to === p.count ? p.partial : 0, 1);
    }
    ctx.globalAlpha = base;
  });
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
    const x = view.x(d.x) + jx;
    const y0 = view.y(d.y) + jy;
    const y1 = view.y(d.y + len) + jy;
    // A fraction of the fall, not a fixed offset. Sized against the frame it
    // out-ran a short run and sent it sideways, which is not how gravity works.
    const drift = d.drift * opts.dripDrift * (y1 - y0);
    // Stretching the same ink further leaves less of it across the neck.
    const half = (d.width * view.unit / 2) * (1 - opts.dripStretch * p);

    const run = (spread, soak) => {
      ctx.globalAlpha = base * alpha * soak;
      const wide = half * spread;
      const point = k => {
        const f = k / DRIP_STEPS;
        return { x: x + drift * f * f, y: lerp(y0, y1, f), half: wide * (1 - opts.dripTaper * f) };
      };
      const head = point(DRIP_STEPS);

      ctx.beginPath();
      ctx.moveTo(x - wide, y0);
      for (let k = 1; k <= DRIP_STEPS; k++) { const l = point(k); ctx.lineTo(l.x - l.half, l.y); }
      // The head closes the shape, so it cannot detach from the neck.
      ctx.arc(head.x, head.y, head.half * opts.dripHead, Math.PI, 0, true);
      for (let k = DRIP_STEPS; k >= 1; k--) { const r = point(k); ctx.lineTo(r.x + r.half, r.y); }
      ctx.lineTo(x + wide, y0);
      ctx.closePath();
      ctx.fill();
    };

    if (effects.bleed) BLEED.forEach(([spread, soak]) => run(spread, soak));
    run(1, 1);
  });

  ctx.globalAlpha = base;
}

/* --- data layers ------------------------------------------------------- */

function drawBounds(s) {
  const { ctx, view } = s;
  ctx.save();
  ctx.lineWidth = 1;

  // Normalized capture space, ticked every 0.1.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const g = i / 10;
    ctx.moveTo(view.x(g), view.y(0));
    ctx.lineTo(view.x(g), view.y(1));
    ctx.moveTo(view.x(0), view.y(g));
    ctx.lineTo(view.x(1), view.y(g));
  }
  ctx.stroke();

  // The capture screen itself.
  ctx.strokeStyle = 'rgba(255,255,255,0.24)';
  ctx.setLineDash([2, 3]);
  ctx.strokeRect(view.x(0), view.y(0), view.scale, view.scale);
  ctx.setLineDash([]);

  // What the tag actually occupies.
  const b = s.tag.bounds;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(view.x(b.x0), view.y(b.y0), (b.x1 - b.x0) * view.scale, (b.y1 - b.y0) * view.scale);

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
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(view.x(0) - 7, view.y(0));
  ctx.lineTo(view.x(0) + 7, view.y(0));
  ctx.moveTo(view.x(0), view.y(0) - 7);
  ctx.lineTo(view.x(0), view.y(0) + 7);
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
      ctx.fillRect(view.x(pts[i][0]) - 1, view.y(pts[i][1]) - 1, 2, 2);
    }

    // Where each stroke begins, numbered in capture order.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(view.x(pts[0][0]), view.y(pts[0][1]), 3, 0, TAU);
    ctx.fill();
    ctx.fillText('S' + String(si + 1).padStart(2, '0'), view.x(pts[0][0]) + 6, view.y(pts[0][1]) - 5);
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
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      const mag = clamp(stroke.speed[i] / tag.peakSpeed, 0, 1);
      // Sized against the artwork rather than in fixed pixels, and never
      // shorter than a stub: a slow tag used to draw arrows too small to see.
      const reach = view.unit * (0.024 + mag * 0.055);
      const a = Math.atan2(dy, dx);
      const x = view.x(pts[i][0]);
      const y = view.y(pts[i][1]);
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
  ctx.fillText(tag.peakSpeed.toFixed(2) + ' u/s PEAK', view.w - 88, y - 6);
  ctx.restore();
}

/* --- frame ------------------------------------------------------------- */

/*
 * Draw one frame of a prepared tag. Set the context's transform first if
 * the canvas is scaled for device pixels; w and h are in transformed units.
 *
 *   time     seconds into the tag
 *   w, h     frame size
 *   mode     one of MODES
 *   effects  { ghost, bleed, jitter, fade }, each true or false
 *   layers   { ink, drips, vectors, points, bounds, graph }, each true or false
 *   opts     any of DEFAULTS. Pass the same options prepare() was given.
 */
export function paint(ctx, tag, frame) {
  const opts = { ...DEFAULTS, ...frame.opts };
  const t = frame.time || 0;
  const s = {
    ctx,
    tag,
    opts,
    view: fit(tag.bounds, frame.w, frame.h, opts.pad),
    mode: frame.mode || 'marker',
    effects: frame.effects || {},
    layers: frame.layers || { ink: true, drips: true }
  };
  const { layers, effects } = s;

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
    const whole = tag.strokes.map(st => ({ count: st.points.length, partial: 0 }));
    ctx.globalAlpha = opts.ghostAlpha;
    drawInk(s, tag.duration, whole, false);
    ctx.globalAlpha = 1;
  }

  if (layers.ink) drawInk(s, t, prog, !!effects.fade);
  if (layers.drips) drawDrips(s, t);

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
    this.effects = { ghost: true, bleed: false, jitter: false, fade: false };
    this.mode = 'marker';
    this.playing = false;
    this.time = 0;
    this.listeners = {};
    this.load(tag);

    this.onResize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentNode || canvas);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
    }
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

  // Swap the tag. Mode, effects and layers stay as they were.
  load(tag) {
    this.tag = prepare(tag, this.opts);
    this.time = 0;
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

      // Hold on the finished tag before starting over.
      if (this.time >= this.tag.duration + this.opts.loopDelay / 1000) {
        if (this.opts.loop) this.time = 0;
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
    this.playing = false;
    if (this.raf) globalThis.cancelAnimationFrame(this.raf);
    this.emit('state', { playing: false });
    return this;
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = clamp(t, 0, this.tag.duration);
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
    if (this.observer) this.observer.disconnect();
    else if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
  }
}
