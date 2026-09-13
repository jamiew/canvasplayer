/*
 * gml-player.js: Graffiti Markup Language playback on a 2D canvas.
 *
 * paint() draws a prepared tag on a canvas, OffscreenCanvas or Node 2D context.
 * GmlPlayer adds a clock, resizing and events to a <canvas>.
 * No dependencies.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

import { DEFAULTS as PREPARE, prepare, progress, noise, clamp, lerp } from './gml.js';

export { parse, prepare } from './gml.js';

// Diagnostic overlays, each independently switchable.
export const LAYERS = ['ink', 'drips', 'vectors', 'points', 'bounds', 'graph'];

// Ink modes. Select one at a time.
export const MODES = ['marker', 'chisel', 'outline', 'dyna', 'hairline', 'skeleton'];

// Effects combine with any ink mode.
export const EFFECTS = ['ghost', 'smooth', 'bleed', 'jitter', 'fade'];

// Control help stays with the renderer that defines each option.
export const ABOUT = {
  marker: 'A ribbon through the samples, wider where the hand slowed.',
  chisel: 'A fixed-angle flat nib. Direction sets width, not speed.',
  outline: 'The silhouette, as a writer blocks out a piece.',
  dyna: "A brush with mass towed on a spring. Haeberli's DynaDraw, 1989.",
  hairline: 'The centerline at a fixed thickness.',
  skeleton: 'A centerline diagram with sample ticks.',

  ghost: 'A faint preview of the whole tag underneath.',
  smooth: 'Curve marker and outline through samples instead of joining them with straight lines.',
  bleed: 'Ink spreads outward to soften the edge.',
  jitter: 'Noise nudges samples the same way on every repaint.',
  fade: 'Old ink dims into a tail behind the drawing head.',

  ink: 'The strokes.',
  drips: 'Ink runs from the heaviest parts of the line.',
  vectors: 'An arrow per sample for direction and speed.',
  points: 'Captured samples with numbered strokes.',
  bounds: 'The capture screen, grid and tag bounds.',
  graph: 'Speed across the tag, with a playhead.'
};

export const DEFAULTS = {
  ...PREPARE,

  // Narrowing from pool to head, then as the run stretches.
  // Keep some neck width so the head does not look like a pin.
  dripTaper: 0.55,
  dripStretch: 0.3,
  // A head wider than its neck, not a separate bead.
  dripHead: 1.45,
  // Sideways drift as a fraction of the fall. Runs must still fall downward.
  dripDrift: 0.12,

  hairline: 1.5,

  jitter: 0.9,
  fadeWindow: 1.6,
  ghostAlpha: 0.14,

  // A flat nib held at a fixed angle. Width comes from direction, not speed.
  nib: 0.05,
  nibAngle: -Math.PI / 4,
  // Subdivisions per captured segment when the smooth effect is enabled.
  smoothSteps: 4,

  /*
   * A spring pulls a brush with mass along the captured path.
   * Draw the brush's path, not the hand's. It lags and coasts through corners.
   * Based on Paul Haeberli's DynaDraw, 1989.
   */
  dynaMass: 1,
  dynaSpring: 0.42,
  dynaDrag: 0.55,
  // How hard the brush's own speed thins the line. DynaDraw called it ductus.
  dynaDuctus: 1.7,

  // Breathing room around the drawing, as a fraction of the frame.
  pad: 0.08,

  color: '#ffffff',
  background: '#000000',

  loop: true,
  loopDelay: 1400,
  speed: 1
};

const TAU = Math.PI * 2;

// Widening passes under the stroke soften its edge. [width multiplier, alpha].
const BLEED = [[3.2, 0.13], [2.2, 0.18], [1.5, 0.26]];

const DRIP_STEPS = 7;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/*
 * Jitter offsets must match between a run and its source sample,
 * or the run detaches from the stroke.
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
 * Fit the tag's bounds to a w by h frame, not the full 0..1 capture space.
 * This lets a tag drawn in one corner fill the frame.
 *
 * Both axes share a normalization edge, so use one scale.
 * Reapplying the screen's 3:2 ratio squashed landscape captures.
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
 * Screen-space [x, y, width] triples for a stroke slice. `to` is exclusive.
 * Interpolate the leading edge for smooth playback between samples.
 * `spread` widens the slice for bleed passes.
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

function catmullTangent(a, b, c, d, t) {
  return 0.5 * ((c - a) + 2 * (2 * a - 5 * b + 4 * c - d) * t +
    3 * (3 * b - a - 3 * c + d) * t * t);
}

function ribbonPoint(x, y, width, dx, dy) {
  const length = Math.hypot(dx, dy);
  const r = width / 2;
  return [x, y, width, length ? -dy / length * r : 0, length ? dx / length * r : r];
}

/*
 * Tag 100 has only five corners per stroke. Smoothing its growing prefix
 * treated the moving tip as a new control point, bending ink already down.
 * Read the recorded neighbors instead, then reveal a fixed curve up to
 * the playhead. Normals also use those neighbors, not the moving endpoint.
 * The same rule keeps straight ribbon joins still while the next side grows.
 */
