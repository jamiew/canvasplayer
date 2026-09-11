/*
 * gml.js: parse and prepare Graffiti Markup Language.
 *
 * No DOM, canvas or globals. parse() converts #000000book JSON to strokes
 * of [x, y, time]. prepare() repairs timing, measures speed and width, and
 * plans drips for any renderer.
 *
 * Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.
 * No rights reserved.
 */

export const DEFAULTS = {
  // Widths as fractions of the artwork's on-screen size. Slower means wider.
  maxWidth: 0.052,
  minWidth: 0.014,
  // Fraction of this tag's peak speed that draws the thinnest line.
  speedBias: 0.55,
  // Higher smooths out capture jitter.
  smoothing: 0.72,

  // Samples per run, capped per stroke. planDrips() ranks by relative speed.
  dripEvery: 18,
  dripRuns: 14,
  // Samples between runs, so a slow passage makes one rather than a row.
  dripGap: 7,
  // Pressure's contribution to run size, and variation between runs.
  dripPressure: 1.5,
  dripVary: 0.5
};

// Pause limits and replacement lengths, in seconds. Samples arrive 10-40ms
// apart, so gaps this long indicate a stall, not hand movement.
const MAX_STROKE_GAP = 2.5;
const MAX_STROKE_GAP_FILL = 0.4;
const MAX_PAUSE = 1.2;
const MAX_PAUSE_FILL = 0.4;

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Stable pseudo-random values in [0,1) keep jitter and drips identical on repaint.
export function noise(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* --- parse ------------------------------------------------------------- */

// XML-to-JSON conversion turns a lone <stroke> or <pt> into a bare object.
function list(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// #000000book wraps the single <tag> in an array.
function first(value) { return Array.isArray(value) ? (value[0] || {}) : (value || {}); }

function num(value) {
  const n = parseFloat(value);
  return isFinite(n) ? n : null;
}

/*
 * Detect the capture's orientation.
 *
 * <environment><up> along +x means sideways. Capture apps decide whether
 * <up> exists, not tag numbers. Fat Tag - Katsu Edition and Graffiti Analysis
 * 2.0 write it. Graffiti Analysis 1.0 does not, even for #1399.
 * Tag #147 has an empty <environment>.
 *
 * Without <up>, use geometry. Both axes share a normalization edge,
 * so y can exceed 1 only in a sideways capture.
 *
 * Do not use the client name. Graffiti Analysis 1.0 put tag names there:
 * #161 is "katsu-4", #158 is "jesus-saves" and #1399 is "seen".
 * Matching /Katsu/ wrongly rotated #161.
 */
export function isLandscape(environment, strokes) {
  const up = (environment && environment.up) || {};
  const x = num(up.x);
  const y = num(up.y);

  if (x !== null && y !== null && (x || y)) return Math.abs(x) > Math.abs(y);

  return (strokes || []).some(stroke => stroke.points.some(p => p[1] > 1));
}

/*
 * Flatten #000000book JSON into { id, app, rotate, strokes }.
 * Each stroke holds [x, y, time] points. Leave timing repairs to prepare().
 */
export function parse(gml, id) {
  const tag = first(gml && (gml.tag || gml.GML));

  // Every <drawing>, not just the first: tag 100 ships five of them.
  const strokes = list(tag.drawing)
    .flatMap(drawing => list(drawing && drawing.stroke))
    .map(stroke => {
      const points = list(stroke && stroke.pt).map(pt => {
        const x = num(pt && pt.x);
        const y = num(pt && pt.y);
        if (x === null || y === null) return null;
        return [x, y, num(pt.time) || 0];
      }).filter(Boolean);
      return points.length ? { points } : null;
    })
    .filter(Boolean);

  return {
    id,
    app: first(first(tag.header).client).name || null,
    rotate: isLandscape(first(tag.environment), strokes),
    strokes
  };
}

/* --- prepare ----------------------------------------------------------- */

/*
 * Repair zeros, Unix timestamps, long gaps and out-of-order points.
 * Record repairs for debug views.
 */
function repairTiming(strokes) {
  const report = { synthesized: false, reordered: 0, gapsClosed: 0, origin: 0 };
  const flat = strokes.flatMap(s => s.points);
  if (!flat.length) return report;

  const times = flat.map(p => p[2]);
  const start = times[0];
  // A loop, not Math.max(...times): a long capture is tens of thousands of
  // points, and spreading that many arguments overflows the stack.
  let lo = times[0], hi = times[0];
  for (const t of times) { if (t < lo) lo = t; if (t > hi) hi = t; }
  let span = hi - lo;

  // Some apps wrote wall-clock time, not an offset. Tell seconds from
  // milliseconds by magnitude: a short tag has a small span either way.
  if (start > 1e6) {
    report.origin = start;
    const ms = start > 1e11;
    flat.forEach(p => {
      p[2] -= start;
      if (ms) p[2] /= 1000;
    });
    span = ms ? span / 1000 : span;
  }

  // No usable timing. Record the fallback to 60Hz.
  if (span <= 0) {
    report.synthesized = true;
    flat.forEach((p, i) => { p[2] = i / 60; });
    return report;
  }

  // Rebuild from raw gaps. Closing a gap shifts the repaired clock, so
  // comparisons must use the previous raw time, not the repaired time.
  // Keep gesture timing within strokes and shorten long pauses between them.
  let clock = 0;
  let prevEnd = null;
  strokes.forEach(stroke => {
    const pts = stroke.points;
    if (prevEnd !== null) {
      let pause = pts[0][2] - prevEnd;
      if (pause < 0) { pause = MAX_PAUSE_FILL; report.reordered++; }
      if (pause > MAX_PAUSE) { pause = MAX_PAUSE_FILL; report.gapsClosed++; }
      clock += pause;
    }
    let raw = pts[0][2];
    prevEnd = pts[pts.length - 1][2];
    for (let i = 0; i < pts.length; i++) {
      let dt = pts[i][2] - raw;
      raw = pts[i][2];
      if (i === 0) { pts[i][2] = clock; continue; }
      if (dt < 0) { dt = 0; report.reordered++; }
      if (dt > MAX_STROKE_GAP) { dt = MAX_STROKE_GAP_FILL; report.gapsClosed++; }
      clock += dt;
      pts[i][2] = clock;
    }
  });
  return report;
}

/*
 * Compute speed and width once per point. Scale width against the tag's
 * own speed range, since hand speed varies between tags.
 */
function measure(strokes, opts) {
  let peak = 0;

  strokes.forEach(stroke => {
    const pts = stroke.points;
    let smoothed = 0;
    stroke.speed = new Array(pts.length);
    for (let j = 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[j - 1][0];
      const dy = pts[j][1] - pts[j - 1][1];
      const dt = Math.max(pts[j][2] - pts[j - 1][2], 1 / 240);
      // Both axes belong here. The old player called sqrt with two
      // arguments, so vertical strokes measured as motionless.
      const speed = Math.sqrt(dx * dx + dy * dy) / dt;
      smoothed = j === 1 ? speed : lerp(speed, smoothed, opts.smoothing);
      stroke.speed[j] = smoothed;
      if (smoothed > peak) peak = smoothed;
    }
    // The first sample has nothing to measure against. Reading it as a dead
    // stop opened every stroke with a blob, so it inherits the next speed.
    stroke.speed[0] = stroke.speed.length > 1 ? stroke.speed[1] : 0;
  });

  // Most of a stroke sits under the peak, so mapping against the peak alone
  // leaves everything full width. Bias to the busy part.
  const ceiling = Math.max(peak * opts.speedBias, 1e-4);
  strokes.forEach(stroke => {
    stroke.width = stroke.speed.map(speed => {
      const t = clamp(speed / ceiling, 0, 1);
      return lerp(opts.maxWidth, opts.minWidth, Math.pow(t, 0.7));
    });
  });
  return peak;
}

function bounds(strokes) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  strokes.forEach(s => {
    s.points.forEach(p => {
      if (p[0] < b.x0) b.x0 = p[0];
      if (p[1] < b.y0) b.y0 = p[1];
      if (p[0] > b.x1) b.x1 = p[0];
      if (p[1] > b.y1) b.y1 = p[1];
    });
  });
  if (!isFinite(b.x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  // Guard against a perfectly straight line collapsing an axis to zero.
  if (b.x1 - b.x0 < 1e-4) { b.x0 -= 0.05; b.x1 += 0.05; }
  if (b.y1 - b.y0 < 1e-4) { b.y0 -= 0.05; b.y1 += 0.05; }
  return b;
}

/*
 * Plan deterministic drips once. The painter reveals each run at its born time.
 *
 * Choose each stroke's slowest samples, spaced apart, with a count based on
 * stroke length. A raw speed threshold gave fast tags no drips and slow
 * tags a drip at every sample.
 */
function planDrips(strokes, peakSpeed, opts) {
  const heavy = (opts.maxWidth + opts.minWidth) / 2;
  const gap = Math.max(1, Math.round(opts.dripGap));
  const drips = [];

  strokes.forEach((stroke, si) => {
    const pts = stroke.points;
    const want = clamp(Math.round(pts.length / opts.dripEvery), 1, opts.dripRuns);
    const order = [];
    for (let i = 1; i < pts.length; i++) order.push(i);
    order.sort((a, b) => stroke.speed[a] - stroke.speed[b]);

    const chosen = [];
    for (let k = 0; k < order.length && chosen.length < want; k++) {
      const at = order[k];
      if (chosen.every(c => Math.abs(c - at) >= gap)) chosen.push(at);
    }

    // A stroke lifted while still laying down a heavy line always runs. A
    // lone point has no dwell to measure, so it never does.
    const last = pts.length - 1;
    if (last > 0 && stroke.width[last] > heavy && !chosen.includes(last)) chosen.push(last);

    chosen.sort((a, b) => a - b).forEach(i => {
      // Slower movement leaves more ink. The exponent emphasizes slow points.
      const slow = 1 - clamp(stroke.speed[i] / peakSpeed, 0, 1);
      const pressure = Math.pow(slow, opts.dripPressure);

      // The same pool determines width and length: more ink runs farther.
      const dwell = pts[i][2] - pts[i - 1][2];
      const pool = pressure * (1 + dwell * 4);
      const vary = 1 + (noise(si * 17 + i, 5) - 0.5) * 2 * opts.dripVary;

      drips.push({
        si,
        i,
        x: pts[i][0],
        y: pts[i][1],
        width: stroke.width[i] * (0.22 + pool * 0.3) * vary,
        length: clamp((0.006 + pool * 0.085) * vary, 0.005, 0.11),
        born: pts[i][2],
        // Runs wander rather than falling dead straight.
        drift: (noise(si * 31 + i, 3) - 0.5) * 2,
        // Seconds to reach full length. Stagger by index to avoid synchronized falls.
        fall: 2.6 + (i % 7) * 0.45
      });
    });
  });

  return drips;
}

/*
 * Everything the painter needs, computed once from a parsed tag:
 *
 *   strokes     each with points [x, y, t], speed[] and width[] per sample
 *   bounds      what the tag occupies, in capture space
 *   duration    seconds, after repair
 *   peakSpeed   fastest smoothed sample, in capture units per second
 *   pointCount  samples in total
 *   timing      what the repair changed: { synthesized, reordered, gapsClosed, origin }
 *   drips       where ink will run, each with a `born` time
 *
 * Leave the input untouched. Rotate landscape captures a quarter turn.
 */
export function prepare(tag, options) {
  const opts = { ...DEFAULTS, ...options };
  // Drop empty strokes here to keep them out of downstream code.
  // parse() never creates them, but callers can pass hand-built tags.
  const strokes = ((tag && tag.strokes) || [])
    .map(s => ({ points: ((s && s.points) || []).map(p => [p[0], p[1], p[2]]) }))
    .filter(s => s.points.length);

  // Quarter turn for landscape captures: (x, y) -> (y, 1 - x).
  if (tag && tag.rotate) {
    strokes.forEach(s => s.points.forEach(p => {
      const x = p[0];
      p[0] = p[1];
      p[1] = 1 - x;
    }));
  }

  const timing = repairTiming(strokes);
  const peakSpeed = measure(strokes, opts) || 1;
  const pointCount = strokes.reduce((n, s) => n + s.points.length, 0);

  const last = strokes[strokes.length - 1];
  let duration = last ? last.points[last.points.length - 1][2] : 0;
  // A tag with no usable duration still needs a timeline to scrub.
  if (!(duration > 0)) duration = Math.max(pointCount / 60, 0.5);

  return {
    id: (tag && tag.id) || null,
    app: (tag && tag.app) || null,
    rotate: !!(tag && tag.rotate),
    strokes,
    bounds: bounds(strokes),
    duration,
    peakSpeed,
    pointCount,
    timing,
    drips: planDrips(strokes, peakSpeed, opts)
  };
}

/* How far through each stroke playback has reached, at time t. */
export function progress(strokes, t) {
  return strokes.map(stroke => {
    const pts = stroke.points;
    if (t < pts[0][2]) return { count: 0, partial: 0 };
    if (t >= pts[pts.length - 1][2]) return { count: pts.length, partial: 0 };
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid][2] <= t) lo = mid; else hi = mid - 1;
    }
    const span = pts[lo + 1][2] - pts[lo][2];
    return { count: lo + 1, partial: span > 0 ? (t - pts[lo][2]) / span : 0 };
  });
}