function ribbonPath(s, stroke, si, from, to, partial, spread) {
  const start = Math.max(0, from - 1);
  const controls = path(s, stroke, si, start, Math.min(stroke.points.length, to + 2), 0, spread);
  if (from >= to) return [];
  const first = controls[from - start];
  first.push(...normal(controls, from - start));
  const out = [first];
  const curved = s.effects.smooth && stroke.points.length > 2;
  const steps = curved ? Math.max(1, Math.floor(s.opts.smoothSteps)) : 1;
  const end = to < stroke.points.length && partial > 0 ? to : to - 1;

  for (let i = from; i < end; i++) {
    const a = controls[Math.max(0, i - start - 1)];
    const b = controls[i - start];
    const c = controls[i - start + 1];
    const d = controls[Math.min(controls.length - 1, i - start + 2)];
    const stop = i === to - 1 ? partial : 1;
    for (let k = 1; k <= steps; k++) {
      const t = Math.min(k / steps, stop);
      if (curved) {
        out.push(ribbonPoint(
          catmull(a[0], b[0], c[0], d[0], t),
          catmull(a[1], b[1], c[1], d[1], t),
          lerp(b[2], c[2], t),
          catmullTangent(a[0], b[0], c[0], d[0], t),
          catmullTangent(a[1], b[1], c[1], d[1], t)
        ));
      } else if (t === 1) {
        c.push(...normal(controls, i - start + 1));
        out.push(c);
      } else {
        out.push(ribbonPoint(lerp(b[0], c[0], t), lerp(b[1], c[1], t),
          lerp(b[2], c[2], t), c[0] - b[0], c[1] - b[1]));
      }
      if (t === stop) break;
    }
  }
  return out;
}

// The normal at sample i, scaled to half the width there.
function normal(path, i) {
  if (path[i].length > 3) return [path[i][3], path[i][4]];
  // A stationary nib has no tangent; use a vertical width tick.
  if (path.length === 1) return [0, path[0][2] / 2];
  const prev = path[Math.max(i - 1, 0)];
  const next = path[Math.min(i + 1, path.length - 1)];
  const tx = next[0] - prev[0];
  const ty = next[1] - prev[1];
  const len = Math.hypot(tx, ty) || 1;
  const r = path[i][2] / 2;
  return [(-ty / len) * r, (tx / len) * r];
}

/*
 * Trace both sides of the centerline, offset by half the width.
 * Per-segment lineWidth cannot produce this taper.
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

  // Outline needs no cap discs: they would ring each stroke end with a circle.
  if (outline) {
    ctx.stroke();
    return;
  }
  ctx.fill();

  // Use discs for caps. Spliced arcs can sweep the long way around at a
  // stroke's end, leaving notches.
  [path[0], path[path.length - 1]].forEach(end => {
    ctx.beginPath();
    ctx.arc(end[0], end[1], end[2] / 2, 0, TAU);
    ctx.fill();
  });
}

function polyline(ctx, path, width) {
  if (!path.length) return;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (path.length === 1) {
    ctx.arc(path[0][0], path[0][1], width / 2, 0, TAU);
    ctx.fill();
    return;
  }
  ctx.moveTo(path[0][0], path[0][1]);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
  ctx.stroke();
}

/*
 * Sweep a fixed-angle flat nib. Lines are wide across it and thin along it.
 * Speed does not affect width.
 */
function chisel(s, path, spread) {
  const { ctx, opts, view } = s;
  const half = opts.nib * view.unit * spread / 2;
  const nx = Math.cos(opts.nibAngle) * half;
  const ny = Math.sin(opts.nibAngle) * half;

  if (path.length === 1) {
    // A tap leaves the angled nib's footprint, not a zero-area ribbon.
    ctx.lineWidth = Math.max(opts.hairline * spread, 0.5);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(path[0][0] - nx, path[0][1] - ny);
    ctx.lineTo(path[0][0] + nx, path[0][1] + ny);
    ctx.stroke();
    return;
  }

  /*
   * Fill all segment quads once with matching winding.
   * Separate fills leave seams where antialiased edges meet.
   * An out-and-back outline reverses winding at self-crossings,
   * canceling ink under the nonzero rule and leaving holes.
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
 * DynaDraw's spring and drag pull a brush with mass toward each sample.
 * The brush cuts corners and coasts past fast stroke ends.
 * Its own speed determines width, not the hand's.
 *
 * Filter the recorded trajectory once, then reveal it. Feeding the moving
 * tip back through smoothing and the spring would move ink already down.
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

// Like the ghost layer, retain geometry per context until its inputs change.
// Fade slices share this trajectory instead of restarting the spring at
// each slice boundary. The fixed normals keep earlier ribbon edges still.
const dynaPaths = new WeakMap();

function dynaPath(s, stroke, si, spread) {
  if (!s.dyna) {
    const o = s.opts;
    const key = [s.view.w, s.view.h, o.pad, jitterAmount(s),
      o.dynaMass, o.dynaSpring, o.dynaDrag, o.dynaDuctus].join('|');
    let cache = dynaPaths.get(s.ctx);
    if (!cache || cache.tag !== s.tag || cache.key !== key) {
      cache = { tag: s.tag, key, strokes: new Map() };
      dynaPaths.set(s.ctx, cache);
    }
    s.dyna = cache.strokes;
  }
  let passes = s.dyna.get(stroke);
  if (!passes) s.dyna.set(stroke, passes = new Map());
  if (!passes.has(spread)) {
    const recorded = path(s, stroke, si, 0, stroke.points.length, 0, spread);
    const filtered = dyna(s, smooth(recorded, 2));
    for (let i = 0; i < filtered.length; i++) filtered[i].push(...normal(filtered, i));
    passes.set(spread, filtered);
  }
  return passes.get(spread);
}

function drawStroke(s, stroke, si, from, to, partial, spread) {
  if (s.mode === 'dyna') return drawDyna(s, stroke, si, from, to, partial, spread);

  const p = s.mode === 'chisel' || s.mode === 'hairline' || s.mode === 'skeleton'
    ? path(s, stroke, si, from, to, partial, spread)
    : ribbonPath(s, stroke, si, from, to, partial, spread);
  if (!p.length) return;

  switch (s.mode) {
    case 'chisel': return chisel(s, p, spread);
    case 'outline':
      s.ctx.lineWidth = Math.max(s.opts.hairline * spread, 0.5);
      s.ctx.lineJoin = 'round';
      return ribbon(s.ctx, p, true);
    case 'hairline': return polyline(s.ctx, p, s.opts.hairline * spread);
    case 'skeleton': return skeleton(s.ctx, p, spread);
    default: return ribbon(s.ctx, p);
  }
}

function drawDyna(s, stroke, si, from, to, partial, spread) {
  if (from >= to) return;
  const filtered = dynaPath(s, stroke, si, spread);
  // smooth() leaves one- and two-sample strokes alone.
  const steps = stroke.points.length > 2 ? 2 : 1;
  const end = Math.min(filtered.length - 1, (to - 1 + partial) * steps);
  const last = Math.floor(end);
  const visible = filtered.slice(from * steps, last + 1);
  if (end > last) {
    const a = filtered[last];
    const b = filtered[last + 1];
    visible.push(a.map((value, i) => lerp(value, b[i], end - last)));
  }
  return ribbon(s.ctx, visible);
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

    // Bleed passes sit under the stroke.
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
 * Draw each ink run as one shape. Its neck narrows as it stretches.
 * Keep the neck open and join it to a wider, rounded head.
 * A point with a disc at its tip made runs look like pins.
 *
 * Apply fade, jitter and bleed to runs as well as strokes.
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
    // Scale drift to the fall. Frame-sized drift sent short runs sideways.
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
      // Arrowheads show the hand's direction.
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

  const px = 8 + (clamp(t, 0, tag.duration) / tag.duration) * (view.w - 16);
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
 * Draw the ghost solid on a separate layer, then apply ghostAlpha once.
 * Direct translucent fills stacked alpha at crossings and cap discs,
 * making those spots twice as bright.
 *
 * Cache one layer per context at the frame's pixel density.
 * Without a canvas factory, such as in Node, paint() draws the ghost directly.
 */
const ghosts = new WeakMap();

/*
 * Cache inputs other than tag and layer size, which we check separately.
 * Avoid unnecessary redraws: the ghost costs more than the rest of the frame.
 */
function ghostKey(s) {
  const o = s.opts;
  return [
    s.mode, s.effects.bleed ? 1 : 0, s.effects.jitter ? 1 : 0, s.effects.smooth ? 1 : 0,
    o.color, o.pad, o.smoothSteps, o.hairline, o.nib, o.nibAngle, o.jitter,
    o.dynaMass, o.dynaSpring, o.dynaDrag, o.dynaDuctus
  ].join('|');
}

// Return the layer and drawing context, or a null context if the cache is valid.
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
 *   effects  { ghost, smooth, bleed, jitter, fade }, each true or false
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
  // A translucent background cannot erase ink from the previous frame.
  ctx.clearRect(0, 0, frame.w, frame.h);
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, frame.w, frame.h);

  if (layers.bounds) drawBounds(s);

  const prog = progress(tag.strokes, t);

  // The ghost previews the whole tag at its end time. Do not apply fade:
  // it would erase all but the last second and leave the preview in pieces.
  if (layers.ink && effects.ghost) {
    const whole = () => tag.strokes.map(st => ({ count: st.points.length, partial: 0 }));
    const layer = ghostLayer(ctx, frame.w, frame.h, ghostKey(s), tag);
    if (layer) {
      // Reuse the unchanged preview instead of redrawing it every frame.
      if (layer.ctx) drawInk({ ...s, ctx: layer.ctx }, tag.duration, whole(), false);
      ctx.globalAlpha = opts.ghostAlpha;
      ctx.drawImage(layer.canvas, 0, 0, frame.w, frame.h);
    } else {
      ctx.globalAlpha = opts.ghostAlpha;
      drawInk(s, tag.duration, whole(), false);
    }
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
 * Play a tag from its recorded timestamps.
 *
 * Size the canvas's parent to set its dimensions.
 * Pass a parsed tag now or call load() later.
 * Events: 'load' with the prepared tag, 'frame' with { time, duration },
 * 'state' with { playing }, 'config' without a payload.
 */
export class GmlPlayer {
  constructor(canvas, tag, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { ...DEFAULTS, ...options };
    this.layers = { ink: true, drips: true, vectors: false, points: false, bounds: false, graph: false };
    this.effects = { ghost: true, smooth: false, bleed: false, jitter: false, fade: false };
    this.mode = 'marker';
    // The UI reads capabilities here so it can also support other renderers.
    this.capabilities = { modes: MODES, effects: EFFECTS, layers: LAYERS, about: ABOUT };
    this.playing = false;
    this.time = 0;
    this.listeners = {};
    this.load(tag);

    this.onResize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize);
      this.observer.observe(canvas.parentNode || canvas);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onResize);
      this.onDensity = () => {
        if (this.densityQuery) this.densityQuery.removeEventListener('change', this.onDensity);
        // A resolution query only reports leaving its density. Rearm it to
        // catch the next move between screens, even at a fixed host size.
        if (typeof window.matchMedia === 'function') {
          this.densityQuery = window.matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
          this.densityQuery.addEventListener('change', this.onDensity);
        }
        this.resize();
      };
      this.onDensity();
    } else this.resize();
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

  // Swap the tag. Mode, effects and layers stay as they were.
  load(tag) {
    this.tag = prepare(tag, this.opts);
    this.time = 0;
    this.ended = false;
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
    // Pausing during the end hold still resumes that hold. Only a completed
    // run (or an explicit seek to the end) starts a fresh playthrough.
    if (this.ended) {
      this.time = 0;
      this.ended = false;
    }
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
        if (this.opts.loop) { this.time = 0; this.ended = false; }
        else {
          this.time = this.tag.duration;
          this.ended = true;
          this.pause();
          this.render();
          return;
        }
      }
      this.render();
      this.raf = globalThis.requestAnimationFrame(step);
    };
    this.raf = globalThis.requestAnimationFrame(step);
    this.emit('state', { playing: true });
    return this;
  }

  pause() {
    // Scrubbing calls pause() on every input. Ignore repeats to avoid stale
    // frame cancellations and duplicate state events.
    if (!this.playing) return this;
    this.playing = false;
    if (this.raf) globalThis.cancelAnimationFrame(this.raf);
    this.emit('state', { playing: false });
    return this;
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = clamp(t, 0, this.tag.duration);
    this.ended = this.time === this.tag.duration;
    return this.render();
  }

  setLayer(name, on) {
    if (!LAYERS.includes(name) || this.layers[name] === !!on) return this;
    this.layers[name] = !!on;
    this.emit('config');
    return this.render();
  }

  setEffect(name, on) {
    if (!EFFECTS.includes(name) || this.effects[name] === !!on) return this;
    this.effects[name] = !!on;
    this.emit('config');
    return this.render();
  }

  setMode(name) {
    if (!MODES.includes(name) || this.mode === name) return this;
    this.mode = name;
    this.emit('config');
    return this.render();
  }

  setSpeed(rate) {
    if (this.opts.speed === rate) return this;
    this.opts.speed = rate;
    this.emit('config');
    return this;
  }

  destroy() {
    this.pause();
    if (this.observer) this.observer.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
    if (this.densityQuery) this.densityQuery.removeEventListener('change', this.onDensity);
    ghosts.delete(this.ctx);
    this.listeners = {};
  }
}
